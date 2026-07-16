/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { get, set } from "@api/DataStore";
import { findByCodeLazy, findByPropsLazy } from "@webpack";

import { soundTypes } from "./types";

const KEY = "ScattrdCustomSounds";
const WebAudioSound = findByCodeLazy("could not play audio:");
const soundModule = findByPropsLazy("WebAudioSound", "voiceSinkId");
const MediaEngineStore = findByPropsLazy("getOutputVolume", "getOutputDevices");

export interface PreviewHandle { stop(): void; volume: number; }
export interface StoredAudioFile { id: string; name: string; type: string; buffer: ArrayBuffer; dataUri: string; }
export interface ExportedAudioFile { id: string; name: string; type: string; dataUri: string; }


export interface AudioPlayer {
    name: string;
    _volume: number;
    _audio: Promise<HTMLAudioElement> | null;
    outputChannel: string;
    trackNotificationFailure: boolean;
    volume: number;
    play(): void;
    loop(): void;
    pause(): void;
    stop(): void;
    ensureAudio(): Promise<HTMLAudioElement>;
    destroyAudio(): void;
    __customSoundsPatched?: boolean;
    __csOriginalName?: string;
    __csPreviewVolume?: number;
    __csDefaultSrc?: string;
}

export const isUrl = (s: string) => typeof s === "string" && /^(?:data:|https?:|blob:)/.test(s);

export const dataUriCache = new Map<string, string>();
export const seasonalUrls: Record<string, string> = Object.fromEntries(
    soundTypes.flatMap(t => t.seasonal ? Object.entries(t.seasonal) : [])
);

export function getOutputVolume(): number {
    try {
        const v = MediaEngineStore.getOutputVolume();
        return typeof v === "number" && !isNaN(v) ? v : 100;
    } catch {
        return 100;
    }
}

export function getPlayerSinkId(player: AudioPlayer): string {
    try {
        if (IS_WEB || player.outputChannel !== "voice") return "default";
        return soundModule.voiceSinkId || "default";
    } catch {
        return "default";
    }
}

const audioCtxs = new Map<string, AudioContext>();
const boostNodes = new WeakMap<HTMLAudioElement, { source: MediaElementAudioSourceNode; gain: GainNode; }>();

function getAudioCtx(sinkId: string): AudioContext | null {
    let ctx = audioCtxs.get(sinkId);
    if (!ctx) {
        try { ctx = new AudioContext(); } catch { return null; }
        if (sinkId !== "default" && "setSinkId" in ctx) {
            (ctx as any).setSinkId(sinkId).catch(() => { });
        }
        audioCtxs.set(sinkId, ctx);
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => { });
    return ctx;
}

export function applyBoost(audio: HTMLAudioElement, volume: number, sinkId = "default") {
    const factor = Math.max(1, volume);
    if (factor <= 1.001 && !boostNodes.has(audio)) return;
    const ctx = getAudioCtx(sinkId);
    if (!ctx) return;
    let nodes = boostNodes.get(audio);
    if (!nodes) {
        try {
            const source = ctx.createMediaElementSource(audio);
            const gain = ctx.createGain();
            source.connect(gain);
            gain.connect(ctx.destination);
            nodes = { source, gain };
            boostNodes.set(audio, nodes);
        } catch (e) { console.error("[CustomSounds] Web Audio attach failed:", e); return; }
    }
    nodes.gain.gain.value = factor;
}

export function clearBoost(audio: HTMLAudioElement) {
    const nodes = boostNodes.get(audio);
    if (!nodes) return;
    try { nodes.source.disconnect(); nodes.gain.disconnect(); } catch { }
    boostNodes.delete(audio);
}

export function effectiveVolume(volumePct: number, outputVolume: number): number {
    return Math.max(0, Math.min(outputVolume, 100) / 100 * (volumePct / 100));
}

export function applyElementVolume(el: HTMLAudioElement, volumePct: number, outputVolume: number, sinkId = "default") {
    const effective = effectiveVolume(volumePct, outputVolume);
    el.volume = Math.min(1, effective);
    applyBoost(el, effective, sinkId);
}

