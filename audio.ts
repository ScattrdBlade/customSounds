/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { wordsFromSnake, wordsToTitle } from "@utils/text";
import { findByCodeLazy, findByPropsLazy, findStoreLazy, mapMangledModuleLazy } from "@webpack";
import { MediaEngineStore } from "@webpack/common";

import { addFile, blobHash, getFile, hasAudio, MAX_FILE_BYTES, StoredFile } from "./files";
import { DEFAULT_VOLUME, soundTypes } from "./types";

export const logger = new Logger("CustomSounds");

const WebAudioSound = findByCodeLazy("could not play audio:");
const soundModule = findByPropsLazy("WebAudioSound");
const SoundpackStore = findStoreLazy("SoundpackStore");
const Soundpacks = mapMangledModuleLazy('message1:"bit_message1"', {
    getPackSounds: m => typeof m === "function"
});
const SoundpackIds = mapMangledModuleLazy('CLASSIC="classic"', {
    Soundpack: m => typeof m?.CLASSIC === "string"
});

export interface PreviewHandle {
    stop(): void;
    setVolume(pct: number): void;
}

export interface AudioPlayer {
    name: string;
    _volume: number;
    _audio: Promise<HTMLAudioElement> | null;
    outputChannel: string;
    volume: number;
    play(): void;
    stop(): void;
    ensureAudio(): Promise<HTMLAudioElement>;
    __csPatched?: boolean;
    __csOriginalName?: string;
    __csPreviewVolume?: number;
    __csPreviewBase?: number;
    __csDefaultSrc?: string;
}

export const isUrl = (s: unknown) => typeof s === "string" && /^(?:https?:|blob:)/.test(s);

const toElementVolume = (pct: number) => Math.min(1, Math.max(0, pct / 100));

export const seasonalUrls = new Map(soundTypes.flatMap(t => Object.entries(t.seasonal ?? {})));

export type PatchHealth = "ok" | "no-volume" | "no-init" | "reverted" | "init-throws";

const hasVolumeHook = (fn: unknown) => typeof fn === "function" && String(fn).includes("modifyVolume");

export function probePatched(): PatchHealth | null {
    let proto: any;
    try {
        proto = WebAudioSound.prototype;
        if (!proto) return null;
    } catch {
        return null;
    }

    let initHooked: boolean;
    try {
        const p: AudioPlayer = new WebAudioSound("message1", "message1", 0, "default");
        initHooked = !!p.__csPatched;
    } catch {
        return "init-throws";
    }

    let volumeHooked = false;
    try {
        // A later Discord build may move the volume code out of ensureAudio
        volumeHooked = hasVolumeHook(proto.ensureAudio) || Object.getOwnPropertyNames(proto).some(k => {
            if (k === "constructor") return false;
            const d = Object.getOwnPropertyDescriptor(proto, k);
            return [d?.value, d?.get, d?.set].some(hasVolumeHook);
        });
    } catch (e) {
        logger.error("Failed to check for the volume patch:", e);
    }

    if (initHooked) return volumeHooked ? "ok" : "no-volume";
    return volumeHooked ? "no-init" : "reverted";
}

// These are never closed, closing one would silence every sound routed through it
const audioCtxs = new Map<string, AudioContext>();

interface BoostNodes {
    source: MediaElementAudioSourceNode;
    gain: GainNode;
    limiter: DynamicsCompressorNode;
    ctx: AudioContext;
}
const boostNodes = new WeakMap<HTMLAudioElement, BoostNodes>();
let warnedResumeFailure = false;

function getAudioCtx(sinkId: string): AudioContext | null {
    let ctx = audioCtxs.get(sinkId);
    if (!ctx) {
        try {
            ctx = new AudioContext();
        } catch (e) {
            logger.error("Failed to create AudioContext:", e);
            return null;
        }
        audioCtxs.set(sinkId, ctx);
        if (sinkId !== "default" && "setSinkId" in ctx)
            (ctx as any).setSinkId(sinkId).catch((e: unknown) => logger.warn(`Failed to set the boost output device to ${sinkId}:`, e));
    }
    return ctx;
}

