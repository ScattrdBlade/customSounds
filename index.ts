/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";

// URLs for the explosion sound effect as fallback
const DEFAULT_EXPLOSION_URL = "https://www.myinstants.com/media/sounds/explosion-m.mp3";

// Define plugin settings
const settings = definePluginSettings({
    customSoundURL: {
        description: "Enter the URL of your custom sound file (.mp3, .wav, .ogg, .flac, .aac, .m4a)",
        type: OptionType.STRING,
        default: "https://www.myinstants.com/media/sounds/explosion-m.mp3"
    }
});

function getSoundURL() {
    const url = settings.store.customSoundURL;
    const knownAudioExtensions = [".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a"];

    const isValidURL = (url: string) => {
        try {
            new URL(url);
            return true;
        } catch (_) {
            return false;
        }
    };

    const hasValidExtension = (url: string) => {
        return knownAudioExtensions.some(ext => url.toLowerCase().endsWith(ext));
    };

    const addHttpsIfMissing = (url: string) => {
        if (!/^https?:\/\//i.test(url)) {
            return `https://${url}`;
        }
        return url;
    };

    const correctedURL = addHttpsIfMissing(url);

    if (correctedURL && isValidURL(correctedURL) && hasValidExtension(correctedURL)) {
        return correctedURL;
    }
    return DEFAULT_EXPLOSION_URL;
}

export default definePlugin({
    name: "Vencordo",
    description: 'Replace the "discordo" sound on startup with something a bit more interesting',
    authors: [
        Devs.echo,
    ],
    settings,
    patches: [
        {
            // First export statement replacement
            find: "c9bfe03395cf2616891f.mp3",
            replacement: {
                match: /e\.exports\s*=\s*n\.p\s*\+\s*"[a-zA-Z0-9]+\.(mp3|wav|ogg|flac|aac|m4a)"/,
                replace: () => `e.exports="${getSoundURL()}"`
            }
        },
        {
            // Second export statement replacement
            find: "9b8b7e8c94287d5491a8.mp3",
            replacement: {
                match: /e\.exports\s*=\s*n\.p\s*\+\s*"[a-zA-Z0-9]+\.(mp3|wav|ogg|flac|aac|m4a)"/,
                replace: () => `e.exports="${getSoundURL()}"`
            }
        }
    ]
});
