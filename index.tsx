/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings, SettingsStore } from "@api/Settings";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { Flex } from "@components/Flex";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { Margins } from "@components/margins";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { classes, pluralise } from "@utils/misc";
import { wordsFromSnake, wordsToTitle } from "@utils/text";
import definePlugin, { makeRange, OptionType, StartAt } from "@utils/types";
import { chooseFile, saveFile } from "@utils/web";
import { ConfirmModal, ContextMenuApi, FluxDispatcher, MediaEngineStore, Menu, Modal, openModal, Select, showToast, Slider, TextInput, useCallback, useEffect, useRef, useState } from "@webpack/common";

import { ACCEPTED_AUDIO, applyBoost, applyElementVolume, AudioPlayer, buildBackup, clearBoost, effectiveVolume, ExportedAudioFile, getNativeSoundName, getPlayerSinkId, getSoundpacks, importAudioFiles, isUrl, lastBaseVolume, logger, MAX_BACKUP_BYTES, mimeFor, PatchHealth, playerBaseVolume, playSound, PreviewHandle, probePatched, seasonalUrls, Soundpack } from "./audio";
import { addFile, canDecode, EMPTY_SHA256, getFileUrl, isAbsent, listFiles, loadFileUrl, MAX_FILE_BYTES, removeAllFiles, removeFile, revokeFileUrls } from "./files";
import { clearLegacy, forgetLegacy, hasLegacy, legacyFiles, legacyNames, migrateLegacy, unmoved } from "./migration";
import { cleanName, DEFAULT_VOLUME, MAX_VOLUME, normalizeOverride, SoundOverride, SoundpackRequire, SoundType, soundTypes } from "./types";

const cl = classNameFactory("vc-customSounds-");

const settings = definePluginSettings({
    overrides: {
        type: OptionType.CUSTOM,
        default: {} as Record<string, SoundOverride>
    },
    soundsUI: {
        type: OptionType.COMPONENT,
        component: SettingsUI
    }
});

function migrateLegacySettings() {
    const plain = settings.plain as Record<string, unknown> & { overrides?: Record<string, SoundOverride>; };
    const target = (plain.overrides ??= {});
    if (!target || typeof target !== "object") return;
    let changed = false;
    for (const t of soundTypes) {
        const stored = plain[t.id];
        if (stored === undefined) continue;
        try {
            const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
            if (parsed && typeof parsed === "object" && !(t.id in target)) target[t.id] = parsed;
        } catch (e) {
            logger.warn(`Failed to migrate the old setting for "${t.id}", it was reset:`, e);
        }
        delete plain[t.id];
        changed = true;
    }
    if (changed) SettingsStore.markAsChanged();
}

function getOverride(id: string): SoundOverride {
    const o = normalizeOverride(settings.store.overrides?.[id]);
    o.selectedSound = resolveLegacySeason(id, o.selectedSound);
    return o;
}

function hasSoundSettings() {
    return soundTypes.some(t => {
        const o = getOverride(t.id);
        return o.enabled || o.selectedSound !== "default" || o.volume !== DEFAULT_VOLUME || !!o.selectedFileId;
    });
}

// Older versions saved Discord's misspelled keys, which don't play anything
const LEGACY_VARIANTS: Record<string, string> = { halloween_defean: "halloween_deafen", halloween_undefean: "halloween_undeafen" };
function resolveLegacySeason(id: string, selected: string): string {
    let variant: string | undefined;
    if (Object.hasOwn(LEGACY_VARIANTS, selected)) variant = LEGACY_VARIANTS[selected];
    else if (selected === "halloween" || selected === "winter") variant = `${selected}_${id}`;
    if (!variant) return selected;
    return soundTypes.find(t => t.id === id)?.seasonal?.[variant] ? variant : "default";
}

// A copy, so settings.use() sees the change
function setOverride(id: string, o: SoundOverride) {
    settings.store.overrides[id] = { ...o };
}

function clip(s: string, max: number) {
    if (s.length <= max) return s;
    return s.slice(0, max - 1).replace(/[\ud800-\udbff]$/, "") + "…";
}

let healthCheckTimer: ReturnType<typeof setTimeout> | undefined;
let migrationNoticeTimer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let startupHealth: PatchHealth | null = null;
const BROKEN_TOAST = "A Discord update broke CustomSounds. See its settings.";
const HEALTH_MESSAGES: Partial<Record<PatchHealth, string>> = {
    "reverted": "A Discord update broke CustomSounds. Discord's own sounds play until the plugin is updated.",
    "init-throws": "A Discord update broke CustomSounds, and it may stop sounds from playing. Disable it until the plugin is updated.",
    "no-volume": "A Discord update broke CustomSounds' volume control. Volume settings won't apply until the plugin is updated.",
    "no-init": "A Discord update broke part of CustomSounds. Sound settings may not apply while a sound pack is active."
};

