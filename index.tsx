/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { get as getFromDataStore } from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Heading } from "@components/Heading";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { Button, React, showToast, TextInput } from "@webpack/common";

import {
    addAudioProcessor,
    AudioPlayerInternal,
    AudioPlayerOptions,
    AudioProcessor,
    audioProcessorFunctions,
    AudioType,
    identifyAudioType,
    playAudio,
    PreprocessAudioData,
    removeAudioProcessor
} from "./audioPlayerApi";
import { ExportedAudioFile, getAllAudio, getAudioDataURI, importAudio, migrateAudioStore, migrateToHashIds, StoredAudioFile } from "./audioStore";
import { SoundOverrideComponent } from "./SoundOverrideComponent";
import { makeEmptyOverride, seasonalSounds, SoundOverride, soundTypes } from "./types";

const cl = classNameFactory("vc-custom-sounds-");

const allSoundTypes = soundTypes || [];

const AUDIO_STORE_KEY = "ScattrdCustomSounds";
const PROCESSOR_KEY = "CustomSounds";

const dataUriCache = new Map<string, string>();

interface PlayerAudioState {
    audio: HTMLAudioElement;
    source: MediaElementAudioSourceNode;
    gainNode: GainNode;
}
const playerStates = new WeakMap<AudioPlayerInternal, PlayerAudioState>();
let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
    if (!sharedAudioContext) {
        try {
            sharedAudioContext = new AudioContext();
        } catch (err) {
            console.error("[CustomSounds] Failed to create AudioContext:", err);
            return null;
        }
    }
    if (sharedAudioContext.state === "suspended") {
        sharedAudioContext.resume().catch(() => { });
    }
    return sharedAudioContext;
}

function getOverride(id: string): SoundOverride {
    const stored = settings.store[id];
    if (!stored) return makeEmptyOverride();

    if (typeof stored === "object") return stored;

    try {
        return JSON.parse(stored);
    } catch {
        return makeEmptyOverride();
    }
}

function setOverride(id: string, override: SoundOverride) {
    settings.store[id] = JSON.stringify(override);
}

function migrateBoostIntoVolume() {
    let changed = 0;
    for (const id of Object.keys(settings.store)) {
        if (id === "overrides") continue;
        const stored = settings.store[id];
        if (!stored) continue;

        let parsed: any;
        if (typeof stored === "object") {
            parsed = stored;
        } else {
            try { parsed = JSON.parse(stored); } catch { continue; }
        }

        if (!parsed || typeof parsed !== "object") continue;
        if (!("boost" in parsed)) continue;

        const boost = typeof parsed.boost === "number" ? parsed.boost : 1;
        if (boost > 1) {
            parsed.volume = (parsed.volume ?? 100) * boost;
        }
        delete parsed.boost;
        settings.store[id] = JSON.stringify(parsed);
        changed++;
    }
    if (changed) console.log(`[CustomSounds] Migrated boost → volume on ${changed} entries`);
}

export const getCustomSoundURL: AudioProcessor = (data: PreprocessAudioData) => {
    let audioOverride = data.audio;

    if (data.audio in seasonalSounds) {
        audioOverride = soundTypes.find(sound => sound.seasonal?.includes(data.audio))?.id || data.audio;
    }

    const override = getOverride(audioOverride);

    if (!override?.enabled) return;

    data.speed = override.speed ?? 1;

    if (override.selectedSound === "custom" && override.selectedFileId) {
        const dataUri = dataUriCache.get(override.selectedFileId);
        if (dataUri) {
            data.audio = dataUri;
            data.volume = override.volume;
        }
        return;
    }

    if (override.selectedSound !== "default" && override.selectedSound !== "custom") {
        if (override.selectedSound in seasonalSounds) {
            data.audio = seasonalSounds[override.selectedSound];
            data.volume = override.volume;
            return;
        }

        const soundType = allSoundTypes.find(t => t.id === data.audio);

        if (soundType?.seasonal) {
            const seasonalId = soundType.seasonal.find(seasonalId =>
                seasonalId.startsWith(`${override.selectedSound}_`)
            );

            if (seasonalId && seasonalId in seasonalSounds) {
                data.audio = seasonalSounds[seasonalId];
                data.volume = override.volume;
                return;
            }
        }
    }

    data.volume = override.volume;
};

