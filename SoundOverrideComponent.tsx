/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Card } from "@components/Card";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { classNameFactory } from "@utils/css";
import { Margins } from "@utils/margins";
import { useForceUpdater } from "@utils/react";
import { makeRange } from "@utils/types";
import { Button, React, Select, showToast, Slider } from "@webpack/common";

import { AudioPlayerInterface, playAudio } from "./audioPlayerApi";
import { deleteAudio, saveAudio, StoredAudioFile } from "./audioStore";
import { ensureDataURICached } from "./index";
import { SoundOverride, SoundType } from "./types";

const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "m4a", "aac", "flac", "webm", "wma", "mp4"];
const cl = classNameFactory("vc-custom-sounds-");

const capitalizeWords = (str: string) =>
    str.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

export function SoundOverrideComponent({ type, override, files, onFilesChange, onChange }: {
    type: SoundType;
    override: SoundOverride;
    files: Record<string, StoredAudioFile>;
    onFilesChange: () => Promise<void>;
    onChange: () => Promise<void>;
}) {
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const update = useForceUpdater();
    const sound = React.useRef<AudioPlayerInterface | null>(null);

    const saveAndNotify = async () => {
        await onChange();
        update();
    };

    const previewSound = async () => {
        sound.current?.stop();

        if (!override.enabled) {
            sound.current = playAudio(type.id);
            return;
        }

        const { selectedSound } = override;
        const speed = override.speed ?? 1;

        if (selectedSound === "custom" && override.selectedFileId) {
            try {
                const dataUri = await ensureDataURICached(override.selectedFileId);

                if (!dataUri || !dataUri.startsWith("data:audio/")) {
                    showToast("No custom sound file available for preview");
                    return;
                }

                sound.current = playAudio(dataUri, {
                    volume: override.volume,
                    speed,
                    onError: e => {
                        console.error("[CustomSounds] Error playing custom audio:", e);
                        showToast("Error playing custom sound. File may be corrupted.");
                    }
                });
            } catch (error) {
                console.error("[CustomSounds] Error in previewSound:", error);
                showToast("Error playing sound.");
            }
        } else if (selectedSound === "default") {
            sound.current = playAudio(type.id, { volume: override.volume, speed });
        } else {
            sound.current = playAudio(selectedSound, { volume: override.volume, speed });
        }
    };

    const uploadFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const fileExtension = file.name.split(".").pop()?.toLowerCase();
        if (!fileExtension || !AUDIO_EXTENSIONS.includes(fileExtension)) {
            showToast("Invalid file type. Please upload an audio file.");
            event.target.value = "";
            return;
        }

        try {
            showToast("Uploading file...");
            const id = await saveAudio(file);

            await onFilesChange();

            override.selectedFileId = id;
            override.selectedSound = "custom";

            await ensureDataURICached(id);
            await saveAndNotify();

            showToast(`File uploaded successfully: ${file.name}`);
        } catch (error) {
            console.error("[CustomSounds] Error uploading file:", error);
            showToast(`Error uploading file: ${error}`);
        }

        event.target.value = "";
    };

    const deleteFile = async (id: string) => {
        try {
            await deleteAudio(id);
            await onFilesChange();

            if (override.selectedFileId === id) {
                override.selectedFileId = undefined;
                override.selectedSound = "default";
                await saveAndNotify();
            } else {
                update();
            }
            showToast("File deleted successfully");
        } catch (error) {
            console.error("[CustomSounds] Error deleting file:", error);
            showToast("Error deleting file.");
        }
    };

    const customFileOptions = Object.entries(files)
        .filter(([id, file]) => !!id && !!file?.name)
        .map(([id, file]) => ({
            value: id,
            label: file.name
        }));

    return (
        <Card className={cl("card")}>
            <FormSwitch
                title={type.name}
                value={override.enabled || false}
                onChange={async val => {
                    console.log(`[CustomSounds] Setting ${type.id} enabled to:`, val);

                    override.enabled = val;

                    if (val && override.selectedSound === "custom" && override.selectedFileId) {
                        try {
                            await ensureDataURICached(override.selectedFileId);
                        } catch (error) {
                            console.error(`[CustomSounds] Failed to cache data URI for ${type.id}:`, error);
                            showToast("Error loading custom sound file");
                        }
                    }

                    await saveAndNotify();
                    console.log("[CustomSounds] After setting enabled, override.enabled =", override.enabled);
                }}
                className={Margins.bottom16}
                hideBorder
            />

            {override.enabled && (
                <>
                    <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
                        <Button
                            color={Button.Colors.GREEN}
                            onClick={previewSound}
                        >
                            Preview
                        </Button>
                        <Button
                            color={Button.Colors.RED}
                            onClick={() => sound.current?.stop()}
                        >
                            Stop
                        </Button>
                    </div>

                    <Heading className={Margins.bottom8}>Volume</Heading>
                    <Slider
                        minValue={0}
                        maxValue={500}
                        markers={makeRange(0, 500, 50)}
                        initialValue={override.volume}
                        onValueChange={val => {
                            sound.current && (sound.current.volume = val);
                            override.volume = val;
                            saveAndNotify();
                        }}
                        onValueRender={(v: number) => `${Math.round(v)}%`}
                        className={Margins.bottom16}
                        disabled={!override.enabled}
                    />

                    <Heading className={Margins.bottom8}>Playback Speed</Heading>
                    <Slider
                        minValue={0.5}
                        maxValue={3}
                        markers={makeRange(0.5, 3, 0.5)}
                        initialValue={override.speed ?? 1}
                        onValueChange={val => {
                            const snapped = Math.round(val * 10) / 10;
                            sound.current && (sound.current.speed = snapped);
                            override.speed = snapped;
                            saveAndNotify();
                        }}
                        onValueRender={(v: number) => `${(Math.round(v * 10) / 10).toFixed(1)}x`}
                        className={Margins.bottom16}
                        disabled={!override.enabled}
                    />

                    <Heading className={Margins.bottom8}>Sound Source</Heading>
                    <div style={{ marginBottom: "16px" }}>
                        <Select
                            options={[
                                { value: "default", label: "Default" },
                                ...(type.seasonal?.map(id => ({ value: id, label: capitalizeWords(id) })) ?? []),
                                { value: "custom", label: "Custom" }
                            ]}
                            closeOnSelect
                            isSelected={v => v === override.selectedSound}
                            select={async v => {
                                override.selectedSound = v;

                                if (v === "custom" && override.selectedFileId) {
                                    try {
                                        await ensureDataURICached(override.selectedFileId);
                                    } catch (error) {
                                        console.error(`[CustomSounds] Failed to cache data URI for ${type.id}:`, error);
                                        showToast("Error loading custom sound file");
                                    }
                                }

                                await saveAndNotify();
                            }}
                            serialize={v => v}
                        />
                    </div>

                    {override.selectedSound === "custom" && (
                        <>
                            <Heading className={Margins.bottom8}>Custom File</Heading>
                            <div style={{ marginBottom: "16px" }}>
                                <Select
                                    options={[
                                        { value: "", label: "Select a file..." },
                                        ...customFileOptions
                                    ]}
                                    closeOnSelect
                                    isSelected={v => v === (override.selectedFileId || "")}
                                    select={async id => {
                                        if (!id) {
                                            override.selectedFileId = undefined;
                                        } else {
                                            override.selectedFileId = id;
                                            await ensureDataURICached(id);
                                        }

                                        await saveAndNotify();
                                    }}
                                    serialize={v => v}
                                />
                            </div>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".mp3,.wav,.ogg,.m4a,.flac,.aac,.webm,.wma,.mp4"
                                style={{ display: "none" }}
                                onChange={uploadFile}
                            />
                            <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
                                <Button
                                    onClick={() => fileInputRef.current?.click()}
                                    color={Button.Colors.BRAND}
                                >
                                    Upload New
                                </Button>

                                {override.selectedFileId && files[override.selectedFileId] && (
                                    <Button
                                        color={Button.Colors.RED}
                                        onClick={() => deleteFile(override.selectedFileId!)}
                                    >
                                        Delete Selected File
                                    </Button>
                                )}
                            </div>
                        </>
                    )}
                </>
            )}
        </Card>
    );
}
