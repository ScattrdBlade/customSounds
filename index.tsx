/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { Devs } from "@utils/constants";
import { Margins } from "@utils/margins";
import { useForceUpdater } from "@utils/react";
import definePlugin, { makeRange, OptionType, StartAt } from "@utils/types";
import { React, Select, showToast, Slider } from "@webpack/common";

import { applyBoost, applyElementVolume, AudioPlayer, clearBoost, dataUriCache, deleteAudio, effectiveVolume, ensureDataURICached, ExportedAudioFile, getAllAudio, getAudioMeta, getOutputVolume, getPlayerSinkId, importAudio, isUrl, playAudio as playSound, PreviewHandle, saveAudio, seasonalUrls } from "./audio";
import { makeEmptyOverride, SoundOverride, SoundType, soundTypes } from "./types";

const cap = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

function getOverride(id: string): SoundOverride {
    const stored = settings.store[id];
    if (!stored) return makeEmptyOverride();
    if (typeof stored === "object") return stored;
    try { return JSON.parse(stored); } catch { return makeEmptyOverride(); }
}

function setOverride(id: string, o: SoundOverride) { settings.store[id] = JSON.stringify(o); }

async function cacheCustom(id: string | undefined) {
    if (!id) return;
    try {
        if (!await ensureDataURICached(id)) showToast("Custom sound file could not be loaded");
    } catch { showToast("Custom sound load error"); }
}

const soundSettings = Object.fromEntries(soundTypes.map(t => [t.id, { type: OptionType.STRING, description: `Override for ${t.name}`, default: JSON.stringify(makeEmptyOverride()), hidden: true }]));
const settings = definePluginSettings({ ...soundSettings, overrides: { type: OptionType.COMPONENT, description: "", component: () => <SettingsUI /> } });

function SoundCard({ type, override, files, onFilesChange, onFileDeleted, onChange }: { type: SoundType; override: SoundOverride; files: Record<string, string>; onFilesChange: () => Promise<void>; onFileDeleted: (id: string) => void; onChange: () => Promise<void>; }) {
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const update = useForceUpdater();
    const sound = React.useRef<PreviewHandle | null>(null);
    const saveAndNotify = async () => { await onChange(); update(); };

    React.useEffect(() => () => sound.current?.stop(), []);

    const previewSound = async () => {
        sound.current?.stop();
        if (!override.enabled) { sound.current = playSound(type.id); return; }
        const { selectedSound, volume, selectedFileId } = override;
        if (selectedSound === "custom") {
            if (!selectedFileId) { showToast("No custom sound file selected"); return; }
            const dataUri = await ensureDataURICached(selectedFileId);
            if (!dataUri?.startsWith("data:")) { showToast("No custom sound file available"); return; }
            sound.current = playSound(dataUri, { volume });
        } else sound.current = playSound(selectedSound === "default" ? type.id : selectedSound, { volume });
    };

    const uploadFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        try {
            showToast("Uploading file...");
            const id = await saveAudio(file);
            await onFilesChange();
            override.selectedFileId = id;
            override.selectedSound = "custom";
            await ensureDataURICached(id);
            await saveAndNotify();
            showToast(`Uploaded: ${file.name}`);
        } catch (e) { console.error("[CustomSounds] Upload failed:", e); showToast(`Upload failed: ${e}`); }
    };

    const deleteFile = async (id: string) => {
        try {
            await deleteAudio(id);
            await onFilesChange();
            onFileDeleted(id);
            showToast("File deleted");
        } catch (e) { console.error("[CustomSounds] Delete failed:", e); showToast("Delete failed"); }
    };

    const fileOpts = Object.entries(files).filter(([id, name]) => !!id && !!name).map(([id, name]) => ({ value: id, label: name }));
    const sourceOpts = [{ value: "default", label: "Default" }, ...Object.keys(type.seasonal ?? {}).map(id => ({ value: id, label: cap(id) })), { value: "custom", label: "Custom" }];

    return (
        <Card style={{ padding: "1em 1em 0" }}>
            <FormSwitch title={type.name} value={override.enabled || false} className={Margins.bottom16} hideBorder onChange={async val => { override.enabled = val; if (val && override.selectedSound === "custom") await cacheCustom(override.selectedFileId); await saveAndNotify(); }} />
            {override.enabled && <>
                <Button className={Margins.bottom16} variant="positive" onClick={previewSound}>Preview</Button>
                <Heading className={Margins.bottom8}>Volume</Heading>
                <Slider minValue={0} maxValue={500} markers={makeRange(0, 500, 50)} initialValue={override.volume} onValueRender={(v: number) => `${Math.round(v)}%`} className={Margins.bottom16} onValueChange={val => { override.volume = val; setOverride(type.id, override); if (sound.current) sound.current.volume = val; saveAndNotify(); }} />
                <Heading className={Margins.bottom8}>Sound Source</Heading>
                <div style={{ marginBottom: 16 }}>
                    <Select closeOnSelect serialize={v => v} isSelected={v => v === override.selectedSound} options={sourceOpts} select={async v => { override.selectedSound = v; if (v === "custom") await cacheCustom(override.selectedFileId); await saveAndNotify(); }} />
                </div>
                {override.selectedSound === "custom" && <>
                    <Heading className={Margins.bottom8}>Custom File</Heading>
                    <div style={{ marginBottom: 16 }}>
                        <Select closeOnSelect serialize={v => v} isSelected={v => v === (override.selectedFileId || "")} options={[{ value: "", label: "Select a file..." }, ...fileOpts]} select={async id => { override.selectedFileId = id || undefined; if (id) await ensureDataURICached(id); await saveAndNotify(); }} />
                    </div>
                    <input ref={fileInputRef} type="file" accept=".mp3,.wav,.ogg,.m4a,.flac,.aac,.webm,.wma,.mp4" style={{ display: "none" }} onChange={uploadFile} />
                    <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                        <Button onClick={() => fileInputRef.current?.click()} variant="primary">Upload New</Button>
                        {override.selectedFileId && files[override.selectedFileId] && <Button variant="dangerPrimary" onClick={() => deleteFile(override.selectedFileId!)}>Delete Selected File</Button>}
                    </div>
                </>}
            </>}
        </Card>
    );
}

