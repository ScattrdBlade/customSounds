**UPDATE: New file storage, full backups and a fallback for missing files.**

> [!TIP]
> **If you run into any issues, please let me know in the [Support Server](https://discord.gg/jHDJaW9Gyz)**

# Custom Sounds (Vencord)

Replace any of Discord's sounds with your own audio or a seasonal variant, and give each sound its own volume (up to 500%). Every sound has a live preview, a search box helps you find it, and Export/Import backs up your settings together with your audio files.

Each sound can play **Native** (whatever Discord would play, including sound packs and seasonal sounds), **Regular** (always the normal sound), a seasonal variant, or a **Custom** file you upload. Files can be up to 50 MB, and MP3 or OGG works best.

## Backups and syncing

- Your audio files stay on the device you uploaded them on. Vencord's settings sync and settings backups don't include them.
- Use **Export** before reinstalling or switching PCs. It's the only backup that includes the audio. Big libraries are saved as several files (`-part2`, `-part3`, ...), so import the part files first and the main file last.
- If your settings sync to a device that doesn't have the file, Discord's own sound plays instead. Upload the same file on that device to fix it.

## Updating from an older version

This version stores your files in a new place. On first start it copies your old files over and checks them, and the old storage is deleted once everything has been moved. If copying fails, nothing is deleted and it tries again on the next start, so don't clear Discord's data.

Equicord's CustomSounds and older versions of this plugin can't read the new storage. To switch back, Export first and import that backup in the version you're switching to.

## DOWNLOAD INSTRUCTIONS

You can either **git clone** the repository OR **manually install** it by downloading it as a zip file.

> [!WARNING]
> Make sure you have the Vencord [developer build](https://docs.vencord.dev/installing/) installed, built from the latest `main` (run `git pull` in your Vencord folder first). Older Vencord versions aren't supported.

> [!IMPORTANT]
> Inside the `Vencord` folder should be a folder called `src`. If you haven't already, create a folder called `userplugins` inside the `src` folder.

### GIT CLONE INSTALLATION

The full cloning installation guide can be found [here](https://discord.com/channels/1015060230222131221/1257038407503446176/1257038407503446176) or via [the official Vencord Docs](https://docs.vencord.dev/installing/custom-plugins/).

1. Direct your terminal (CMD/PowerShell) to the `userplugins` folder (`cd src/userplugins`).
2. Open the terminal and paste `git clone https://github.com/ScattrdBlade/customSounds`
3. Ensure it's structured as `src/userplugins/customSounds`
4. Run `pnpm build` in the terminal (CMD/PowerShell) and the plugin should be added.

### MANUAL INSTALLATION

1. Click the green `<> Code` button at the top right of the repository and select `Download ZIP`
2. Unzip the downloaded ZIP file into the `userplugins` folder.
3. Ensure it's structured as `src/userplugins/customSounds`
4. Run `pnpm build` in the terminal (CMD/PowerShell) and the plugin should be added.

## Troubleshooting

- **Previews work but real sounds don't change:** A Discord update probably broke the plugin. Check its settings for a red warning, then update Vencord and the plugin.
- **The console says _Failed to move the old sound storage_ on every start:** Close Discord and back up its `IndexedDB` folder (Windows: `%appdata%\discord\IndexedDB`, Vesktop: `%appdata%\vesktop\sessionData\IndexedDB`, macOS/Linux: the same folders under `~/Library/Application Support` or `~/.config`). Then reopen Discord and run `Vencord.Api.DataStore.delMany(["ScattrdCustomSounds", "ScattrdCustomSounds_Metadata"])` in the console. This deletes the old storage, including any files that weren't moved.
- **Incoming calls don't ring:** Check that Discord's _Incoming Ring_ sound is on and that you replaced _Call Ringing_ (incoming), not _Call Calling_ (outgoing).
- _Message 1_ plays for every message notification, including DMs and pings. Discord never plays _Mention 1_ or _Mention 2_.
- Sounds that macOS plays through native notifications can't be changed.