export function applyBoost(audio: HTMLAudioElement, volume: number, sinkId: string) {
    const factor = Math.max(1, volume);
    let nodes = boostNodes.get(audio);
    if (!nodes) {
        // Routing an element through an AudioContext can't be undone, so only do it when actually boosting
        if (factor <= 1.001) return;
        const ctx = getAudioCtx(sinkId);
        if (!ctx) return;
        try {
            const source = ctx.createMediaElementSource(audio);
            const gain = ctx.createGain();
            // Limiter to stop boosted sounds from clipping. Chromium adds makeup gain, so keep the threshold close to 0
            const limiter = ctx.createDynamicsCompressor();
            limiter.threshold.value = -1;
            limiter.knee.value = 0;
            limiter.ratio.value = 20;
            limiter.attack.value = 0.001;
            limiter.release.value = 0.1;
            source.connect(gain);
            gain.connect(limiter);
            limiter.connect(ctx.destination);
            nodes = { source, gain, limiter, ctx };
            boostNodes.set(audio, nodes);
        } catch (e) {
            logger.error("Failed to set up the volume boost:", e);
            return;
        }
    }
    if (nodes.ctx.state === "suspended") {
        nodes.ctx.resume().catch(e => {
            if (!warnedResumeFailure) {
                warnedResumeFailure = true;
                logger.warn("Failed to resume AudioContext:", e);
            }
        });
    }
    nodes.gain.gain.value = factor;
}

export function clearBoost(audio: HTMLAudioElement) {
    const nodes = boostNodes.get(audio);
    if (!nodes) return;
    for (const n of [nodes.source, nodes.gain, nodes.limiter]) n.disconnect();
    boostNodes.delete(audio);
}

export function getPlayerSinkId(player: AudioPlayer): string {
    // Discord plays anything not on the default channel through the voice output device
    if (IS_WEB || !player.outputChannel || player.outputChannel === "default") return "default";
    try {
        // Its export name is minified, but the output device id is the module's only string
        return Object.values(soundModule).find(v => typeof v === "string") || "default";
    } catch {
        return "default";
    }
}

export function effectiveVolume(volumePct: number, outputVolume: number, baseVolume: number): number {
    return Math.max(0, outputVolume / 100 * baseVolume * (volumePct / 100));
}

export function applyElementVolume(audio: HTMLAudioElement, volumePct: number, outputVolume: number, sinkId: string, baseVolume: number) {
    const effective = effectiveVolume(volumePct, outputVolume, baseVolume);
    audio.volume = Math.min(1, effective);
    applyBoost(audio, effective, sinkId);
}

export function playerBaseVolume(player: AudioPlayer): number {
    if (player.__csPreviewVolume != null) return player.__csPreviewBase ?? 1;
    const v = player._volume;
    return Number.isFinite(v) && v >= 0 ? v : 1;
}

export const lastBaseVolume = new Map<string, number>();

// Dev builds don't cache failed lazy finds, so remember it or every render would search all modules again
let soundpackLookupBroken = false;

export function getNativeSoundName(id: string): string {
    if (soundpackLookupBroken) return id;
    try {
        const mapped = Soundpacks.getPackSounds(SoundpackStore.getSoundpack())?.[id];
        return typeof mapped === "string" && mapped ? mapped : id;
    } catch (e) {
        soundpackLookupBroken = true;
        logger.warn("Failed to get the active sound pack:", e);
        return id;
    }
}

export interface Soundpack {
    key: string;
    name: string;
    sounds: [id: string, sound: string][];
}

let soundpacksBroken = false;
const packName = (key: string) => wordsToTitle(wordsFromSnake(key));

// The default pack maps every sound to itself, which is no source the plugin lists, and a pack that changes one sound is just
// that sound's source, so both are left out
export function getSoundpacks(): Soundpack[] {
    if (soundpacksBroken) return [];
    try {
        const packs = Object.entries(SoundpackIds.Soundpack as Record<string, string>).flatMap(([key, pack]) => {
            const mapped = Soundpacks.getPackSounds(pack) ?? {};
            const sounds = soundTypes.filter(t => Object.hasOwn(t.seasonal ?? {}, mapped[t.id])).map((t): [string, string] => [t.id, mapped[t.id]]);
            return sounds.length > 1 ? [{ key, name: packName(key), sounds }] : [];
        });
        if (!packs.length) throw new Error("no sound packs found");
        return packs;
    } catch (e) {
        soundpacksBroken = true;
        logger.warn("Failed to get Discord's sound packs:", e);
        return [];
    }
}

