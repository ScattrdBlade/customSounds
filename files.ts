/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

interface StoredFile {
    name: string;
    blob: Blob;
    addedAt?: number;
}

const FILE_PREFIX = "CustomSounds_file_";
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
    m4a: "audio/mp4", flac: "audio/flac", aac: "audio/aac", webm: "audio/webm", mp4: "audio/mp4"
};
export const ACCEPTED_AUDIO = Object.keys(MIME_BY_EXT).map(ext => "." + ext).join();

export function mimeFor(name: string, type: unknown): string {
    // Backups store the type in a data URI, so it can't contain , or ;
    if (typeof type === "string" && /^[\w.+-]+\/[\w.+-]{1,100}$/.test(type) && type !== "application/octet-stream") return type;
    const ext = name.split(".").pop()!.toLowerCase();
    return Object.hasOwn(MIME_BY_EXT, ext) ? MIME_BY_EXT[ext] : "audio/mpeg";
}

const urls = new Map<string, string>();
const absent = new Set<string>();
export const isAbsent = (id: string) => absent.has(id);

async function sha256(data: BufferSource) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    return Array.from(hash, b => b.toString(16).padStart(2, "0")).join("");
}

export const getFile = (id: string) => DataStore.get<StoredFile>(FILE_PREFIX + id);
export const hasAudio = (f: StoredFile | undefined): f is StoredFile => f?.blob instanceof Blob && f.blob.size > 0;
export const getFileUrl = (id: string) => urls.get(id);
const fileKeys = async () => (await DataStore.keys()).filter((k): k is string => typeof k === "string" && k.startsWith(FILE_PREFIX));

const STORAGE_TIMEOUT = 30_000;
function withTimeout<T>(promise: Promise<T>, what: string) {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} didn't finish in ${STORAGE_TIMEOUT / 1000} seconds`)), STORAGE_TIMEOUT);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const listFiles = () => withTimeout(readFileList(), "Loading the file list");

async function readFileList(): Promise<Record<string, string>> {
    const keys = await fileKeys();
    const files = await DataStore.getMany<StoredFile | undefined>(keys);

    const found: [string, StoredFile][] = [];
    keys.forEach((key, i) => {
        const f = files[i];
        if (hasAudio(f)) found.push([key.slice(FILE_PREFIX.length), f]);
    });

    return Object.fromEntries(found
        .sort(([, a], [, b]) => (a.addedAt ?? 0) - (b.addedAt ?? 0))
        .map(([id, f]) => [id, typeof f.name === "string" ? f.name : "Unknown"]));
}

export const addFile = (file: File) => withTimeout(storeFile(file), "Saving the file");

async function storeFile(file: File): Promise<{ id: string; existingName?: string; }> {
    const bytes = await file.arrayBuffer();
    const id = await sha256(bytes);
    const old = await getFile(id);
    if (hasAudio(old) && await old.blob.arrayBuffer().then(sha256, () => null) === id) {
        absent.delete(id);
        return { id, existingName: old.name };
    }

    await DataStore.set(FILE_PREFIX + id, {
        name: file.name,
        blob: new Blob([bytes], { type: mimeFor(file.name, file.type) }),
        addedAt: Date.now()
    } satisfies StoredFile);
    dropUrl(id);
    const saved = await getFile(id);
    if (!hasAudio(saved) || saved.blob.size !== bytes.byteLength) {
        await DataStore.del(FILE_PREFIX + id);
        throw new Error("the saved file couldn't be read back");
    }
    absent.delete(id);
    return { id };
}

export async function removeFile(id: string) {
    await DataStore.del(FILE_PREFIX + id);
    dropUrl(id);
    absent.add(id);
}

export async function removeAllFiles() {
    const keys = await fileKeys();
    await DataStore.delMany(keys);
    const ids = keys.map(key => key.slice(FILE_PREFIX.length));
    for (const id of ids) {
        dropUrl(id);
        absent.add(id);
    }
    return ids;
}

export async function loadFileUrl(id: string) {
    if (!urls.has(id)) {
        const file = await getFile(id);
        if (!hasAudio(file)) {
            absent.add(id);
            return null;
        }
        if (!urls.has(id)) urls.set(id, URL.createObjectURL(file.blob));
    }
    absent.delete(id);
    return urls.get(id)!;
}

export function canDecode(src: string): Promise<boolean> {
    return new Promise(resolve => {
        const audio = new Audio();
        const done = (ok: boolean) => {
            clearTimeout(timer);
            audio.onloadedmetadata = audio.onerror = null;
            // load() without a src frees the decoder right away, otherwise the file stays in memory
            audio.removeAttribute("src");
            audio.load();
            resolve(ok);
        };
        const timer = setTimeout(() => done(true), 5000);
        audio.preload = "metadata";
        audio.onloadedmetadata = () => done(true);
        audio.onerror = () => done(false);
        audio.src = src;
    });
}

function dropUrl(id: string) {
    const url = urls.get(id);
    if (url) URL.revokeObjectURL(url);
    urls.delete(id);
}