export function playAudio(audio: string, opts: { volume?: number; } = {}): PreviewHandle {
    let p: AudioPlayer | undefined;
    try {
        p = new WebAudioSound(audio, audio, Math.min(1, Math.max(0, (opts.volume ?? 100) / 100)), "default");
    } catch (e) {
        console.error("[CustomSounds] Could not create audio player:", e);
    }

    if (p?.__customSoundsPatched) {
        const player = p;
        player.__csPreviewVolume = Math.max(0, opts.volume ?? 100);
        try { player.play(); } catch { }
        return {
            stop: () => { try { player.stop(); } catch { } },
            get volume() { return player.__csPreviewVolume ?? 100; },
            set volume(v: number) {
                player.__csPreviewVolume = Math.max(0, v);
                player._audio?.then(el => applyElementVolume(el, player.__csPreviewVolume!, getOutputVolume(), getPlayerSinkId(player))).catch(() => { });
            }
        };
    }

    if (p && !isUrl(audio)) {
        console.warn("[CustomSounds] Audio patch inactive; playing the default sound without overrides. The plugin likely needs updating for this Discord build.");
        const player = p;
        try { player.play(); } catch { }
        return {
            stop: () => { try { player.stop(); } catch { } },
            get volume() { return Math.round((player._volume ?? 1) * 100); },
            set volume(v: number) { try { player.volume = Math.min(1, Math.max(0, v / 100)); } catch { } }
        };
    }
    return playFallback(audio, opts);
}

function playFallback(audio: string, opts: { volume?: number; }): PreviewHandle {
    if (seasonalUrls[audio]) audio = seasonalUrls[audio];
    let el: HTMLAudioElement | null = null;
    if (isUrl(audio)) {
        el = new Audio(audio);
        el.volume = Math.min(1, Math.max(0, (opts.volume ?? 100) / 100));
        el.onerror = () => { };
        el.play().catch(() => { });
    } else {
        console.warn("[CustomSounds] Audio patch inactive; cannot preview this sound. The plugin likely needs updating for this Discord build.");
    }
    return {
        stop: () => { if (el) { el.pause(); el.currentTime = 0; } },
        get volume() { return el ? el.volume * 100 : (opts.volume ?? 100); },
        set volume(v: number) { if (el) el.volume = Math.min(1, Math.max(0, v / 100)); }
    };
}

async function hashBuffer(buffer: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function generateDataURI(buffer: ArrayBuffer, type: string): Promise<string> {
    const blob = new Blob([new Uint8Array(buffer)], { type: type || "audio/mpeg" });
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onloadend = () => resolve(r.result as string);
        r.onerror = reject;
        r.readAsDataURL(blob);
    });
}

function dataUriToArrayBuffer(dataUri: string): ArrayBuffer | null {
    const i = dataUri.indexOf(",");
    if (i === -1 || !dataUri.slice(0, i).includes(";base64")) return null;
    try {
        const bin = atob(dataUri.slice(i + 1));
        const bytes = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
        return bytes.buffer;
    } catch { return null; }
}

export async function getAllAudio(): Promise<Record<string, StoredAudioFile>> {
    return (await get(KEY)) ?? {};
}

export async function getAudioMeta(): Promise<Record<string, string>> {
    const meta: Record<string, string> = {};
    for (const [id, f] of Object.entries(await getAllAudio())) meta[id] = f.name;
    return meta;
}

export async function saveAudio(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    const id = await hashBuffer(buffer);
    const dataUri = await generateDataURI(buffer, file.type);
    const all = (await get(KEY)) ?? {};
    all[id] = { id, name: file.name, type: file.type, buffer, dataUri };
    await set(KEY, all);
    return id;
}

export async function deleteAudio(id: string): Promise<void> {
    const all = await getAllAudio();
    delete all[id];
    await set(KEY, all);
    dataUriCache.delete(id);
}

export async function ensureDataURICached(fileId: string): Promise<string | null> {
    if (dataUriCache.has(fileId)) return dataUriCache.get(fileId)!;
    try {
        const e = (await getAllAudio())[fileId];
        if (e?.dataUri) { dataUriCache.set(fileId, e.dataUri); return e.dataUri; }
        if (e?.buffer instanceof ArrayBuffer) {
            const dataUri = await generateDataURI(e.buffer, e.type);
            const cur = await getAllAudio();
            if (cur[fileId]) { cur[fileId].dataUri = dataUri; await set(KEY, cur); }
            dataUriCache.set(fileId, dataUri);
            return dataUri;
        }
    } catch (e) { console.error("[CustomSounds]", e); }
    return null;
}

export async function importAudio(data: ExportedAudioFile): Promise<string | null> {
    const buffer = data.dataUri ? dataUriToArrayBuffer(data.dataUri) : null;
    if (!buffer) return null;
    const id = await hashBuffer(buffer);
    const all = (await get(KEY)) ?? {};
    all[id] = { id, name: data.name || "Imported", type: data.type || "audio/mpeg", buffer, dataUri: data.dataUri };
    await set(KEY, all);
    return id;
}
