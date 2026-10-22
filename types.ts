/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface SoundType {
    name: string;
    id: string;
    seasonal?: Record<string, string>;
}

export interface SoundOverride {
    enabled: boolean;
    selectedSound: string;
    volume: number;
    selectedFileId?: string;
    selectedFileName?: string;
}

export interface SoundpackRequire {
    (path: string): string;
    keys?(): string[];
}

export const DEFAULT_VOLUME = 100;
export const MAX_VOLUME = 500;

// "Unknown" is the placeholder for files without a name
export function cleanName(name: unknown) {
    if (typeof name !== "string" || !name || name === "Unknown") return undefined;
    return name.slice(0, 200).replace(/[\ud800-\udbff]$/, "");
}

export function normalizeOverride(raw: unknown): SoundOverride {
    const o = (raw && typeof raw === "object" ? raw : {}) as Partial<SoundOverride>;
    const fileId = typeof o.selectedFileId === "string" && o.selectedFileId ? o.selectedFileId : undefined;
    const volume = typeof o.volume === "number" && isFinite(o.volume) ? o.volume : DEFAULT_VOLUME;
    return {
        enabled: o.enabled === true,
        selectedSound: typeof o.selectedSound === "string" && o.selectedSound ? o.selectedSound : "default",
        selectedFileId: fileId,
        selectedFileName: fileId ? cleanName(o.selectedFileName) : undefined,
        volume: Math.max(0, Math.min(MAX_VOLUME, volume))
    };
}

