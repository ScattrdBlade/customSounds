/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { get, set } from "@api/DataStore";

const STORAGE_KEY = "ScattrdCustomSounds";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUUIDLike(s: string): boolean {
    return UUID_REGEX.test(s);
}

export interface StoredAudioFile {
    id: string;
    name: string;
    type: string;
    buffer: ArrayBuffer;
    dataUri: string;
}

interface LegacyStoredAudioFile {
    id: string;
    name: string;
    type: string;
    buffer?: ArrayBuffer;
    dataUri?: string;
}

async function hashBuffer(buffer: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

export async function saveAudio(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    const id = await hashBuffer(buffer);
    const dataUri = await generateDataURI(buffer, file.type, file.name);

    const current = (await get(STORAGE_KEY)) ?? {};
    current[id] = {
        id,
        name: file.name,
        type: file.type,
        buffer,
        dataUri
    };
    await set(STORAGE_KEY, current);
    return id;
}

export async function getAllAudio(): Promise<Record<string, StoredAudioFile>> {
    return (await get(STORAGE_KEY)) ?? {};
}

async function generateDataURI(buffer: ArrayBuffer, type: string, name: string): Promise<string> {
    try {
        let mimeType = type || "audio/mpeg";

        if (!mimeType || mimeType === "application/octet-stream") {
            if (name) {
                const extension = name.split(".").pop()?.toLowerCase();
                switch (extension) {
                    case "ogg": mimeType = "audio/ogg"; break;
                    case "mp3": mimeType = "audio/mpeg"; break;
                    case "wav": mimeType = "audio/wav"; break;
                    case "m4a":
                    case "mp4": mimeType = "audio/mp4"; break;
                    case "flac": mimeType = "audio/flac"; break;
                    case "aac": mimeType = "audio/aac"; break;
                    case "webm": mimeType = "audio/webm"; break;
                    case "wma": mimeType = "audio/x-ms-wma"; break;
                    default: mimeType = "audio/mpeg";
                }
            }
        }

        const uint8Array = new Uint8Array(buffer);
        const blob = new Blob([uint8Array], { type: mimeType });

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error("[CustomSounds] Error generating data URI:", error);

        const uint8Array = new Uint8Array(buffer);
        let binary = "";
        const chunkSize = 8192;

        for (let i = 0; i < uint8Array.length; i += chunkSize) {
            const chunk = uint8Array.slice(i, i + chunkSize);
            binary += String.fromCharCode(...chunk);
        }

        const base64 = btoa(binary);
        return `data:${type || "audio/mpeg"};base64,${base64}`;
    }
}

function dataUriToArrayBuffer(dataUri: string): ArrayBuffer | null {
    const commaIdx = dataUri.indexOf(",");
    if (commaIdx === -1) return null;

    const meta = dataUri.slice(0, commaIdx);
    const payload = dataUri.slice(commaIdx + 1);
    if (!meta.includes(";base64")) return null;

    try {
        const binary = atob(payload);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
    } catch {
        return null;
    }
}

export async function getAudioDataURI(id: string): Promise<string | undefined> {
    const all = await getAllAudio();
    const entry = all[id];
    if (!entry) return undefined;

    if (entry.dataUri) return entry.dataUri;

    if (entry.buffer instanceof ArrayBuffer) {
        const dataUri = await generateDataURI(entry.buffer, entry.type, entry.name);
        const current = await getAllAudio();
        if (current[id]) {
            current[id].dataUri = dataUri;
            await set(STORAGE_KEY, current);
        }
        return dataUri;
    }

    return undefined;
}

export async function deleteAudio(id: string): Promise<void> {
    const all = await getAllAudio();
    delete all[id];
    await set(STORAGE_KEY, all);
}

export interface ExportedAudioFile {
    id: string;
    name: string;
    type: string;
    dataUri: string;
}

export async function importAudio(data: ExportedAudioFile): Promise<string | null> {
    if (!data?.dataUri) return null;

    const buffer = dataUriToArrayBuffer(data.dataUri);
    if (!buffer) return null;

    const hashId = await hashBuffer(buffer);

    const current = (await get(STORAGE_KEY)) ?? {};
    current[hashId] = {
        id: hashId,
        name: data.name || "Imported Sound",
        type: data.type || "audio/mpeg",
        buffer,
        dataUri: data.dataUri
    };
    await set(STORAGE_KEY, current);

    return hashId;
}

export async function migrateAudioStore(): Promise<void> {
    const raw = (await get(STORAGE_KEY)) as Record<string, LegacyStoredAudioFile> | undefined;
    if (!raw) return;

    let changed = false;
    const migrated: Record<string, LegacyStoredAudioFile> = {};

    for (const [id, entry] of Object.entries(raw)) {
        if (!entry || typeof entry !== "object") continue;

        let buffer = entry.buffer instanceof ArrayBuffer ? entry.buffer : undefined;
        let { dataUri } = entry;

        if (!dataUri && buffer) {
            try {
                dataUri = await generateDataURI(buffer, entry.type, entry.name);
                console.log(`[CustomSounds] Migrated buffer-only entry ${id} (${entry.name}) → added dataUri`);
                changed = true;
            } catch (error) {
                console.error(`[CustomSounds] Failed to generate dataUri for ${id}:`, error);
            }
        }

        if (!buffer && dataUri) {
            const decoded = dataUriToArrayBuffer(dataUri);
            if (decoded) {
                buffer = decoded;
                console.log(`[CustomSounds] Migrated dataUri-only entry ${id} (${entry.name}) → added buffer`);
                changed = true;
            } else {
                console.warn(`[CustomSounds] Could not decode dataUri for ${id}; entry will keep dataUri only.`);
            }
        }

        if (!buffer && !dataUri) {
            console.warn(`[CustomSounds] Entry ${id} has neither dataUri nor buffer; skipping.`);
            continue;
        }

        migrated[id] = {
            id: entry.id ?? id,
            name: entry.name,
            type: entry.type,
            ...(buffer ? { buffer } : {}),
            ...(dataUri ? { dataUri } : {})
        };
    }

    if (changed) {
        await set(STORAGE_KEY, migrated);
        console.log("[CustomSounds] Audio store migration complete.");
    }
}

export async function migrateToHashIds(): Promise<Record<string, string>> {
    const all = await getAllAudio();
    const entries = Object.entries(all);

    const needsMigration = entries.some(([id, entry]) =>
        entry?.buffer instanceof ArrayBuffer && isUUIDLike(id)
    );
    if (!needsMigration) return {};

    const next: Record<string, StoredAudioFile> = {};
    const remap: Record<string, string> = {};

    for (const [oldId, entry] of entries) {
        if (!entry || !(entry.buffer instanceof ArrayBuffer)) {
            if (entry) next[oldId] = entry;
            continue;
        }

        if (!isUUIDLike(oldId)) {
            next[oldId] = entry;
            continue;
        }

        const newId = await hashBuffer(entry.buffer);
        if (newId === oldId) {
            next[oldId] = entry;
        } else {
            remap[oldId] = newId;
            next[newId] = { ...entry, id: newId };
        }
    }

    const remapCount = Object.keys(remap).length;
    if (remapCount > 0) {
        await set(STORAGE_KEY, next);
        console.log(`[CustomSounds] Re-keyed ${remapCount} files from random UUIDs to content hashes.`);
    }

    return remap;
}