let reportedNewSounds = false;
function reportNewSounds(req: SoundpackRequire) {
    if (reportedNewSounds || typeof req?.keys !== "function") return;
    reportedNewSounds = true;
    try {
        const known = new Set(Object.keys(LEGACY_VARIANTS));
        for (const t of soundTypes) {
            known.add(t.id);
            for (const id of Object.keys(t.seasonal ?? {})) known.add(id);
        }
        const extra = req.keys()
            .map(k => k.replace(/^\.\//, "").replace(/\.\w+$/, ""))
            .filter(n => !known.has(n));
        if (extra.length) logger.info("Found sounds CustomSounds doesn't know about yet:", extra.join(", "));
    } catch { }
}

let overridesGeneration = 0;
const HASH_ID = /^[0-9a-f]{64}$/;
type OverrideEntry = SoundOverride & { id: string; };
const soundName = (id: string) => soundTypes.find(t => t.id === id)?.name ?? id;
const withFileName = (sound: string, file?: string) => file ? `${sound} ("${file}")` : sound;
let importing = 0;
let exporting = false;
let uploadingFiles = false;
let cardUploads = 0;
let deletingAll = false;
let checkingDeleteAll = false;
const DELETE_BUSY = "Wait for the audio to finish deleting";

// Vencord's chooseFile() only returns one file and never resolves when the picker is cancelled
function chooseFiles(accept: string) {
    return new Promise<File[]>(resolve => {
        const input = document.createElement("input");
        const done = (files: File[]) => {
            input.remove();
            resolve(files);
        };
        input.type = "file";
        input.multiple = true;
        input.accept = accept;
        input.style.display = "none";
        input.onchange = () => done([...input.files ?? []]);
        input.oncancel = () => done([]);
        document.body.appendChild(input);
        input.click();
    });
}

// "quiet" skips the settings store, otherwise Vencord sees newer local settings on startup and skips the cloud sync
function backfillFileNames(stored: Record<string, string>, quiet = false) {
    if (importing) return;
    try {
        const found: Record<string, SoundOverride> = {};
        for (const [id, o] of Object.entries(settings.plain.overrides ?? {})) {
            if (typeof o?.selectedFileId !== "string" || cleanName(o.selectedFileName)) continue;
            const local = Object.hasOwn(stored, o.selectedFileId) ? stored[o.selectedFileId] : undefined;
            const name = cleanName(local) ?? cleanName(legacyNames.get(o.selectedFileId));
            if (name) found[id] = { ...o, selectedFileName: name };
        }
        if (!Object.keys(found).length) return;
        if (quiet) {
            Object.assign(settings.plain.overrides, found);
            VencordNative.settings.set(SettingsStore.plain).catch(e => logger.warn("Failed to add file names to older sound settings:", e));
        } else {
            settings.store.overrides = { ...settings.plain.overrides, ...found };
        }
    } catch (e) {
        logger.warn("Failed to add file names to older sound settings:", e);
    }
}

async function loadCustom(id: string): Promise<string | null> {
    try {
        if (!await loadFileUrl(id)) await migrateLegacy();
        const url = await loadFileUrl(id);
        if (url) return url;

        if (unmoved.has(id)) showToast({ text: "This sound's file couldn't be moved. Check console.", variant: "critical" });
        else if (id === EMPTY_SHA256) showToast({ text: "This sound's file is empty. Pick or upload another." });
        else showToast({ text: "This sound's file isn't on this device. Upload it again." });
        return null;
    } catch (e) {
        logger.error("Failed to load a custom sound file:", e);
        showToast({ text: "Failed to load this sound's file. Check console.", variant: "critical" });
        return null;
    }
}

function describeSource(id: string, selectedSound: string): string | null {
    if (selectedSound === "regular") return "Always plays Discord's regular sound, ignoring sound packs and seasonal events.";
    if (selectedSound !== "default") return null;
    const native = getNativeSoundName(id);
    return "Plays Discord's own sound, including your sound pack and seasonal sounds"
        + (native !== id ? ` (currently ${wordsToTitle(wordsFromSnake(native))}).` : ".");
}

function SoundCard({ type, override, files, filesLoaded, onFilesChange }: {
    type: SoundType;
    override: SoundOverride;
    files: Record<string, string>;
    filesLoaded: boolean;
    onFilesChange: () => Promise<void>;
}) {
    const sound = useRef<PreviewHandle>(null);
    const previewToken = useRef(0);
    const uploadToken = useRef(0);

    const stopPreview = () => {
        previewToken.current++;
        sound.current?.stop();
    };

    useEffect(() => stopPreview, []);

    // Reads the stored override, not the prop, so a save after an await keeps newer changes
    const save = (patch: Partial<SoundOverride>) => {
        if (patch.selectedFileId || ("selectedSound" in patch && patch.selectedSound !== getOverride(type.id).selectedSound)) switchToNativeLater.delete(type.id);
        const next = { ...getOverride(type.id), ...patch };
        setOverride(type.id, next);
        const fileChanged = "selectedFileId" in patch || "selectedSound" in patch || "enabled" in patch;
        if (fileChanged && next.enabled && next.selectedSound === "custom" && next.selectedFileId)
            loadCustom(next.selectedFileId);
    };

    const baseVolume = () => lastBaseVolume.get(type.id);
    const playNative = (volume?: number) => playSound(getNativeSoundName(type.id), { volume, originalName: type.id, baseVolume: baseVolume() });

    const previewSound = async () => {
        const token = ++previewToken.current;
        sound.current?.stop();
        if (!override.enabled) {
            sound.current = playNative();
            return;
        }

        const { selectedSound, volume, selectedFileId } = override;
        if (selectedSound === "custom") {
            if (!selectedFileId) {
                sound.current = playNative(switchToNativeLater.has(type.id) ? volume : undefined);
                return;
            }
            const src = await loadCustom(selectedFileId);
            if (token !== previewToken.current) return;
            sound.current = src ? playSound(src, { volume, baseVolume: baseVolume() }) : playNative();
        } else if (selectedSound === "default") {
            sound.current = playNative(volume);
        } else {
            sound.current = playSound(selectedSound === "regular" ? type.id : selectedSound, { volume, originalName: type.id, baseVolume: baseVolume() });
        }
    };

    const uploadFile = async () => {
        let file = await chooseFile(ACCEPTED_AUDIO);
        if (!file) return;
        if (deletingAll || checkingDeleteAll) return showToast({ text: DELETE_BUSY });
        if (!file.size) return showToast({ text: "Upload failed: file is empty", variant: "critical" });
        if (file.size > MAX_FILE_BYTES) return showToast({ text: "Upload failed: file is too large (max 50 MB)", variant: "critical" });
        file = new File([file], file.name, { type: mimeFor(file.name, file.type) });
        cardUploads++;
        try {
            showToast({ text: "Uploading file..." });
            const generation = overridesGeneration;
            const token = ++uploadToken.current;
            const before = getOverride(type.id);
            const added = await addFile(file);
            const current = getOverride(type.id);
            const selected = generation === overridesGeneration && token === uploadToken.current
                && current.selectedSound === before.selectedSound && current.selectedFileId === before.selectedFileId;
            if (selected)
                save({ selectedFileId: added.id, selectedFileName: cleanName(added.existingName) ?? cleanName(file.name), selectedSound: "custom" });
            await onFilesChange();

            const url = await loadFileUrl(added.id).catch(() => null);
            if (url && !await canDecode(url)) return showToast({ text: "Uploaded, but Discord can't play it. Use MP3 or OGG.", variant: "critical", duration: 8000 });

            if (!selected || generation !== overridesGeneration) showToast({ text: "Uploaded, but settings changed so it wasn't selected", variant: "success" });
            else if (added.existingName) showToast({ text: "Already uploaded, using the existing file", variant: "success" });
            else showToast({ text: "File uploaded", variant: "success" });
        } catch (e) {
            logger.error("Upload failed:", e);
            showToast({ text: "Upload failed. Check console.", variant: "critical" });
        } finally {
            cardUploads--;
        }
    };

    const deleteFile = async (id: string) => {
        try {
            await forgetLegacy(id);
            await removeFile(id);
            handleFileDeleted(new Set([id]));
            await onFilesChange();
            showToast({ text: "File deleted", variant: "success" });
        } catch (e) {
            logger.error("Delete failed:", e);
            showToast({ text: "Delete failed. Check console.", variant: "critical" });
        }
    };

    const onToggle = (enabled: boolean) => {
        if (!enabled) stopPreview();
        save({ enabled });
    };

    const onVolumeChange = (val: number) => {
        const volume = Math.round(val);
        save({ volume });
        sound.current?.setVolume(volume);
    };

    const onFileSelect = (id: string) => {
        if (!id && !filesLoaded) return;
        let selectedFileName: string | undefined;
        if (Object.hasOwn(files, id)) selectedFileName = cleanName(files[id]);
        else if (id) selectedFileName = override.selectedFileName;
        save({ selectedFileId: id || undefined, selectedFileName });
    };

    const fileMissing = filesLoaded && override.selectedSound === "custom" && !!override.selectedFileId && !Object.hasOwn(files, override.selectedFileId);
    const fileOpts = Object.entries(files).map(([id, name]) => ({ value: id, label: name }));
    const lost = override.selectedFileName;
    const missing = {
        label: lost ? `Not on this device: "${clip(lost, 60)}"` : "File not on this device",
        text: `${lost ? `"${lost}" isn't` : "This file isn't"} on this device. Until you upload it again or import a backup with it, Discord plays its own sound.`,
        warn: false
    };
    if (override.selectedFileId === EMPTY_SHA256) {
        missing.label = "Empty file";
        missing.text = "An older version saved this file empty. Until you pick or upload another file, Discord plays its own sound.";
    }
    if (fileMissing && unmoved.has(override.selectedFileId!)) {
        missing.label = "File couldn't be moved";
        const fileName = lost ? ` "${lost}"` : "";
        missing.text = `This sound's file${fileName} couldn't be moved from the old storage, so Discord plays its own sound. `
            + "Restart to retry or upload the same file again, and don't clear Discord's data. Check console.";
        missing.warn = true;
    }
    if (fileMissing) fileOpts.unshift({ value: override.selectedFileId!, label: missing.label });

    const sourceOpts = [
        { value: "default", label: "Native" },
        { value: "regular", label: "Regular" },
        ...Object.keys(type.seasonal ?? {}).map(id => ({ value: id, label: soundTypes.find(t => t.id === id)?.name ?? wordsToTitle(wordsFromSnake(id)) })),
        { value: "custom", label: "Custom" }
    ];
    const sourceHint = override.enabled ? describeSource(type.id, override.selectedSound) : null;

    return (
        <Card className={cl("card")}>
            <FormSwitch
                title={type.name}
                value={override.enabled}
                className={Margins.bottom16}
                hideBorder
                onChange={onToggle}
            />
            {override.enabled && <>
                <Button className={Margins.bottom16} variant="positive" onClick={previewSound}>Preview</Button>
                <Heading>Volume</Heading>
                <Slider
                    className={Margins.bottom16}
                    minValue={0}
                    maxValue={MAX_VOLUME}
                    markers={makeRange(0, MAX_VOLUME, 50)}
                    initialValue={override.volume}
                    onValueRender={(v: number) => `${Math.round(v)}%`}
                    onValueChange={onVolumeChange}
                />
                <Heading>Sound Source</Heading>
                <div className={Margins.bottom16}>
                    <Select
                        closeOnSelect
                        serialize={v => v}
                        isSelected={v => v === override.selectedSound}
                        options={sourceOpts}
                        select={v => save({ selectedSound: v })}
                    />
                    {sourceHint && <Paragraph className={classes(Margins.top8, cl("muted"))} defaultColor={false}>{sourceHint}</Paragraph>}
                </div>
                {override.selectedSound === "custom" && <>
                    <Heading>Custom File</Heading>
                    <div className={Margins.bottom16}>
                        <Select
                            closeOnSelect
                            serialize={v => v}
                            isSelected={v => filesLoaded ? v === (override.selectedFileId || "") : v === ""}
                            options={[{ value: "", label: filesLoaded ? "Select a file..." : "Loading files..." }, ...fileOpts]}
                            select={onFileSelect}
                        />
                        {fileMissing && (missing.warn
                            ? <Card variant="warning" defaultPadding className={Margins.top8}><Paragraph>{missing.text}</Paragraph></Card>
                            : <Paragraph className={classes(Margins.top8, cl("muted"))} defaultColor={false}>{missing.text}</Paragraph>
                        )}
                    </div>
                    <Flex gap="8px" className={Margins.bottom16}>
                        <Button variant="primary" onClick={uploadFile}>Upload Audio</Button>
                        {override.selectedFileId && Object.hasOwn(files, override.selectedFileId) && (
                            <Button variant="dangerPrimary" onClick={() => deleteFile(override.selectedFileId!)}>Delete Audio</Button>
                        )}
                    </Flex>
                </>}
            </>}
        </Card>
    );
}

// Sounds whose file was deleted while the settings were open stay Custom until the last settings view closes
const switchToNativeLater = new Set<string>();
let openSettingsViews = 0;
function switchDeletedToNative() {
    // A running import would see this write as the settings changing, so endImport() does it instead
    if (importing || !switchToNativeLater.size) return;
    const next: Record<string, SoundOverride> = { ...settings.plain.overrides };
    let changed = false;
    for (const id of switchToNativeLater) {
        const o = getOverride(id);
        if (o.selectedSound !== "custom" || o.selectedFileId) continue;
        next[id] = { ...o, selectedSound: "default" };
        changed = true;
    }
    switchToNativeLater.clear();
    if (changed) settings.store.overrides = next;
}

function endImport() {
    if (--importing === 0 && !openSettingsViews) switchDeletedToNative();
}

function handleFileDeleted(ids: ReadonlySet<string>) {
    const next: Record<string, SoundOverride> = { ...settings.plain.overrides };
    let changed = false;
    for (const t of soundTypes) {
        const o = getOverride(t.id);
        if (!o.selectedFileId || !ids.has(o.selectedFileId)) continue;
        next[t.id] = { ...o, selectedFileId: undefined, selectedFileName: undefined };
        if (o.selectedSound === "custom") {
            if (openSettingsViews) switchToNativeLater.add(t.id);
            else next[t.id].selectedSound = "default";
        }
        changed = true;
    }
    if (changed) settings.store.overrides = next;
}

function MoreIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
        </svg>
    );
}