export async function ensureDataURICached(fileId: string): Promise<string | null> {
    if (dataUriCache.has(fileId)) return dataUriCache.get(fileId)!;

    try {
        const dataUri = await getAudioDataURI(fileId);
        if (dataUri) {
            dataUriCache.set(fileId, dataUri);
            console.log(`[CustomSounds] Cached data URI for file ${fileId}`);
            return dataUri;
        }
    } catch (error) {
        console.error(`[CustomSounds] Error generating data URI for ${fileId}:`, error);
    }

    return null;
}

async function preloadDataURIs() {
    for (const soundType of allSoundTypes) {
        const override = getOverride(soundType.id);
        if (override?.enabled && override.selectedSound === "custom" && override.selectedFileId) {
            try {
                await ensureDataURICached(override.selectedFileId);
            } catch (error) {
                console.error(`[CustomSounds] Failed to preload data URI for ${soundType.id}:`, error);
            }
        }
    }
    console.log(`[CustomSounds] Memory cache contains ${dataUriCache.size} data URIs`);
}

export async function debugCustomSounds() {
    console.log("[CustomSounds] === DEBUG INFO ===");

    const rawDataStore = await getFromDataStore(AUDIO_STORE_KEY);
    console.log("[CustomSounds] Raw DataStore content:", rawDataStore);

    const allFiles = await getAllAudio();
    console.log(`[CustomSounds] Stored files: ${Object.keys(allFiles).length}`);

    let totalBufferSize = 0;
    let totalDataUriSize = 0;

    for (const [id, file] of Object.entries(allFiles)) {
        const bufferSize = file.buffer?.byteLength || 0;
        const dataUriSize = file.dataUri?.length || 0;
        totalBufferSize += bufferSize;
        totalDataUriSize += dataUriSize;

        console.log(`[CustomSounds] File ${id}:`, {
            name: file.name,
            type: file.type,
            bufferSize: `${(bufferSize / 1024).toFixed(1)}KB`,
            hasValidBuffer: file.buffer instanceof ArrayBuffer,
            hasDataUri: !!file.dataUri,
            dataUriSize: `${(dataUriSize / 1024).toFixed(1)}KB`
        });
    }

    console.log(`[CustomSounds] Total storage - Buffers: ${(totalBufferSize / 1024).toFixed(1)}KB, DataURIs: ${(totalDataUriSize / 1024).toFixed(1)}KB`);
    console.log(`[CustomSounds] Memory cache contains ${dataUriCache.size} data URIs`);
    console.log("[CustomSounds] Settings store structure:", Object.keys(settings.store));
    console.log("[CustomSounds] Sound override status:");

    let enabledCount = 0;
    let totalSettingsSize = 0;

    for (const [soundId] of Object.entries(settings.store)) {
        if (soundId === "overrides") continue;

        const override = getOverride(soundId);
        const settingsSize = JSON.stringify(override).length;
        totalSettingsSize += settingsSize;

        console.log(`[CustomSounds] ${soundId}:`, {
            enabled: override.enabled,
            selectedSound: override.selectedSound,
            selectedFileId: override.selectedFileId,
            volume: override.volume,
            settingsSize: `${settingsSize}B`
        });

        if (override.enabled) enabledCount++;
    }

    console.log(`[CustomSounds] Total enabled overrides: ${enabledCount}`);
    console.log(`[CustomSounds] Estimated settings size: ${(totalSettingsSize / 1024).toFixed(1)}KB`);
    console.log("[CustomSounds] === END DEBUG ===");
}