export function playSound(sound: string, opts: { volume?: number; originalName?: string; baseVolume?: number; }): PreviewHandle {
    let player: AudioPlayer;
    try {
        player = new WebAudioSound(sound, opts.originalName ?? sound, toElementVolume(opts.volume ?? DEFAULT_VOLUME), "default");
    } catch (e) {
        logger.error("Failed to create audio player:", e);
        return playFallback(sound, opts);
    }

    const patched = !!player.__csPatched;
    if (!patched && isUrl(sound)) return playFallback(sound, opts);

    if (patched) {
        player.__csPreviewVolume = Math.max(0, opts.volume ?? DEFAULT_VOLUME);
        player.__csPreviewBase = opts.baseVolume ?? 1;
    } else {
        logger.warn("Audio patch isn't applied, previewing the default sound");
    }

    try {
        player.play();
    } catch (e) {
        logger.error("Failed to play preview:", e);
    }

    return {
        stop: () => {
            try {
                player.stop();
            } catch (e) {
                logger.warn("Failed to stop preview:", e);
            }
        },
        setVolume: pct => {
            if (!patched) {
                player.volume = toElementVolume(pct);
                return;
            }
            const volume = Math.max(0, pct);
            player.__csPreviewVolume = volume;
            player._audio
                ?.then(audio => applyElementVolume(audio, volume, MediaEngineStore.getOutputVolume(), getPlayerSinkId(player), playerBaseVolume(player)))
                .catch(e => logger.warn("Failed to set preview volume:", e));
        }
    };
}

function playFallback(sound: string, opts: { volume?: number; }): PreviewHandle {
    const src = seasonalUrls.get(sound) ?? sound;
    let audio: HTMLAudioElement | null = null;
    if (isUrl(src)) {
        audio = new Audio(src);
        audio.volume = toElementVolume(opts.volume ?? DEFAULT_VOLUME);
        audio.onerror = () => logger.warn(`Failed to load preview: ${src}`);
        audio.play().catch(e => logger.warn("Failed to play preview:", e));
    } else {
        logger.warn("Audio patch isn't applied, can't preview this sound");
    }

    return {
        stop: () => {
            if (!audio) return;
            audio.pause();
            audio.currentTime = 0;
        },
        setVolume: pct => {
            if (audio) audio.volume = toElementVolume(pct);
        }
    };
}

export const ACCEPTED_AUDIO = ".mp3,.wav,.ogg,.oga,.opus,.m4a,.flac,.aac,.webm,.mp4";
const MIME_BY_EXT: Record<string, string> = {
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
    m4a: "audio/mp4", mp4: "audio/mp4", flac: "audio/flac", aac: "audio/aac", webm: "audio/webm"
};
export function mimeFor(name: string, type: unknown): string {
    // Backups store the type in a data URI, so it can't contain , or ;
    if (typeof type === "string" && /^[\w.+-]+\/[\w.+-]{1,100}$/.test(type) && type !== "application/octet-stream") return type;
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    return Object.hasOwn(MIME_BY_EXT, ext) ? MIME_BY_EXT[ext] : "audio/mpeg";
}

export interface ExportedAudioFile {
    id: string;
    name: string;
    type: string;
    dataUri: string;
}

export interface ImportFilesResult {
    remap: Map<string, string>;
    imported: number;
    skipped: number;
    ids: string[];
}

export const MAX_DATA_URI_LENGTH = Math.ceil(MAX_FILE_BYTES * 4 / 3) + 128;
export const MAX_IMPORT_TOTAL_BYTES = 300 * 1024 * 1024;
export const MAX_BACKUP_BYTES = 500 * 1024 * 1024;