function SettingsUI() {
    settings.use(["overrides"]);
    migrateLegacySettings();
    const [remountKey, setRemountKey] = useState(0);
    const [files, setFiles] = useState<Record<string, string> | null>(null);
    const [query, setQuery] = useState("");
    const [health] = useState<PatchHealth | null>(() => running ? probePatched() ?? startupHealth : null);

    const loadFiles = useCallback(async () => {
        try {
            await migrateLegacy();
            const listed = await listFiles();
            setFiles(listed);
            backfillFileNames(listed);
        } catch (e) {
            logger.error("Failed to load the audio file list:", e);
            setFiles({});
            showToast({ text: "Failed to load your sound files. Check console.", variant: "critical" });
        }
    }, []);

    useEffect(() => {
        openSettingsViews++;
        loadFiles();
        return () => {
            if (--openSettingsViews === 0) switchDeletedToNative();
        };
    }, []);

    const resetOverrides = () => openModal(props => (
        <ConfirmModal
            {...props}
            title="Reset all sound settings?"
            subtitle="Every sound goes back to Discord's own sound. Your uploaded files are kept."
            confirmText="Reset All"
            onConfirm={() => {
                overridesGeneration++;
                settings.store.overrides = {};
                switchToNativeLater.clear();
                setRemountKey(k => k + 1);
                showToast({ text: "All sound settings reset", variant: "success" });
            }}
        />
    ));

    const applyPack = (pack: Soundpack) => {
        const { name } = pack;
        const count = pack.sounds.length;
        const [it, its] = count === 1 ? ["it", "its"] : ["them", "their"];
        openModal(props => (
            <ConfirmModal
                {...props}
                title={`Apply the ${name} sound pack?`}
                subtitle={`This sets ${pluralise(count, "sound")} to the ${name} version and turns ${it} on, replacing ${its} current source. Volume settings and your uploaded files are kept.`}
                confirmText="Apply"
                variant="primary"
                onConfirm={() => {
                    overridesGeneration++;
                    const next: Record<string, SoundOverride> = { ...settings.plain.overrides };
                    for (const [id, selectedSound] of pack.sounds) {
                        next[id] = { ...getOverride(id), enabled: true, selectedSound };
                        switchToNativeLater.delete(id);
                    }
                    settings.store.overrides = next;
                    showToast({ text: `${clip(name, 26)} sound pack applied to ${pluralise(count, "sound")}`, variant: "success" });
                }}
            />
        ));
    };

    const uploadFiles = async () => {
        if (uploadingFiles) return showToast({ text: "Already uploading, please wait" });
        const picked = await chooseFiles(ACCEPTED_AUDIO);
        if (!picked.length) return;
        if (deletingAll || checkingDeleteAll) return showToast({ text: DELETE_BUSY });
        if (uploadingFiles) return showToast({ text: "Already uploading, please wait" });

        uploadingFiles = true;
        let uploaded = 0;
        const existing: string[] = [];
        const skipped: string[] = [];
        try {
            showToast({ text: `Uploading ${pluralise(picked.length, "file")}...` });
            // One at a time, so a big selection never holds every file in memory at once
            for (const chosen of picked) {
                if (!chosen.size || chosen.size > MAX_FILE_BYTES) {
                    skipped.push(`${chosen.name} (${chosen.size ? "over 50 MB" : "empty"})`);
                    continue;
                }
                try {
                    const probe = URL.createObjectURL(chosen);
                    const playable = await canDecode(probe).finally(() => URL.revokeObjectURL(probe));
                    if (!playable) {
                        skipped.push(`${chosen.name} (Discord can't play it, use MP3 or OGG)`);
                        continue;
                    }
                    const added = await addFile(new File([chosen], chosen.name, { type: mimeFor(chosen.name, chosen.type) }));
                    uploaded++;
                    if (added.existingName) existing.push(chosen.name);
                } catch (e) {
                    logger.error(`Upload failed for "${chosen.name}":`, e);
                    skipped.push(`${chosen.name} (failed)`);
                }
            }
            await loadFiles();
        } finally {
            uploadingFiles = false;
        }

        if (existing.length) logger.info(`Upload: these files were already uploaded: ${existing.join(", ")}`);
        if (skipped.length) logger.warn(`Upload: skipped ${skipped.join(", ")}`);
        if (!uploaded) return showToast({ text: `Couldn't upload ${pluralise(skipped.length, "file")}. Check console.`, variant: "critical", duration: 8000 });
        const added = uploaded - existing.length;
        let text = added ? `Uploaded ${pluralise(added, "file")}` : skipped.length ? `${pluralise(existing.length, "file")} already uploaded`
            : existing.length === 1 ? "This file was already uploaded" : `These ${existing.length} files were already uploaded`;
        if (added && existing.length && !skipped.length) text += `, ${existing.length} already uploaded`;
        if (skipped.length) showToast({ text: `${text}, ${skipped.length} skipped. Check console.`, variant: "critical", duration: 8000 });
        else showToast({ text, variant: "success" });
    };

    const busy = () => importing || exporting || uploadingFiles || cardUploads > 0;
    const BUSY = "Wait for the import, export or upload to finish";

    const deleteAllFiles = async () => {
        if (deletingAll || checkingDeleteAll) return showToast({ text: "Already deleting, please wait" });
        if (busy()) return showToast({ text: BUSY });

        let count: number;
        checkingDeleteAll = true;
        try {
            // Wait for the startup migration, or files it hasn't copied yet would be left out of the count
            await migrateLegacy();
            count = new Set([...Object.keys(await listFiles()), ...unmoved]).size;
            if (!count && !await hasLegacy()) return showToast({ text: "No uploaded audio to delete" });
        } catch (e) {
            logger.error("Delete all failed:", e);
            return showToast({ text: "Delete failed. Check console.", variant: "critical" });
        } finally {
            checkingDeleteAll = false;
        }

        openModal(props => (
            <ConfirmModal
                {...props}
                title="Delete all uploaded audio?"
                subtitle={`This deletes ${count ? pluralise(count, "uploaded audio file") : "the old sound storage"} from this device and can't be undone, so use Export backup first if you want a copy. `
                    + "Sounds that use this audio switch to Native when you close these settings. With settings sync on, they switch on your other devices too, but the audio stored there isn't deleted."}
                confirmText="Delete All"
                onConfirm={async () => {
                    if (deletingAll) return showToast({ text: "Already deleting, please wait" });
                    if (busy()) return showToast({ text: BUSY });
                    deletingAll = true;
                    // Stops an upload that's still finishing from selecting a file that's about to be deleted
                    overridesGeneration++;
                    const deleted = new Set<string>();
                    let ok = true;
                    try {
                        try {
                            for (const id of await clearLegacy()) deleted.add(id);
                            clearTimeout(migrationNoticeTimer);
                            for (const id of await removeAllFiles()) deleted.add(id);
                        } catch (e) {
                            ok = false;
                            logger.error("Delete all failed:", e);
                            const left = await listFiles().catch(() => null);
                            if (!left) deleted.clear();
                            else for (const id of Object.keys(left)) deleted.delete(id);
                        }
                        try {
                            if (deleted.size) handleFileDeleted(deleted);
                        } catch (e) {
                            ok = false;
                            logger.error("Delete all failed:", e);
                        }
                    } finally {
                        deletingAll = false;
                    }
                    await loadFiles();
                    if (ok) showToast({ text: "All uploaded audio deleted", variant: "success" });
                    else showToast({ text: "Delete failed. Check console.", variant: "critical" });
                }}
            />
        ));
    };

    const applyImport = async (
        sanitized: OverrideEntry[],
        fileEntries: Partial<ExportedAudioFile>[],
        applyOverrides: boolean,
        noAudio: boolean,
        allInvalid: boolean
    ) => {
        importing++;
        try {
            let gen = overridesGeneration;
            let before = "";
            const hadSettings = hasSoundSettings();
            if (applyOverrides) {
                gen = ++overridesGeneration;
                before = JSON.stringify(settings.store.overrides ?? {});
            }

            const storedBefore = await listFiles();
            const { remap, imported, skipped, ids } = await importAudioFiles(fileEntries);
            const newFiles = ids.filter(id => !Object.hasOwn(storedBefore, id)).length;
            if (allInvalid && !imported) return showToast({ text: "Import failed: no CustomSounds data in this file", variant: "critical" });

            const moved = await migrateLegacy();
            const available = await listFiles();
            setFiles(available);

            const keptCurrent: string[] = [];
            const awaitingFile: string[] = [];
            const switchedToNative: string[] = [];
            const toLoad = new Set<string>();
            let boosted = 0;
            const next: Record<string, SoundOverride> = {};

            const currentNames = new Map<string, string>();
            for (const c of Object.values(settings.plain.overrides ?? {})) {
                const name = cleanName(c?.selectedFileName);
                if (typeof c?.selectedFileId === "string" && name) currentNames.set(c.selectedFileId, name);
            }

            for (const s of sanitized) {
                const fileId = s.selectedFileId ? (remap.get(s.selectedFileId) ?? s.selectedFileId) : undefined;
                const o: SoundOverride = {
                    enabled: s.enabled,
                    selectedSound: s.selectedSound,
                    volume: s.volume,
                    selectedFileId: fileId,
                    selectedFileName: s.selectedFileName ?? (fileId ? currentNames.get(fileId) : undefined)
                };
                if (fileId && !Object.hasOwn(available, fileId)) {
                    const current = getOverride(s.id);
                    if (s.selectedSound === "custom" && current.selectedSound === "custom" && current.selectedFileId && Object.hasOwn(available, current.selectedFileId)) {
                        o.selectedFileId = current.selectedFileId;
                        o.selectedFileName = current.selectedFileName;
                        keptCurrent.push(soundName(s.id));
                    } else if ((HASH_ID.test(fileId) && fileId !== EMPTY_SHA256) || !moved) {
                        if (s.selectedSound === "custom") awaitingFile.push(withFileName(soundName(s.id), o.selectedFileName));
                    } else {
                        o.selectedFileId = undefined;
                        if (o.selectedSound === "custom") {
                            o.selectedSound = "default";
                            switchedToNative.push(withFileName(soundName(s.id), o.selectedFileName));
                        }
                    }
                }
                const localName = o.selectedFileId && Object.hasOwn(available, o.selectedFileId) ? cleanName(available[o.selectedFileId]) : undefined;
                o.selectedFileName = o.selectedFileId ? localName ?? o.selectedFileName : undefined;
                if (o.enabled && o.volume > DEFAULT_VOLUME) boosted++;
                next[s.id] = o;
                if (o.enabled && o.selectedSound === "custom" && o.selectedFileId) toLoad.add(o.selectedFileId);
            }
            Promise.all([...toLoad].map(loadFileUrl)).catch(e => logger.warn("Failed to preload the imported sounds:", e));

            let applied = false;
            if (applyOverrides) {
                if (gen !== overridesGeneration || JSON.stringify(settings.store.overrides ?? {}) !== before)
                    return showToast({ text: imported ? "Files imported, but settings changed. Import again." : "Settings changed during the import. Import again.", duration: 8000 });
                overridesGeneration++;
                settings.store.overrides = next;
                switchToNativeLater.clear();
                setRemountKey(k => k + 1);
                applied = true;
            }

            const needsFiles = awaitingFile.length > 0 || switchedToNative.length > 0;
            const filesOnly = !applied || (!sanitized.length && !hadSettings);
            if (filesOnly && !imported) {
                showToast(skipped
                    ? { text: `Couldn't import ${pluralise(skipped, "file")}. Check console.`, variant: "critical", duration: 8000 }
                    : { text: "Nothing to import in this backup" });
                return;
            }
            let text: string;
            if (filesOnly) text = newFiles ? `Imported ${pluralise(newFiles, "new file")} without settings`
                : skipped ? "No new files imported" : "All files in this backup were already uploaded";
            else if (!sanitized.length) text = newFiles ? `Reset settings and imported ${pluralise(newFiles, "new file")}` : "Reset your sound settings";
            else if (noAudio) text = `Imported ${pluralise(sanitized.length, "setting")}, but the backup has no audio`;
            else if (newFiles) text = `Imported ${pluralise(sanitized.length, "setting")} and ${pluralise(newFiles, "new file")}`;
            else text = `Imported ${pluralise(sanitized.length, "setting")}`;
            if (skipped) text += ` (${pluralise(skipped, "file")} failed)`;
            showToast({ text, variant: skipped || needsFiles ? "default" : "success", duration: needsFiles ? 8000 : undefined });
            if (applied && boosted) showToast({ text: `${pluralise(boosted, "imported sound")} set above ${DEFAULT_VOLUME}%` });

            const lines: string[] = [];
            if (noAudio && needsFiles) lines.push("This backup is from an older CustomSounds version or from Equicord, so it has no audio files.");
            if (awaitingFile.length) lines.push(`${awaitingFile.length === 1 ? "This sound needs its" : "These sounds need their"} file uploaded again: ${awaitingFile.join(", ")}.`);
            if (keptCurrent.length) lines.push(`Kept your current file because the backup's file isn't on this device: ${keptCurrent.join(", ")}.`);
            if (switchedToNative.length) lines.push(`${switchedToNative.length === 1 ? "This sound lost its file and now uses" : "These sounds lost their file and now use"} Native: ${switchedToNative.join(", ")}.`);
            if (needsFiles) lines.push("After uploading the missing files, use Export backup again so your backup includes the audio.");
            if (applied && lines.length) openModal(props => (
                <Modal
                    {...props}
                    title={needsFiles ? "Some sounds need their audio files" : "Import notes"}
                    actions={[{ text: "OK", variant: "primary", onClick: props.onClose }]}
                >
                    {lines.map((l, i) => <Paragraph key={i} className={Margins.bottom8}>{l}</Paragraph>)}
                </Modal>
            ));
        } catch (e) {
            logger.error("Import failed:", e);
            showToast({ text: `Import failed: ${e instanceof Error ? e.message : "check console"}`, variant: "critical" });
        } finally {
            endImport();
        }
    };

    const handleSettingsUpload = async () => {
        const file = importing ? null : await chooseFile("application/json,.json");
        if (importing) return showToast({ text: "Already importing, please wait" });
        if (!file) return;
        if (deletingAll || checkingDeleteAll) return showToast({ text: DELETE_BUSY });
        importing++;
        try {
            if (file.size > MAX_BACKUP_BYTES) return showToast({ text: "Import failed: file is too large (max 500 MB)", variant: "critical" });
            showToast({ text: "Importing..." });
            const json = await file.text();
            let imp: any;
            try {
                imp = JSON.parse(json);
            } catch {
                throw new Error("this file isn't valid JSON");
            }
            const importedOverrides: unknown[] | null = Array.isArray(imp?.overrides) ? imp.overrides : null;
            const importedFiles: unknown[] | null = Array.isArray(imp?.files) ? imp.files : null;
            if (!importedOverrides && !importedFiles)
                throw new Error("not a CustomSounds backup");
            if (imp.overrides !== undefined && !importedOverrides)
                throw new Error("the sound settings in this file are broken");

            const fileEntries = (importedFiles ?? []).filter((fd): fd is Partial<ExportedAudioFile> => !!fd && typeof fd === "object");
            const entryNames = new Map(fileEntries.map(fd => [fd.id, fd.name]));
            const soundsById = new Map(soundTypes.map(t => [t.id, t]));
            const sanitizedById = new Map<string, OverrideEntry>();
            for (const raw of importedOverrides ?? []) {
                const s = raw as Partial<SoundOverride> & { id?: unknown; };
                if (!s || typeof s !== "object" || typeof s.id !== "string") continue;
                const t = soundsById.get(s.id);
                if (!t) continue;
                const o = normalizeOverride({ ...s, selectedFileName: cleanName(s.selectedFileName) ?? entryNames.get(s.selectedFileId) });
                o.selectedSound = resolveLegacySeason(s.id, o.selectedSound);
                const validSounds = new Set(["default", "regular", "custom", ...Object.keys(t.seasonal ?? {})]);
                if (!validSounds.has(o.selectedSound)) o.selectedSound = "default";
                sanitizedById.set(s.id, { ...o, id: s.id });
            }
            const sanitized = [...sanitizedById.values()];

            if (importedOverrides && importedOverrides.length > 0 && sanitized.length === 0 && fileEntries.length === 0)
                throw new Error("no CustomSounds data in this file");

            const applyOverrides = !!importedOverrides && (sanitized.length > 0 || importedOverrides.length === 0);
            const noAudio = !importedFiles && sanitized.some(s => s.selectedSound === "custom" && !!s.selectedFileId);
            const allInvalid = !!importedOverrides && importedOverrides.length > 0 && sanitized.length === 0;

            const run = () => applyImport(sanitized, fileEntries, applyOverrides, noAudio, allInvalid);
            if (applyOverrides && hasSoundSettings()) {
                const stored = await listFiles();
                const newFiles = new Set(fileEntries
                    .filter(fd => typeof fd.dataUri === "string" && !(typeof fd.id === "string" && HASH_ID.test(fd.id) && Object.hasOwn(stored, fd.id)))
                    .map((fd, i) => typeof fd.id === "string" && fd.id ? fd.id : `#${i}`)).size;
                openModal(props => (
                    <ConfirmModal
                        {...props}
                        title="Replace your sound settings?"
                        subtitle={(sanitized.length
                            ? `This replaces your current sound settings with the ${pluralise(sanitized.length, "sound")} in this backup`
                            : "This backup has no sound settings, so importing it resets yours")
                            + (newFiles ? ` and adds ${pluralise(newFiles, "new audio file")}.` : ". It has no new audio files.")
                            + " Your uploaded files are kept."}
                        confirmText="Import"
                        variant="primary"
                        onConfirm={() => {
                            if (importing) return showToast({ text: "Already importing, please wait" });
                            if (deletingAll || checkingDeleteAll) return showToast({ text: DELETE_BUSY });
                            showToast({ text: "Importing..." });
                            void run();
                        }}
                    />
                ));
            } else {
                await run();
            }
        } catch (e) {
            logger.error("Import failed:", e);
            showToast({ text: `Import failed: ${e instanceof Error ? e.message : "check console"}`, variant: "critical" });
        } finally {
            endImport();
        }
    };

    const downloadSettings = async () => {
        if (exporting) return showToast({ text: "Already exporting, please wait" });
        if (deletingAll) return showToast({ text: DELETE_BUSY });
        exporting = true;
        const saved: string[] = [];
        try {
            showToast({ text: "Exporting..." });
            const overrides = soundTypes
                .map(t => {
                    const o = getOverride(t.id);
                    const selectedSound = o.selectedSound === "custom" && !o.selectedFileId && switchToNativeLater.has(t.id) ? "default" : o.selectedSound;
                    const fileId = selectedSound === "custom" ? o.selectedFileId : undefined;
                    return {
                        id: t.id,
                        enabled: o.enabled,
                        selectedSound,
                        selectedFileId: fileId,
                        selectedFileName: fileId && (o.selectedFileName ?? (files && Object.hasOwn(files, fileId) ? cleanName(files[fileId]) : undefined)),
                        volume: o.volume
                    };
                })
                .filter(o => o.enabled || o.selectedSound !== "default" || o.volume !== DEFAULT_VOLUME);
            const used = overrides.filter(o => o.selectedSound === "custom" && o.selectedFileId).map(o => o.selectedFileId!);
            const moved = await migrateLegacy();
            const old = unmoved.size ? await legacyFiles(unmoved).catch(e => void logger.warn("Export: failed to read the old storage:", e)) : undefined;
            const exportedAt = new Date().toISOString();

            let rest = [...used, ...unmoved, ...Object.keys(await listFiles())];
            const left: string[] = [];
            const fromOld: string[] = [];
            let bundled = 0;
            let unbundled = 0;
            let base = "";
            do {
                const part = await buildBackup(saved.length ? { format: 2, exportedAt } : { format: 2, exportedAt, overrides }, rest, old);
                // Split backups have the export time in their names so parts of different exports don't get mixed up
                base ||= `customSounds-backup-${exportedAt.slice(0, 10)}${part.rest.length ? "-" + exportedAt.slice(11, 16).replace(":", "") : ""}`;
                // The first part holds the settings, so it's always saved. Later parts only if they got files
                if (!saved.length || part.bundled) {
                    saved.push(`${base}${saved.length ? `-part${saved.length + 1}` : ""}.json`);
                    saveFile(new File([part.backup], saved[saved.length - 1], { type: "application/json" }));
                }
                bundled += part.bundled;
                unbundled += part.unbundled;
                left.push(...part.left);
                fromOld.push(...part.fromOld);
                rest = part.rest;
            } while (rest.length);

            if (saved.length > 1)
                logger.info(`Export: split the backup into ${saved.length} files, since one import holds at most 300 MB: ${saved.join(", ")}. Import the -part files first and ${saved[0]} last`);
            if (fromOld.length)
                logger.warn(`Export: these files couldn't be moved, so they were taken from the old storage: ${fromOld.join(", ")}. `
                    + "Don't clear Discord's data. Restart to retry, or upload them again");
            else if (!moved)
                logger.warn("Export: moving the old storage failed, so files that are only there may be missing from the backup. Don't clear Discord's data");
            if (unbundled)
                logger.warn(`Export: couldn't add the audio for ${pluralise(unbundled, "file")} (missing, empty or unreadable${moved ? "" : ", or still in the old storage"})`);
            if (left.length)
                logger.warn(`Export: left out files over the 50 MB import limit, so keep the originals: ${left.join(", ")}`);

            const missed = unbundled + left.length;
            const ok = !missed && moved;
            const split = saved.length > 1;
            let text: string;
            if (missed) text = split ? `Saved ${saved.length} files, but ${missed} couldn't be added. Check console.` : `Exported, but ${pluralise(missed, "file")} couldn't be added. Check console.`;
            else if (!moved) text = split ? `Saved ${saved.length} files, but old ones weren't moved. Check console.` : "Exported, but old files weren't moved. Check console.";
            else if (split) text = `Saved ${saved.length} backup files. Check your downloads.`;
            else text = `Exported ${pluralise(overrides.length, "setting")} and ${pluralise(bundled, "file")}`;
            showToast({ text, variant: ok ? "success" : "critical", duration: ok ? undefined : 8000 });
        } catch (e) {
            logger.error("Export failed:", e);
            if (saved.length) logger.error(`Export: these backup files are incomplete, export again: ${saved.join(", ")}`);
            showToast({ text: saved.length ? "Export failed. Saved files are incomplete. Check console." : "Export failed. Check console.", variant: "critical" });
        } finally {
            exporting = false;
        }
    };

    const openSettingsMenu = (e: React.MouseEvent) => {
        const packs = getSoundpacks();
        ContextMenuApi.openContextMenu(e, () => (
            <Menu.Menu
                navId="vc-customsounds-settings"
                onClose={() => FluxDispatcher.dispatch({ type: "CONTEXT_MENU_CLOSE" })}
                aria-label="CustomSounds options"
            >
                {packs.length > 0 && (
                    <Menu.MenuItem id="vc-customsounds-packs" label="Apply sound pack">
                        {packs.map(p => <Menu.MenuItem key={p.key} id={`vc-customsounds-pack-${p.key}`} label={p.name} action={() => applyPack(p)} />)}
                    </Menu.MenuItem>
                )}
                <Menu.MenuItem id="vc-customsounds-import" label="Import backup" action={handleSettingsUpload} />
                <Menu.MenuItem id="vc-customsounds-export" label="Export backup" action={downloadSettings} />
                <Menu.MenuSeparator />
                <Menu.MenuItem id="vc-customsounds-reset" label="Reset all sound settings" color="danger" action={resetOverrides} />
                <Menu.MenuItem id="vc-customsounds-delete-all" label="Delete all audio" color="danger" action={deleteAllFiles} />
            </Menu.Menu>
        ));
    };

    const q = query.trim().toLowerCase();
    const shownTypes = q ? soundTypes.filter(t => t.name.toLowerCase().includes(q) || t.id.includes(q)) : soundTypes;

    return (
        <div>
            {!running && (
                <Paragraph className={classes(Margins.bottom16, cl("muted"))} defaultColor={false}>
                    CustomSounds isn't active yet. Restart Discord to apply your sound settings.
                </Paragraph>
            )}
            {health && HEALTH_MESSAGES[health] && (
                <Card variant="danger" defaultPadding className={Margins.bottom16}>
                    <Paragraph>{HEALTH_MESSAGES[health]}</Paragraph>
                </Card>
            )}
            <Flex gap="8px" alignItems="center" className={Margins.bottom16}>
                <Button variant="primary" onClick={uploadFiles}>Upload Audio</Button>
                <Button variant="secondary" size="iconOnly" aria-label="More options" aria-haspopup="menu" onClick={openSettingsMenu}>
                    <MoreIcon />
                </Button>
            </Flex>
            <div className={Margins.bottom16}>
                <TextInput value={query} onChange={setQuery} placeholder="Search sounds by name or ID" />
            </div>
            <Flex flexDirection="column" gap="16px">
                {shownTypes.map(type => (
                    <SoundCard
                        key={`${type.id}-${remountKey}`}
                        type={type}
                        override={getOverride(type.id)}
                        files={files ?? {}}
                        filesLoaded={files !== null}
                        onFilesChange={loadFiles}
                    />
                ))}
                {!shownTypes.length && <Paragraph className={cl("muted")} defaultColor={false}>No sounds match "{query}".</Paragraph>}
            </Flex>
        </div>
    );
}