function SettingsUI() {
    const [resetTrigger, setResetTrigger] = React.useState(0);
    const [files, setFiles] = React.useState<Record<string, string>>({});
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    const loadFiles = React.useCallback(async () => {
        try {
            const meta = await getAudioMeta();
            setFiles(meta);
            let healed = false;
            for (const t of soundTypes) {
                const o = getOverride(t.id);
                if (o.selectedSound === "custom" && o.selectedFileId && !meta[o.selectedFileId]) {
                    o.selectedFileId = undefined;
                    o.selectedSound = "default";
                    setOverride(t.id, o);
                    healed = true;
                }
            }
            if (healed) setResetTrigger(t => t + 1);
        } catch (e) { console.error("[CustomSounds]", e); }
    }, []);

    React.useEffect(() => {
        soundTypes.forEach(t => { if (!settings.store[t.id]) setOverride(t.id, makeEmptyOverride()); });
        loadFiles();
    }, []);

    const resetOverrides = () => {
        soundTypes.forEach(t => setOverride(t.id, makeEmptyOverride()));
        dataUriCache.clear();
        setResetTrigger(t => t + 1);
        showToast("All overrides reset!");
    };

    const handleFileDeleted = React.useCallback((id: string) => {
        for (const t of soundTypes) {
            const o = getOverride(t.id);
            if (o.selectedFileId === id) {
                o.selectedFileId = undefined;
                o.selectedSound = "default";
                setOverride(t.id, o);
            }
        }
        setResetTrigger(t => t + 1);
    }, []);

    const handleSettingsUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async ev => {
            try {
                const imp = JSON.parse(ev.target?.result as string);
                if (!imp || typeof imp !== "object" || (!Array.isArray(imp.overrides) && !Array.isArray(imp.files)))
                    throw new Error("Not a CustomSounds settings export");
                resetOverrides();
                const remap: Record<string, string> = {};
                let n = 0;
                for (const fd of imp.files ?? []) {
                    if (!fd?.dataUri || !fd?.name) continue;
                    const newId = await importAudio({ id: fd.id ?? "", name: fd.name, type: fd.type ?? "audio/mpeg", dataUri: fd.dataUri }).catch(() => null);
                    if (newId) { if (fd.id) remap[fd.id] = newId; await ensureDataURICached(newId); n++; }
                }
                if (n) await loadFiles();
                const validIds = new Set(soundTypes.map(t => t.id));
                for (const s of imp.overrides ?? []) {
                    if (!s?.id || !validIds.has(s.id)) continue;
                    setOverride(s.id, {
                        enabled: s.enabled === true,
                        selectedSound: typeof s.selectedSound === "string" ? s.selectedSound : "default",
                        selectedFileId: typeof s.selectedFileId === "string" && s.selectedFileId ? (remap[s.selectedFileId] ?? s.selectedFileId) : undefined,
                        volume: typeof s.volume === "number" && isFinite(s.volume) ? Math.max(0, Math.min(500, s.volume)) : 100
                    });
                }
                setResetTrigger(t => t + 1);
                showToast(`Imported ${imp.overrides?.length ?? 0} setting(s) and ${n} file(s)`);
            } catch (er) { console.error("[CustomSounds] Import error:", er); showToast("Import failed. Check console."); }
        };
        reader.readAsText(file);
    };

    const downloadSettings = async () => {
        const overrides = soundTypes.map(t => { const o = getOverride(t.id); return { id: t.id, enabled: o.enabled, selectedSound: o.selectedSound, selectedFileId: o.selectedFileId, volume: o.volume }; }).filter(o => o.enabled || o.selectedSound !== "default");
        const refs = new Set(overrides.map(o => o.selectedFileId).filter(Boolean) as string[]);
        const all = await getAllAudio();
        const bundled: ExportedAudioFile[] = [...refs].map(id => all[id]).filter(f => f?.dataUri).map(f => ({ id: f.id, name: f.name, type: f.type, dataUri: f.dataUri }));
        const blob = new Blob([JSON.stringify({ overrides, files: bundled }, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "customSounds-settings.json"; a.click();
        URL.revokeObjectURL(url);
        showToast(`Exported ${overrides.length} setting(s) and ${bundled.length} file(s)`);
    };

    return (
        <div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                <Button variant="primary" onClick={() => fileInputRef.current?.click()}>Import</Button>
                <Button variant="secondary" onClick={downloadSettings}>Export</Button>
                <Button variant="dangerPrimary" onClick={resetOverrides}>Reset All</Button>
                <input ref={fileInputRef} type="file" accept=".json" style={{ display: "none" }} onChange={handleSettingsUpload} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {soundTypes.map(type => {
                    const o = getOverride(type.id);
                    return <SoundCard key={`${type.id}-${resetTrigger}`} type={type} override={o} files={files} onFilesChange={loadFiles} onFileDeleted={handleFileDeleted} onChange={async () => { setOverride(type.id, o); if (o.enabled && o.selectedSound === "custom") await cacheCustom(o.selectedFileId); }} />;
                })}
            </div>
        </div>
    );
}

export default definePlugin({
    name: "CustomSounds",
    description: "Customize Discord's sounds.",
    authors: [Devs.ScattrdBlade, Devs.TheKodeToad],
    settings,
    startAt: StartAt.Init,

    patches: [
        {
            find: "could not play audio:",
            group: true,
            replacement: [
                {
                    match: /(constructor\(\i,\i,\i,[^)]*\)\{)/,
                    replace: "$1$self.initPlayer(this,arguments);"
                },
                {
                    match: /(new Audio;)(\i)(\.src=)/,
                    replace: '$1$2.crossOrigin="anonymous";$2$3'
                },
                {
                    match: /(\i\.src=)(\i\(\d+\))\(`\.\/\$\{this\.name\}\.mp3`\)/,
                    replace: "$1$self.resolveSrc(this,$2)"
                },
                {
                    match: /(\i)\.volume=(.{0,120}?Math\.min\((\i\.\i\.getOutputVolume\(\))\/100\*this\._volume,1\))/,
                    replace: "$1.volume=$self.modifyVolume(this,$1,$3,$2)"
                },
                {
                    match: /set volume\((\i)\)\{this\._volume=\1,this\.ensureAudio\(\)\.then\((\i)=>\2\.volume=\1\)\}/,
                    replace: "set volume($1){$self.setVolume(this,$1)}"
                },
                {
                    match: /(this\._audio\.then\((\i)=>\{)(?=\2\.onerror=null)/,
                    replace: "$1$self.cleanupBoost($2),"
                },
                {
                    match: /((\i)\.onerror=\(\)=>\{)(?=let)/,
                    replace: "$1if($self.handleAudioError(this,$2))return;"
                }
            ]
        }
    ],

    initPlayer(player: AudioPlayer, args: IArguments) {
        player.__customSoundsPatched = true;
        if (typeof args[1] === "string") player.__csOriginalName = args[1];
    },

    findOverrideKey(player: AudioPlayer): string | null {
        const { name } = player;
        if (typeof name !== "string" || isUrl(name)) return null;
        if (getOverride(name).enabled) return name;
        const orig = player.__csOriginalName;
        if (orig && orig !== name && getOverride(orig).enabled) return orig;
        return null;
    },

    getVolumeOverride(player: AudioPlayer): number | null {
        if (player.__csPreviewVolume != null) return player.__csPreviewVolume;
        const key = this.findOverrideKey(player);
        return key ? getOverride(key).volume : null;
    },

    resolveSrc(player: AudioPlayer, req: (path: string) => string): string {
        const { name } = player;
        player.__csDefaultSrc = undefined;
        if (isUrl(name)) return name;
        try {
            const key = this.findOverrideKey(player);
            if (key) {
                const o = getOverride(key);
                let src: string | undefined;
                if (o.selectedSound === "custom") {
                    src = (o.selectedFileId && dataUriCache.get(o.selectedFileId)) || undefined;
                    if (!src && o.selectedFileId) ensureDataURICached(o.selectedFileId).catch(() => { });
                } else if (o.selectedSound !== "default") {
                    try { src = req(`./${o.selectedSound}.mp3`); } catch { }
                    src ??= seasonalUrls[o.selectedSound];
                }
                if (src) {
                    try { player.__csDefaultSrc = req(`./${name}.mp3`); } catch { }
                    return src;
                }
            }
        } catch (e) { console.error("[CustomSounds] Failed to resolve sound override:", e); }
        return req(`./${name}.mp3`);
    },

    modifyVolume(player: AudioPlayer, el: HTMLAudioElement, outputVolume: number, vanillaVolume: number): number {
        try {
            const pct = this.getVolumeOverride(player);
            if (pct != null) {
                const effective = effectiveVolume(pct, outputVolume);
                applyBoost(el, effective, getPlayerSinkId(player));
                return Math.min(1, effective);
            }
        } catch (e) { console.error("[CustomSounds] Failed to apply volume override:", e); }
        return vanillaVolume;
    },

    setVolume(player: AudioPlayer, volume: number) {
        player._volume = volume;
        player.ensureAudio().then(el => {
            const pct = this.getVolumeOverride(player);
            if (pct != null) applyElementVolume(el, pct, getOutputVolume(), getPlayerSinkId(player));
            else el.volume = Math.min(1, Math.max(0, volume));
        }).catch(() => { });
    },

    handleAudioError(player: AudioPlayer, el: HTMLAudioElement & { __csTriedFallback?: boolean; }): boolean {
        try {
            if (el.__csTriedFallback || !player.__csDefaultSrc) return false;
            el.__csTriedFallback = true;
            console.warn(`[CustomSounds] Override for "${player.name}" failed to load; falling back to the default sound.`);
            el.src = player.__csDefaultSrc;
            el.load();
            return true;
        } catch { return false; }
    },

    cleanupBoost(el: HTMLAudioElement) { clearBoost(el); },

    async start() {
        for (const t of soundTypes) {
            const o = getOverride(t.id);
            if (o?.enabled && o.selectedSound === "custom" && o.selectedFileId) {
                try { await ensureDataURICached(o.selectedFileId); } catch (e) { console.error("[CustomSounds]", e); }
            }
        }
    },

    stop() {
        dataUriCache.clear();
    }
});
