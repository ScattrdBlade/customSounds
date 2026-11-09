/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { pluralise } from "@utils/misc";

import { dataUriToBytes, logger, mimeFor } from "./audio";
import { blobHash, dropUrl, FILE_PREFIX, getFile, sha256, StoredFile } from "./files";

const LEGACY_KEY = "ScattrdCustomSounds";
const RECHECK_DELAY = 10 * 60 * 1000;

interface LegacyEntry {
    name?: unknown;
    type?: unknown;
    dataUri?: unknown;
    buffer?: unknown;
    base64?: unknown;
}
type Legacy = Record<string, LegacyEntry | null>;

export const unmoved = new Set<string>();
export const legacyNames = new Map<string, string>();

let queue: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>) {
    if (navigator.locks) return navigator.locks.request(LEGACY_KEY, fn);
    const run = queue.then(fn, fn);
    queue = run;
    return run;
}

// Blank values and links (blob:, https:) have no audio to copy
function isEmpty(v: unknown) {
    if (v == null) return true;
    if (typeof v === "string") return !v || /^data:(?:[^,]*,)?$/i.test(v) || /^(?!data:)[a-z][\w+.-]*:/i.test(v);
    if (v instanceof ArrayBuffer) return !v.byteLength;
    return Object.getPrototypeOf(v) === Object.prototype && !Object.keys(v as object).length;
}

function audioFields(entry: unknown) {
    let fields = [entry];
    if (entry && Object.getPrototypeOf(entry) === Object.prototype) {
        const { dataUri, buffer, base64 } = entry as LegacyEntry;
        fields = [dataUri, buffer, typeof base64 === "string" ? "data:;base64," + base64 : base64];
    }
    return fields.filter(v => !isEmpty(v));
}

function toBytes(v: unknown) {
    if (typeof v === "string") return dataUriToBytes(v);
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return null;
}

let migration: Promise<boolean> | undefined;
export const migrateLegacy = () => migration ??= withLock(migrate).catch(e => {
    logger.error("Failed to move the old sound storage, it will retry on the next start. If this keeps happening, see the README:", e);
    return false;
});

export const hasLegacy = async () => await DataStore.get(LEGACY_KEY) != null;

export const clearLegacy = () => withLock(async () => {
    const legacy = await DataStore.get<Legacy>(LEGACY_KEY);
    const ids = new Set([...unmoved, ...(legacy && typeof legacy === "object" ? Object.keys(legacy) : [])]);
    await DataStore.delMany([LEGACY_KEY, LEGACY_KEY + "_Metadata"]);
    unmoved.clear();
    legacyNames.clear();
    migration = Promise.resolve(true);
    return ids;
});

export const forgetLegacy = (id: string) => withLock(async () => {
    const legacy = await DataStore.get<Legacy>(LEGACY_KEY);
    if (legacy && Object.hasOwn(legacy, id)) {
        delete legacy[id];
        await DataStore.set(LEGACY_KEY, legacy);
    }
    unmoved.delete(id);
});

