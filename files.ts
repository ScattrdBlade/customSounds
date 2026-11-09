/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

export interface StoredFile {
    name: string;
    blob: Blob;
    addedAt?: number;
}

export const FILE_PREFIX = "CustomSounds_file_";
const MAX_FILE_MB = 50;
export const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

const urls = new Map<string, string>();
const absent = new Set<string>();
export const isAbsent = (id: string) => absent.has(id);

export async function sha256(data: BufferSource) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    return Array.from(hash, b => b.toString(16).padStart(2, "0")).join("");
}

export async function blobHash(blob: unknown) {
    if (!(blob instanceof Blob)) return null;
    const bytes = await blob.arrayBuffer().catch(() => null);
    return bytes ? sha256(bytes) : null;
}

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const getFile = (id: string) => DataStore.get<StoredFile>(FILE_PREFIX + id);
export const hasAudio = (f: StoredFile | undefined): f is StoredFile => f?.blob instanceof Blob && f.blob.size > 0;
export const getFileUrl = (id: string) => urls.get(id);

export async function listFiles(): Promise<Record<string, string>> {
    const keys = (await DataStore.keys()).filter((k): k is string => typeof k === "string" && k.startsWith(FILE_PREFIX));
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

export async function addFile(file: File) {
    if (file.size > MAX_FILE_BYTES) throw new Error(`file is too large (max ${MAX_FILE_MB} MB)`);
    if (!file.size) throw new Error("file is empty");
    const bytes = await file.arrayBuffer();
    const id = await sha256(bytes);
    const old = await getFile(id);
    if (old && await blobHash(old.blob) === id) {
        absent.delete(id);
        return { id, existingName: old.name };
    }

    await DataStore.set(FILE_PREFIX + id, {
        name: file.name,
        blob: new Blob([bytes], { type: file.type }),
        addedAt: Date.now()
    } satisfies StoredFile);
    dropUrl(id);
    absent.delete(id);
    return { id };
}

export async function removeFile(id: string) {
    await DataStore.del(FILE_PREFIX + id);
    dropUrl(id);
    absent.add(id);
}
export async function removeAllFiles() {
    const keys = (await DataStore.keys()).filter((k): k is string => typeof k === "string" && k.startsWith(FILE_PREFIX));
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

export function dropUrl(id: string) {
    const url = urls.get(id);
    if (url) URL.revokeObjectURL(url);
    urls.delete(id);
}

export function revokeFileUrls() {
    urls.forEach(url => URL.revokeObjectURL(url));
    urls.clear();
}