export function dataUriToBytes(uri: string) {
    // Only accepts data URIs that decode the same way here as when Chromium plays them
    const m = /^data:([^,#]*),([^#]*)/i.exec(uri.replace(/(?<![\0- ])[\0- ]+$|[\t\n\r]/g, ""));
    if (!m) return null;
    const [matched, meta, data] = m;
    const base64 = /; *base64 *$/i.test(meta);
    if (/[^ -~]/.test(matched) || /; *base64 *;/i.test(meta)) return null;
    if (!base64 && data.includes(" ")) return null;

    const body = data.replace(/%([\da-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    try {
        const bin = base64 ? atob(body) : body;
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    } catch {
        return null;
    }
}

export function blobToDataUri(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
    });
}

// Non-ASCII is escaped so the backup is one byte per character
// Files that don't fit in this backup go in `rest` for the next part, files too big for any part go in `left`
export async function buildBackup(head: object, ids: Iterable<string>, old?: ReadonlyMap<string, StoredFile>) {
    const ascii = (s: string) => s.replace(/[\u007f-\uffff]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    const tail = "\n  ]\n}\n";
    const parts: BlobPart[] = [ascii(JSON.stringify(head, null, 2)).slice(0, -2) + ',\n  "files": ['];
    let total = new Blob([parts[0], tail]).size;
    let audioBytes = 0;
    let bundled = 0;
    let unbundled = 0;
    const left: string[] = [];
    const rest: string[] = [];
    const fromOld: string[] = [];

    for (const id of new Set(ids)) {
        const own = await getFile(id).catch(e => void logger.warn(`Export: failed to read file ${id}:`, e));
        const isOld = !!old?.has(id) && await blobHash(own?.blob) !== id;
        const file = isOld ? old?.get(id) : own;
        if (!hasAudio(file)) {
            unbundled++;
            continue;
        }

        const name = typeof file.name === "string" ? file.name : "Unknown";
        if (file.blob.size > MAX_FILE_BYTES) {
            left.push(name);
            continue;
        }
        if (audioBytes + file.blob.size > MAX_IMPORT_TOTAL_BYTES) {
            rest.push(id);
            continue;
        }

        const dataUri = await blobToDataUri(file.blob).catch(e => void logger.warn(`Export: failed to read "${name}":`, e));
        if (!dataUri) {
            unbundled++;
            continue;
        }

        const header = `data:${mimeFor(name, file.blob.type.slice(0, 100))};base64,`;
        const body = dataUri.slice(dataUri.lastIndexOf(",") + 1);
        if (header.length + body.length > MAX_DATA_URI_LENGTH) {
            left.push(name);
            continue;
        }

        const meta = ascii(JSON.stringify({ id, name, type: file.blob.type, dataUri: "" })).slice(0, -2);
        const part = new Blob([`${bundled ? "," : ""}\n    ${meta}${header}`, body, "\"}"]);
        if (total + part.size > MAX_BACKUP_BYTES) {
            if (bundled) rest.push(id);
            else left.push(name);
            continue;
        }

        parts.push(part);
        total += part.size;
        audioBytes += file.blob.size;
        bundled++;
        if (isOld) fromOld.push(name);
    }

    parts.push(tail);
    return { backup: new Blob(parts, { type: "application/json" }), size: total, bundled, unbundled, left, rest, fromOld };
}

export async function importAudioFiles(files: readonly Partial<ExportedAudioFile>[]): Promise<ImportFilesResult> {
    const remap = new Map<string, string>();
    const ids = new Set<string>();
    let skipped = 0;
    let totalBytes = 0;
    for (const fd of files) {
        const name = typeof fd.name === "string" && fd.name ? fd.name.slice(0, 200) : "Imported";
        const skip = (reason: string) => {
            logger.warn(`Skipping imported file "${name}": ${reason}`);
            skipped++;
        };
        if (typeof fd.dataUri !== "string" || fd.dataUri.length > MAX_DATA_URI_LENGTH) {
            skip("missing or oversized audio data");
            continue;
        }
        const bytes = dataUriToBytes(fd.dataUri);
        if (!bytes) {
            skip("audio data is not a valid data URI");
            continue;
        }
        if (!bytes.length) {
            skip("audio data is empty");
            continue;
        }
        if (bytes.length > MAX_FILE_BYTES) {
            skip("file is too large");
            continue;
        }
        if (totalBytes + bytes.length > MAX_IMPORT_TOTAL_BYTES) {
            skip("total import size is too large");
            continue;
        }
        totalBytes += bytes.length;
        const { id } = await addFile(new File([bytes], name, { type: mimeFor(name, fd.type) }));
        ids.add(id);
        if (typeof fd.id === "string" && fd.id) remap.set(fd.id, id);
    }
    return { remap, imported: ids.size, skipped, ids: [...ids] };
}