export const soundTypes: readonly SoundType[] = [
    { name: "Activity End", id: "activity_end" },
    { name: "Activity Launch", id: "activity_launch" },
    { name: "Activity User Join", id: "activity_user_join" },
    { name: "Activity User Left", id: "activity_user_left" },
    { name: "ASMR Message", id: "asmr_message1" },
    { name: "Bit Message", id: "bit_message1" },
    { name: "Bop Message", id: "bop_message1" },
    {
        name: "Call Calling",
        id: "call_calling",
        seasonal: {
            halloween_call_calling: "https://discord.com/assets/ef24e229a3413c8a.mp3",
            winter_call_calling: "https://discord.com/assets/a07935fe464c324c.mp3"
        }
    },
    {
        name: "Call Ringing",
        id: "call_ringing",
        seasonal: {
            halloween_call_ringing: "https://discord.com/assets/7a287e2f88531f25.mp3",
            winter_call_ringing: "https://discord.com/assets/daf6c21d9f92979a.mp3",
            call_ringing_beat: "https://discord.com/assets/574220f72e718dad.mp3",
            call_ringing_snow_halation: "https://discord.com/assets/82954088613583bc.mp3",
            call_ringing_snowsgiving: "https://discord.com/assets/4261355196740dab.mp3"
        }
    },
    { name: "Camera Off", id: "camera_off" },
    { name: "Camera On", id: "camera_on" },
    { name: "Clip Error", id: "clip_error" },
    { name: "Clip Save", id: "clip_save" },
    { name: "DDR Down", id: "ddr-down" },
    { name: "DDR Left", id: "ddr-left" },
    { name: "DDR Right", id: "ddr-right" },
    { name: "DDR Up", id: "ddr-up" },
    {
        name: "Deafen",
        id: "deafen",
        seasonal: {
            halloween_deafen: "https://discord.com/assets/514663b657bc4c7d.mp3",
            winter_deafen: "https://discord.com/assets/70fe5e248588bb13.mp3"
        }
    },
    { name: "Discodo", id: "discodo" },
    {
        name: "Disconnect",
        id: "disconnect",
        seasonal: {
            halloween_disconnect: "https://discord.com/assets/9b8ef0a59d731dd6.mp3",
            winter_disconnect: "https://discord.com/assets/600991ad4560f288.mp3"
        }
    },
    { name: "Doggo Game: Bark (Game Start)", id: "doggo_bark" },
    { name: "Doggo Game: Cat Death", id: "doggo_cat" },
    { name: "Doggo Game: Cat Hurt", id: "doggo_cat_hurt" },
    { name: "Doggo Game: Dog Death", id: "doggo_dog_death" },
    { name: "Doggo Game: Dog Hurt", id: "doggo_dog_hurt" },
    { name: "Doggo Game: Knife Slash", id: "doggo_slash" },
    { name: "Doggo Game: Music", id: "doggo_music" },
    { name: "Doggo Game: Player Death", id: "doggo_death" },
    { name: "Doggo Game: Player Hit", id: "doggo_human_hit" },
    { name: "Doggo Game: Rat Attack", id: "doggo_rat" },
    { name: "Doggo Game: Rat Hit", id: "doggo_rat_hit" },
    { name: "Doggo Game: Skeleton Attack", id: "doggo_skeleton" },
    { name: "Doggo Game: Skeleton Death", id: "doggo_skeleton_die" },
    { name: "Doggo Game: Skeleton Hit", id: "doggo_skeleton_hit" },
    { name: "Doggo Game: Zombie Attack", id: "doggo_zombie" },
    { name: "Doggo Game: Zombie Hit", id: "doggo_zombie_hit" },
    { name: "Ducky Message", id: "ducky_message1" },
    { name: "Hang Status Select", id: "hang_status_select" },
    { name: "Human Man", id: "human_man" },
    { name: "LoFi Message", id: "lofi_message1" },
    { name: "Mention 1 (Unused by Discord)", id: "mention1" },
    { name: "Mention 2 (Unused by Discord)", id: "mention2" },
    { name: "Mention 3 (Audio Device Changed)", id: "mention3" },
    {
        name: "Message 1 (All Message Notifications)",
        id: "message1",
        seasonal: {
            halloween_message1: "https://discord.com/assets/c269de500ca3cb7b.mp3"
        }
    },
    { name: "Message 2 (Friend Started Playing)", id: "message2" },
    { name: "Message 3 (Current Channel, if enabled in Discord)", id: "message3" },
    {
        name: "Mute",
        id: "mute",
        seasonal: {
            halloween_mute: "https://discord.com/assets/d5e69d2c2aac0a27.mp3",
            winter_mute: "https://discord.com/assets/81034fa14558e50f.mp3"
        }
    },
    { name: "Overlay Unlock", id: "overlayunlock" },
    { name: "Poggermode Achievement", id: "poggermode_achievement_unlock" },
    { name: "Poggermode Applause", id: "poggermode_applause" },
    { name: "Poggermode Enabled", id: "poggermode_enabled" },
    { name: "Poggermode Message", id: "poggermode_message_send" },
    { name: "PTT Start", id: "ptt_start" },
    { name: "PTT Stop", id: "ptt_stop" },
    { name: "Reconnect", id: "reconnect" },
    { name: "Robot Man", id: "robot_man" },
    { name: "Stage Waiting", id: "stage_waiting" },
    { name: "Stream Ended", id: "stream_ended" },
    { name: "Stream Started", id: "stream_started" },
    { name: "Stream User Joined", id: "stream_user_joined" },
    { name: "Stream User Left", id: "stream_user_left" },
    { name: "Success", id: "success" },
    {
        name: "Undeafen",
        id: "undeafen",
        seasonal: {
            halloween_undeafen: "https://discord.com/assets/4dfa756a71484219.mp3",
            winter_undeafen: "https://discord.com/assets/5b518eba0a73ec4a.mp3"
        }
    },
    {
        name: "Unmute",
        id: "unmute",
        seasonal: {
            halloween_unmute: "https://discord.com/assets/6f0d538ed066a1a6.mp3",
            winter_unmute: "https://discord.com/assets/b2c49178b1a4e3d9.mp3"
        }
    },
    {
        name: "User Join",
        id: "user_join",
        seasonal: {
            halloween_user_join: "https://discord.com/assets/00b48ea9fc787786.mp3",
            winter_user_join: "https://discord.com/assets/b766ee70384a56ce.mp3"
        }
    },
    {
        name: "User Leave",
        id: "user_leave",
        seasonal: {
            halloween_user_leave: "https://discord.com/assets/c9b6b9d1ef992f1b.mp3",
            winter_user_leave: "https://discord.com/assets/cf2c36fde50eb05d.mp3"
        }
    },
    { name: "User Moved", id: "user_moved" },
    { name: "Vibing Wumpus", id: "vibing_wumpus" },
    { name: "Voice Message Recording Stopped", id: "voice_message_recording_stopped" }
];