const soundSettings = Object.fromEntries(
    allSoundTypes.map(type => [
        type.id,
        {
            type: OptionType.STRING,
            description: `Override for ${type.name}`,
            default: JSON.stringify(makeEmptyOverride()),
            hidden: true
        }
    ])
);

const settings = definePluginSettings({
    ...soundSettings,
    overrides: {
        type: OptionType.COMPONENT,
        description: "",
        component: () => {
            const [resetTrigger, setResetTrigger] = React.useState(0);
            const [searchQuery, setSearchQuery] = React.useState("");
            const [files, setFiles] = React.useState<Record<string, StoredAudioFile>>({});
            const fileInputRef = React.useRef<HTMLInputElement>(null);

            const loadFiles = React.useCallback(async () => {
                try {
                    const all = await getAllAudio();
                    setFiles(all);
                } catch (error) {
                    console.error("[CustomSounds] Failed to load audio files:", error);
                }
            }, []);

            React.useEffect(() => {
                allSoundTypes.forEach(type => {
                    if (!settings.store[type.id]) {
                        setOverride(type.id, makeEmptyOverride());
                    }
                });
                loadFiles();
            }, []);

            const resetOverrides = () => {
                allSoundTypes.forEach(type => {
                    setOverride(type.id, makeEmptyOverride());
                });
                dataUriCache.clear();
                setResetTrigger(prev => prev + 1);
                showToast("All overrides reset successfully!");
            };

            const triggerFileUpload = () => {
                fileInputRef.current?.click();
            };

            const handleSettingsUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
                const file = event.target.files?.[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = async (e: ProgressEvent<FileReader>) => {
                        try {
                            resetOverrides();
                            const imported = JSON.parse(e.target?.result as string);

                            const idRemap: Record<string, string> = {};
                            let importedFileCount = 0;
                            const importedFiles = Array.isArray(imported.files)
                                ? imported.files
                                : (imported.files && typeof imported.files === "object"
                                    ? Object.values(imported.files)
                                    : []);

                            for (const fd of importedFiles) {
                                if (!fd || typeof fd !== "object") continue;
                                if (!fd.dataUri || !fd.name) continue;
                                try {
                                    const newId = await importAudio({
                                        id: fd.id ?? "",
                                        name: fd.name,
                                        type: fd.type ?? "audio/mpeg",
                                        dataUri: fd.dataUri
                                    });
                                    if (newId) {
                                        if (fd.id) idRemap[fd.id] = newId;
                                        await ensureDataURICached(newId);
                                        importedFileCount++;
                                    }
                                } catch (err) {
                                    console.error(`[CustomSounds] Failed to import file ${fd?.id ?? "?"}:`, err);
                                }
                            }
                            if (importedFileCount > 0) await loadFiles();

                            if (imported.overrides && Array.isArray(imported.overrides)) {
                                imported.overrides.forEach((setting: any) => {
                                    if (setting.id) {
                                        const importedVolume = setting.volume ?? 100;
                                        const legacyBoost = typeof setting.boost === "number" && setting.boost > 1 ? setting.boost : 1;
                                        const remappedFileId = setting.selectedFileId
                                            ? (idRemap[setting.selectedFileId] ?? setting.selectedFileId)
                                            : undefined;
                                        const override: SoundOverride = {
                                            enabled: setting.enabled ?? false,
                                            selectedSound: setting.selectedSound ?? "default",
                                            selectedFileId: remappedFileId,
                                            volume: importedVolume * legacyBoost,
                                            speed: setting.speed ?? 1
                                        };
                                        setOverride(setting.id, override);
                                    }
                                });
                            }

                            setResetTrigger(prev => prev + 1);
                            showToast(`Imported ${imported.overrides?.length ?? 0} setting(s) and ${importedFileCount} audio file(s)`);
                        } catch (error) {
                            console.error("Error importing settings:", error);
                            showToast("Error importing settings. Check console for details.");
                        }
                    };

                    reader.readAsText(file);
                    event.target.value = "";
                }
            };

            const downloadSettings = async () => {
                const overrides = allSoundTypes.map(type => {
                    const override = getOverride(type.id);
                    return {
                        id: type.id,
                        enabled: override.enabled,
                        selectedSound: override.selectedSound,
                        selectedFileId: override.selectedFileId ?? undefined,
                        volume: override.volume,
                        speed: override.speed ?? 1
                    };
                }).filter(o => o.enabled || o.selectedSound !== "default");

                const referencedFileIds = new Set<string>();
                for (const o of overrides) {
                    if (o.selectedFileId) referencedFileIds.add(o.selectedFileId);
                }
                const allAudio = await getAllAudio();
                const bundledFiles: ExportedAudioFile[] = [];
                for (const fileId of referencedFileIds) {
                    const file = allAudio[fileId];
                    if (file?.dataUri) {
                        bundledFiles.push({
                            id: fileId,
                            name: file.name,
                            type: file.type,
                            dataUri: file.dataUri
                        });
                    }
                }

                const exportPayload = {
                    overrides,
                    files: bundledFiles
                };

                const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "customSounds-settings.json";
                a.click();
                URL.revokeObjectURL(url);

                showToast(`Exported ${overrides.length} setting(s) and ${bundledFiles.length} audio file(s)`);
            };

            const filteredSoundTypes = allSoundTypes.filter(type =>
                type.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                type.id.toLowerCase().includes(searchQuery.toLowerCase())
            );

            return (
                <div>
                    <div className="vc-custom-sounds-buttons">
                        <Button color={Button.Colors.BRAND} onClick={triggerFileUpload}>Import</Button>
                        <Button color={Button.Colors.PRIMARY} onClick={downloadSettings}>Export</Button>
                        <Button color={Button.Colors.RED} onClick={resetOverrides}>Reset All</Button>
                        <Button color={Button.Colors.WHITE} onClick={debugCustomSounds}>Debug</Button>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".json"
                            style={{ display: "none" }}
                            onChange={handleSettingsUpload}
                        />
                    </div>

                    <div className={cl("search")}>
                        <Heading>Search Sounds</Heading>
                        <TextInput
                            value={searchQuery}
                            onChange={e => setSearchQuery(e)}
                            placeholder="Search by name or ID"
                        />
                    </div>

                    <div className={cl("sounds-list")}>
                        {filteredSoundTypes.map(type => {
                            const currentOverride = getOverride(type.id);

                            return (
                                <SoundOverrideComponent
                                    key={`${type.id}-${resetTrigger}`}
                                    type={type}
                                    override={currentOverride}
                                    files={files}
                                    onFilesChange={loadFiles}
                                    onChange={async () => {
                                        setOverride(type.id, currentOverride);

                                        if (currentOverride.enabled && currentOverride.selectedSound === "custom" && currentOverride.selectedFileId) {
                                            try {
                                                await ensureDataURICached(currentOverride.selectedFileId);
                                            } catch (error) {
                                                console.error(`[CustomSounds] Failed to cache data URI for ${type.id}:`, error);
                                                showToast("Error loading custom sound file");
                                            }
                                        }
                                    }}
                                />
                            );
                        })}
                    </div>
                </div>
            );
        }
    }
});