async function migrate() {
    const legacy = await DataStore.get<Legacy>(LEGACY_KEY);
    if (!legacy || typeof legacy !== "object") return true;

    const removable = new Set<string>();
    const dropped: string[] = [];
    const kept: string[] = [];
    const failed: string[] = [];
    let copied = 0;
    let pending = 0;

    for (const [i, id] of Object.keys(legacy).entries()) {
        const entry = legacy[id];
        delete legacy[id];
        const name = typeof entry?.name === "string" && entry.name ? entry.name.slice(0, 200) : "Unknown";
        const label = name === "Unknown" ? `Unknown (${id.slice(0, 64)})` : name;
        if (name !== "Unknown") legacyNames.set(id, name);

        try {
            const fields = audioFields(entry);
            if (!fields.length) {
                removable.add(id);
                continue;
            }

            const existing = await getFile(id);
            if (typeof existing?.addedAt === "number" && Date.now() - existing.addedAt < RECHECK_DELAY) {
                pending++;
                continue;
            }

            const decoded = fields.map(toBytes);
            const bytes = decoded.filter((b): b is Uint8Array<ArrayBuffer> => !!b?.length);
            if (!bytes.length) {
                removable.add(id);
                if (decoded.includes(null)) dropped.push(label);
                continue;
            }

            const hashes = await Promise.all(bytes.map(b => sha256(b)));
            const best = Math.max(0, hashes.indexOf(id));
            const hash = hashes[best];
            const storedHash = await blobHash(existing?.blob);

            if (!storedHash && existing?.blob instanceof Blob && hash !== id && /^[\da-f]{64}$/.test(id)) {
                kept.push(name);
                if (typeof entry?.dataUri === "string" && entry.dataUri.startsWith("data:")) unmoved.add(id);
                continue;
            }

            if (storedHash !== id && storedHash !== hash) {
                const blob = new Blob([bytes[best]], { type: mimeFor(name, entry?.type) });
                await DataStore.set(FILE_PREFIX + id, { name, blob, addedAt: Date.now() + i } satisfies StoredFile);
                dropUrl(id);
                const written = await getFile(id);
                if (written?.blob.size !== blob.size || await blobHash(written.blob) !== hash)
                    throw new Error("new copy doesn't match");
                copied++;
                pending++;
                continue;
            }

            removable.add(id);
            if (decoded.includes(null) || hashes.some(h => h !== storedHash)) dropped.push(`${label} (extra copy)`);
        } catch (e) {
            failed.push(`${name} (${e})`);
            unmoved.add(id);
        }
    }

    const allMoved = !failed.length && !unmoved.size;

    let removed = 0;
    let cleaned = false;
    if (!pending && !failed.length && (removable.size || !kept.length)) {
        try {
            const fresh = await DataStore.get<Legacy>(LEGACY_KEY) ?? {};
            const rest = Object.entries(fresh).filter(([id]) => !removable.has(id));
            const count = Object.keys(fresh).length - rest.length;
            if (!rest.length) await DataStore.delMany([LEGACY_KEY, LEGACY_KEY + "_Metadata"]);
            else if (count) await DataStore.set(LEGACY_KEY, Object.fromEntries(rest));
            removed = count;
            cleaned = true;
        } catch (e) {
            failed.push(`the old entry (${e})`);
        }
    }

    if (copied || removed || kept.length || failed.length) {
        const deleted = cleaned ? dropped : [];
        const parts = [`Old sound storage: copied ${pluralise(copied, "file")}, removed ${pluralise(removed, "entry", "entries")}`];
        if (deleted.length) parts.push(`Dropped old data that can't be converted or checked: ${deleted.join(", ")}`);
        if (kept.length) parts.push(`Kept the old data because the copy here can't be read: ${kept.join(", ")}`);
        if (pending) parts.push("The old storage is removed on a later start, at least 10 minutes from now");
        if (failed.length) parts.push(`Failed, will retry on the next start: ${failed.join(", ")}`);

        const message = parts.join(". ");
        if (failed.length) logger.error(message);
        else if (kept.length || deleted.length) logger.warn(message);
        else logger.info(message);
    }

    return allMoved;
}

export const legacyFiles = (ids: Iterable<string>) => withLock(async () => {
    const stored = await DataStore.get<Legacy>(LEGACY_KEY);
    const legacy: Legacy = stored && typeof stored === "object" ? stored : {};
    const out = new Map<string, StoredFile>();
    for (const id of ids) {
        const entry = Object.hasOwn(legacy, id) ? legacy[id] : null;
        const bytes = audioFields(entry).map(toBytes).find(b => !!b?.length);
        const name = legacyNames.get(id) ?? "Unknown";
        if (bytes) out.set(id, { name, blob: new Blob([bytes], { type: mimeFor(name, entry?.type) }) });
    }
    return out;
});
