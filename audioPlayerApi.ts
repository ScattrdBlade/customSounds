/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByCodeLazy, findLazy } from "@webpack";

let defaultSounds: null | string[] = null;
const findDefaultSounds = findLazy(module => module.resolve && module.id && module.keys().some((key: string) => key.endsWith(".mp3")));
const AudioPlayerConstructor = findByCodeLazy("could not play audio");

export type AudioProcessor = (data: PreprocessAudioData) => void;
export type AudioCallback = (() => void);
export type AudioErrorHandler = ((error: Error) => void);
export const audioProcessorFunctions: Record<string, AudioProcessor> = {};

export enum AudioType {
    URL = "url",
    DATA = "data-uri",
    BLOB = "blob",
    PATH = "file-path",
    DISCORD = "discord",
    OTHER = "other"
}

export interface PreprocessAudioData {
    audio: string;
    readonly type: AudioType;
    volume: number;
    speed: number;
    boost?: number;
}

export interface AudioPlayerInternal {
    preprocessDataOriginal: PreprocessAudioData;
    preprocessDataPrevious: PreprocessAudioData | null;
    preprocessDataCurrent: PreprocessAudioData;
    audio: string;
    _audio: null | Promise<HTMLAudioElement>;
    _volume: number;
    _speed: number;
    outputChannel: string;
    type: AudioType;
    preload: boolean;
    persistent: boolean;
    onEnded?: AudioCallback;
    onError?: AudioErrorHandler;
    processAudio: () => void;
    ensureAudio(): Promise<HTMLAudioElement>;
    destroyAudio(): void;
    loop(): void;
    play(): void;
    pause(): void;
    stop(restart?: boolean): void;
}

export interface AudioPlayerInterface {
    audio: string;
    readonly type: AudioType;
    readonly duration: Promise<number> | null;
    time: Promise<number> | null;
    paused: Promise<boolean> | null;
    muted: Promise<boolean> | null;
    volume: number;
    speed: number;
    preload: boolean;
    persistent: boolean;
    load(): void;
    loop(): void;
    play(): void;
    pause(): void;
    stop(): void;
    restart(): void;
    seek(time: number): void;
    mute(): void;
    unmute(): void;
    delete(): void;
}

export interface AudioPlayerOptions {
    volume?: number;
    speed?: number;
    boost?: number;
    preload?: boolean;
    persistent?: boolean;
    onEnded?: AudioCallback;
    onError?: AudioErrorHandler;
}

class AudioPlayerWrapper implements AudioPlayerInterface {
    private internalPlayer: AudioPlayerInternal;
    constructor(internalPlayer: AudioPlayerInternal) { this.internalPlayer = internalPlayer; }

    get audio(): string { return this.internalPlayer.audio; }
    set audio(value: string) { this.internalPlayer.preprocessDataOriginal.audio = value; this.internalPlayer.processAudio(); }

    get volume(): number { return (this.internalPlayer.preprocessDataOriginal?.volume ?? this.internalPlayer._volume) * 100; }
    set volume(value: number) { this.internalPlayer.preprocessDataOriginal.volume = Math.max(0, value / 100); this.internalPlayer.processAudio(); }

    get speed(): number { return this.internalPlayer._speed; }
    set speed(value: number) { this.internalPlayer.preprocessDataOriginal.speed = Math.max(0.0625, Math.min(16, value)); this.internalPlayer.processAudio(); }

    get time(): Promise<number> | null { return this.internalPlayer._audio?.then(audio => audio.currentTime) ?? null; }
    set time(value: number) { this.internalPlayer.ensureAudio().then(audio => audio.currentTime = value); }

    get persistent(): boolean { return this.internalPlayer.persistent; }
    set persistent(value: boolean) { this.internalPlayer.persistent = value; }

    get preload(): boolean { return this.internalPlayer.preload; }
    set preload(value: boolean) { this.internalPlayer.preload = value; value && this.internalPlayer.ensureAudio(); }

    get muted(): Promise<boolean> | null { return this.internalPlayer._audio?.then(audio => audio.muted) ?? null; }
    set muted(value: boolean) { this.internalPlayer.ensureAudio().then(audio => audio.muted = value); }

    get paused(): Promise<boolean> | null { return this.internalPlayer._audio?.then(audio => audio.paused) ?? null; }
    set paused(value: boolean) { value ? this.internalPlayer.pause() : this.internalPlayer.play(); }

    get type(): AudioType { return this.internalPlayer.type; }
    get duration(): Promise<number> | null { return this.internalPlayer._audio?.then(audio => audio.duration) ?? null; }

    load(): void { this.internalPlayer.ensureAudio(); }
    loop(): void { this.internalPlayer.loop(); }
    play(): void { this.internalPlayer.play(); }
    pause(): void { this.internalPlayer.pause(); }
    stop(restart?: boolean): void { this.internalPlayer.stop(restart); }
    restart(): void { this.internalPlayer.stop(true); }
    seek(time: number): void { this.internalPlayer.ensureAudio().then(audio => audio.currentTime = time); }
    mute(): void { this.internalPlayer.ensureAudio().then(audio => audio.muted = true); }
    unmute(): void { this.internalPlayer.ensureAudio().then(audio => audio.muted = false); }
    delete(): void { this.internalPlayer.destroyAudio(); }
}

export function createAudioPlayer(audio: string, options: AudioPlayerOptions = {}): AudioPlayerInterface {
    const internalPlayer: AudioPlayerInternal = new AudioPlayerConstructor(audio, null, null, "default", options);
    return new AudioPlayerWrapper(internalPlayer);
}

export function playAudio(audio: string, options: AudioPlayerOptions = {}): AudioPlayerInterface {
    const player = createAudioPlayer(audio, options);
    player.play();
    return player;
}

export function identifyAudioType(audio: string): AudioType {
    if (defaultAudioNames().includes(audio)) return AudioType.DISCORD;

    try {
        const url = new URL(audio);
        if (url.protocol === "http:" || url.protocol === "https:") return AudioType.URL;
        if (url.protocol === "data:") return AudioType.DATA;
        if (url.protocol === "blob:") return AudioType.BLOB;
        if (url.protocol === "file:") return AudioType.PATH;
        return AudioType.OTHER;
    } catch {
        return AudioType.OTHER;
    }
}

export function addAudioProcessor(key: string, processor: AudioProcessor): void {
    audioProcessorFunctions[key] = processor;
}

export function removeAudioProcessor(key: string): void {
    delete audioProcessorFunctions[key];
}

export function defaultAudioNames(): string[] {
    defaultSounds ??= (findDefaultSounds.keys() || []).map((key: string) => {
        const match = key.match(/((?:\w|-)+)\.mp3$/);
        return match ? match[1] : null;
    }).filter(Boolean) as string[];

    return defaultSounds;
}