export default definePlugin({
    name: "CustomSounds",
    description: "Replace Discord's sounds with your own audio or seasonal variants and set a volume for each",
    authors: [Devs.ScattrdBlade, Devs.TheKodeToad],
    tags: ["Customisation", "Notifications", "Voice"],
    searchTerms: ["sound", "audio", "volume", "notification", "ringtone", "sfx"],
    settings,
    startAt: StartAt.Init,

    patches: [
        {
            find: "could not play audio:",
            group: true,
            replacement: [
                {
                    // arguments[1] is the sound name before the sound pack is applied. Skip subclasses since code before super() throws
                    match: /(constructor\(\i,\i,\i,[^)]*\)\{)(?!super\()/,
                    replace: "$1$self.initPlayer(this,arguments[1]);"
                },
                {
                    // Needed for boosting, AudioContext mutes cross-origin audio that wasn't loaded with CORS
                    match: /(new Audio;)(\i)(\.src=)/,
                    replace: '$1$2.crossOrigin="anonymous";$2$3'
                },
                {
                    // $csPath has to be a name the minifier never uses, otherwise it could shadow $2
                    match: /(\i\.src=)(.{0,30}?)\((?:`\.\/\$\{this\.name\}\.(\w+)`|"\.\/"\.concat\(this\.name,"\.(\w+)"\))\)/,
                    replace: '$1$self.resolveSrc(this,Object.assign($csPath=>($2)($csPath),{keys:($2).keys?.bind?.($2)}),"$3$4")'
                },
                {
                    // [^;?{}] so the group fails if Discord adds a check here (like this._muted?0:...), but NotificationVolume's patch still matches
                    match: /(\i)\.volume=([^;?{}]{0,120}?Math\.min\((\i\.\i\.getOutputVolume\(\))\/100\*this\._volume,1\))/,
                    replace: "$1.volume=$self.modifyVolume(this,$1,$3,$2)"
                },
                {
                    match: /(set volume\((\i)\)\{)/,
                    replace: "$1if($self.setVolume(this,$2))return;"
                },
                {
                    match: /(this\._audio\.then\((\i)=>\{)(?=\2\.onerror=null)/,
                    replace: "$1$self.cleanupBoost($2),"
                },
                {
                    match: /((\i)\.onerror=\(\)=>\{)/,
                    replace: "$1if($self.handleAudioError(this,$2))return;"
                },
                {
                    match: /(\i\.isPlatformEmbedded&&)(\i)\.setSinkId\(/,
                    replace: "$1$self.safeSetSinkId($2,"
                }
            ]
        }
    ],

    initPlayer(player: AudioPlayer, originalName: unknown) {
        player.__csPatched = true;
        if (typeof originalName === "string") player.__csOriginalName = originalName;
    },

    // Sound packs rename the player. A source picked for the original sound wins, then the mapped name's card, then the original id
    getActiveOverride(player: AudioPlayer): OverrideEntry | null {
        const { name } = player;
        if (typeof name !== "string" || isUrl(name)) return null;
        const canonical = player.__csOriginalName !== name ? player.__csOriginalName : undefined;
        const original = canonical ? getOverride(canonical) : undefined;
        if (canonical && original?.enabled) {
            const s = original.selectedSound;
            const ownPick = s === "custom" ? !!original.selectedFileId && !isAbsent(original.selectedFileId)
                : s === "regular" || Object.hasOwn(soundTypes.find(t => t.id === canonical)?.seasonal ?? {}, s);
            if (ownPick) return { ...original, id: canonical };
        }
        const mapped = getOverride(name);
        if (mapped.enabled) return { ...mapped, id: name };
        if (canonical && original?.enabled) return { ...original, id: canonical };
        return null;
    },

    getVolumeOverride(player: AudioPlayer): number | null {
        if (player.__csPreviewVolume != null) return player.__csPreviewVolume;
        const o = this.getActiveOverride(player);
        if (!o) return null;
        if (o.selectedSound === "custom" && !o.selectedFileId && switchToNativeLater.has(o.id)) return o.volume;
        if (o.selectedSound === "custom" && (!o.selectedFileId || isAbsent(o.selectedFileId))) return null;
        return o.volume;
    },

    resolveSrc(player: AudioPlayer, req: SoundpackRequire, ext: string): string {
        const { name } = player;
        ext ||= "mp3";
        player.__csDefaultSrc = undefined;
        if (isUrl(name)) return name;
        reportNewSounds(req);

        const load = (sound: string) => {
            try {
                return req(`./${sound}.${ext}`);
            } catch {
                return undefined;
            }
        };

        try {
            const o = this.getActiveOverride(player);
            if (o) {
                let src: string | undefined;
                if (o.selectedSound === "custom") {
                    src = o.selectedFileId ? getFileUrl(o.selectedFileId) : undefined;
                    // Not cached yet, so this play uses the default sound and the next one gets the custom one
                    if (!src && o.selectedFileId) loadFileUrl(o.selectedFileId).catch(e => logger.error("Failed to load a custom sound file:", e));
                } else if (o.selectedSound === "regular") {
                    if (o.id !== name) src = load(o.id);
                } else if (o.selectedSound !== "default") {
                    src = load(o.selectedSound) ?? seasonalUrls.get(o.selectedSound);
                }
                if (src) {
                    player.__csDefaultSrc = load(name);
                    return src;
                }
            }
        } catch (e) {
            logger.error("Failed to resolve sound override:", e);
        }

        try {
            return req(`./${name}.${ext}`);
        } catch (e) {
            const url = seasonalUrls.get(name);
            if (url) return url;
            throw e;
        }
    },

    modifyVolume(player: AudioPlayer, audio: HTMLAudioElement, outputVolume: number, vanillaVolume: number): number {
        try {
            const base = playerBaseVolume(player);
            // Sounds that fade in (vibing_wumpus) start at 0, which would make the preview silent
            if (player.__csPreviewVolume == null && base > 0 && typeof player.name === "string" && !isUrl(player.name))
                lastBaseVolume.set(player.__csOriginalName ?? player.name, base);
            const pct = this.getVolumeOverride(player);
            if (pct != null) {
                const effective = effectiveVolume(pct, outputVolume, base);
                applyBoost(audio, effective, getPlayerSinkId(player));
                return Math.min(1, effective);
            }
        } catch (e) {
            logger.error("Failed to apply volume override:", e);
        }
        return vanillaVolume;
    },

    setVolume(player: AudioPlayer, volume: number): boolean {
        try {
            const pct = this.getVolumeOverride(player);
            if (pct == null) {
                player._audio?.then(audio => applyBoost(audio, 1, getPlayerSinkId(player))).catch(() => { });
                return false;
            }
            player._volume = volume;
            // The startup sound is created before files are cached, so creating _audio here would lock in the default sound
            if (!player._audio) return true;
            player._audio
                .then(audio => applyElementVolume(audio, pct, MediaEngineStore.getOutputVolume(), getPlayerSinkId(player), playerBaseVolume(player)))
                .catch(() => { });
            return true;
        } catch (e) {
            logger.error("Failed to apply volume override:", e);
            return false;
        }
    },

    safeSetSinkId(audio: HTMLAudioElement, sinkId: string): Promise<void> {
        return audio.setSinkId?.(sinkId).catch(() => { }) ?? Promise.resolve();
    },

    cleanupBoost: clearBoost,

    handleAudioError(player: AudioPlayer, audio: HTMLAudioElement & { __csTriedFallback?: boolean; }): boolean {
        try {
            if (audio.__csTriedFallback) return false;
            if (player.__csDefaultSrc) {
                audio.__csTriedFallback = true;
                logger.warn(`Override for "${player.name}" failed to load, falling back to the default sound`);
                audio.src = player.__csDefaultSrc;
                audio.load();
                return true;
            }
            logger.warn(`Sound "${player.name}" failed to load and has no fallback. src: ${audio.currentSrc || audio.src}`);
            if (player.__csPreviewVolume != null) showToast({ text: "Failed to load this sound", variant: "critical" });
            return false;
        } catch (e) {
            logger.error("Failed to handle a sound load error:", e);
            return false;
        }
    },

    async start() {
        migrateLegacySettings();
        running = true;
        const healthDelays = [15000, 30000, 60000, 120000];
        let healthAttempt = 0;
        const runHealthCheck = () => {
            const health = probePatched();
            if (health === null) {
                if (++healthAttempt < healthDelays.length) {
                    healthCheckTimer = setTimeout(runHealthCheck, healthDelays[healthAttempt]);
                    return;
                }
                startupHealth = "reverted";
                logger.warn("Failed to find Discord's sound class, so none of the patches applied");
                showToast({ text: BROKEN_TOAST, variant: "critical", duration: 10000 });
                return;
            }
            startupHealth = health;
            if (health === "reverted") logger.warn("Patch group is inactive. Look for \"Undoing patch group\" in the startup logs to see which patch broke");
            else if (health === "init-throws") logger.warn("Constructing WebAudioSound throws, so the constructor patch is broken");
            else if (health === "no-volume") logger.warn("The volume patch didn't apply, so volume overrides won't work");
            else if (health === "no-init") logger.warn("The constructor patch didn't apply, so overrides may not work while a sound pack is active");
            if (HEALTH_MESSAGES[health]) showToast({ text: BROKEN_TOAST, variant: "critical", duration: 10000 });
        };
        healthCheckTimer = setTimeout(runHealthCheck, healthDelays[0]);

        const migrated = await migrateLegacy();
        backfillFileNames({}, true);

        const enabledCustom = soundTypes
            .map(t => ({ id: t.id, o: getOverride(t.id) }))
            .filter(({ o }) => o.enabled && o.selectedSound === "custom" && o.selectedFileId);
        const wanted = [...new Set(enabledCustom.map(({ o }) => o.selectedFileId!))];
        const loaded = await Promise.all(wanted.map(id => loadFileUrl(id).catch(e => logger.error("Failed to preload a custom sound:", e))));

        const missingSounds = enabledCustom
            .filter(({ o }) => loaded[wanted.indexOf(o.selectedFileId!)] === null && !unmoved.has(o.selectedFileId!))
            .map(({ id, o }) => withFileName(soundName(id), o.selectedFileName ?? cleanName(legacyNames.get(o.selectedFileId!))));
        if (missingSounds.length)
            logger.info(`No file on this device for ${pluralise(missingSounds.length, "sound")}, Discord plays its own sound instead:`, missingSounds.join(", "));
        if (!migrated)
            migrationNoticeTimer = setTimeout(async () => {
                if (!await migrateLegacy())
                    showToast({ text: "CustomSounds: files not moved. Don't clear Discord's data.", variant: "critical", duration: 10000 });
            }, healthDelays[0]);
    },

    stop() {
        running = false;
        startupHealth = null;
        clearTimeout(healthCheckTimer);
        clearTimeout(migrationNoticeTimer);
        // Vencord never calls stop() on plugins with patches, this is only here in case that changes
        revokeFileUrls();
    }
});