export default definePlugin({
    name: "CustomSounds",
    description: "Customize Discord's sounds.",
    authors: [Devs.ScattrdBlade, Devs.TheKodeToad],
    settings,
    startAt: StartAt.Init,

    AudioType,
    playAudio,
    getCustomSoundURL,
    ensureDataURICached,
    debugCustomSounds,

    patches: [
        {
            find: "could not play audio",
            group: true,
            replacement: [
                {
                    // Use the audio as-is if external; otherwise fall through to the internal Discord lookup.
                    // Force-loads the internal sounds module so the second patch group's discodo handling works.
                    match: /(let \i=class.{0,900}?new Audio;\i.src=)((\i\(\d+\))(?:\(`\.\/\$\{|.{0,50}concat\())this.name((?:\}\.mp3`|,".mp3"\))\))/,
                    replace: "$3;$1this.type!==$self.AudioType.DISCORD?this.audio:$2this.audio$4"
                },
                {
                    // Set crossOrigin="anonymous" before src so Web Audio (used by applyBoost) can read
                    // PCM from cross-origin sources like canary.discord.com seasonal sounds.
                    match: /(new Audio;)(\i)(\.src=)/,
                    replace: "$1$2.crossOrigin=\"anonymous\";$2$3"
                },
                {
                    // Inject options + delegate to $self.buildPlayer in the constructor.
                    match: /(?<=constructor\((\i,\i,\i,\i)).{0,200}outputChannel=\i/,
                    replace: ",options){$self.buildPlayer(this,$1,options);"
                },
                {
                    // Prevent error from cleared src during destroyAudio().
                    match: /(\i.pause\(\),(\i).src="".{0,20}?null)/,
                    replace: "$2.onerror=()=>{},$1"
                },
                {
                    // Apply playback rate + boost gain from options on load.
                    match: /(?<=(\i).onloadeddata=\(\)=>{)/,
                    replace: "$1.playbackRate=this._speed,$self.applyBoost(this),"
                },
                {
                    // Route playback errors through onError if provided.
                    match: /(onerror=\()(\)=>)(\i\(Error\("[^"]+"\)\)),/,
                    replace: "$1error$2{this.onError?.(error);$3;},"
                },
                {
                    // Honor onEnded callback + persist flag when playback ends.
                    match: /(?<=onended=\(\)=>)(.{0,40}?),/,
                    replace: "{$self.stopAudio(this);this.onEnded?.();},"
                },
                {
                    // Respect persist flag in stop().
                    match: /(stop\()(\){)this.destroyAudio\(\)/,
                    replace: "$1restart$2$self.stopAudio(this,restart);"
                },
                {
                    // Replace internal playGiftSound with our playAudio.
                    match: /let \i=new Audio\((\(0,\i.\i\)\(\i\)).{0,35}?play\(\)/,
                    replace: "$self.playAudio($1)"
                }
            ]
        },
        // Discodo startup volume
        {
            find: '"UPDATE_OPEN_ON_STARTUP"',
            group: true,
            replacement: [
                {
                    match: /(?<=discodo",\i)(\);return )\i.volume=1,/,
                    replace: ",1$1"
                },
                {
                    match: /,(this._connectedSound.volume)=1/,
                    replace: ";"
                }
            ]
        }
    ],

    stopAudio(player: AudioPlayerInternal, restart?: boolean) {
        if (restart) {
            player.ensureAudio().then(audio => {
                audio.currentTime = 0;
                audio.play();
            });
        } else if (!player.persistent) {
            player.destroyAudio();
        } else {
            player._audio?.then(audio => {
                audio.pause();
                audio.currentTime = 0;
            });
        }
    },

    processAudio(player: AudioPlayerInternal) {
        player.preprocessDataPrevious = player.preprocessDataCurrent ? structuredClone(player.preprocessDataCurrent) : null;
        player.preprocessDataCurrent = structuredClone(player.preprocessDataOriginal);
        player.preprocessDataCurrent.volume *= 100;

        for (const processor of Object.values(audioProcessorFunctions)) {
            processor(player.preprocessDataCurrent);
        }

        player.preprocessDataCurrent.volume /= 100;
        player.audio = player.preprocessDataCurrent.audio;
        player.type = identifyAudioType(player.preprocessDataCurrent.audio);
        player._volume = Math.max(0, Math.min(1, player.preprocessDataCurrent.volume));
        player._speed = Math.max(0.0625, Math.min(16, player.preprocessDataCurrent.speed));

        if (player.preprocessDataCurrent.audio !== player.preprocessDataPrevious?.audio) {
            player.destroyAudio();
            player.persistent && player.ensureAudio();
        }

        if (player.preprocessDataCurrent.volume !== player.preprocessDataPrevious?.volume) {
            player._audio?.then(audio => {
                audio.volume = player._volume;
            });
            this.applyBoost(player);
        }

        if (player.preprocessDataCurrent.speed !== player.preprocessDataPrevious?.speed) {
            player._audio?.then(audio => {
                audio.playbackRate = player._speed;
            });
        }

        const currentBoost = player.preprocessDataCurrent.boost ?? 1;
        const previousBoost = player.preprocessDataPrevious?.boost ?? 1;
        if (currentBoost !== previousBoost) {
            this.applyBoost(player);
        }
    },

    applyBoost(player: AudioPlayerInternal) {
        if (!player._audio) return;

        const current = player.preprocessDataCurrent;
        const factor = Math.max(1, current?.volume ?? 1, current?.boost ?? 1);

        player._audio.then(audio => {
            let state = playerStates.get(player);

            if (state && state.audio !== audio) {
                try {
                    state.source.disconnect();
                    state.gainNode.disconnect();
                } catch { }
                playerStates.delete(player);
                state = undefined;
            }

            if (!state) {
                if (factor <= 1.001) return;

                const ctx = getAudioContext();
                if (!ctx) return;

                try {
                    const source = ctx.createMediaElementSource(audio);
                    const gainNode = ctx.createGain();
                    source.connect(gainNode);
                    gainNode.connect(ctx.destination);
                    state = { audio, source, gainNode };
                    playerStates.set(player, state);
                } catch (err) {
                    console.error("[CustomSounds] Failed to wrap audio in Web Audio:", err);
                    return;
                }
            }

            state.gainNode.gain.value = Math.max(0, factor);
        }).catch(() => { });
    },

    buildPlayer(
        player: AudioPlayerInternal,
        audio: string,
        _unused: any,
        internalVolume: number,
        channel: string,
        options: AudioPlayerOptions = {}
    ) {
        player.preprocessDataOriginal = {
            audio,
            type: identifyAudioType(audio),
            volume: Math.max(0, (internalVolume || (options.volume ? options.volume / 100 : 1))),
            speed: Math.max(0.0625, Math.min(16, options.speed ?? 1)),
            boost: options.boost ?? 1,
        };

        player.audio = player.preprocessDataOriginal.audio;
        player._audio = null;
        player._volume = player.preprocessDataOriginal.volume;
        player._speed = player.preprocessDataOriginal.speed;
        player.preload = options.preload ?? false;
        player.persistent = options.persistent ?? false;
        player.type = identifyAudioType(audio);
        player.outputChannel = channel;
        player.onEnded = options.onEnded;
        player.onError = options.onError;

        player.processAudio = () => this.processAudio(player);
        player.processAudio();
        player.preload && player.ensureAudio();
    },

    async start() {
        addAudioProcessor(PROCESSOR_KEY, getCustomSoundURL);
        try {
            migrateBoostIntoVolume();
            await migrateAudioStore();

            const remap = await migrateToHashIds();
            if (Object.keys(remap).length > 0) {
                for (const id of Object.keys(settings.store)) {
                    if (id === "overrides") continue;
                    const override = getOverride(id);
                    if (override.selectedFileId && remap[override.selectedFileId]) {
                        override.selectedFileId = remap[override.selectedFileId];
                        setOverride(id, override);
                    }
                }
                console.log("[CustomSounds] Updated selectedFileId references after hash-ID migration.");
            }

            await preloadDataURIs();
        } catch (error) {
            console.error("[CustomSounds] Startup error:", error);
        }
    },

    stop() {
        removeAudioProcessor(PROCESSOR_KEY);
        dataUriCache.clear();
    }
});
