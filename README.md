> [!TIP]
> **If you run into any issues, please feel free to message me on Discord: [scattrdblade](https://discord.com/users/678007540608532491)**
# Vencordo (Vencord)
This is a Vencord plugin that allows you to change the `Discordo`/`Dicodo` startup sound to a sound of your choice by going to the plugin's settings and pasting the URL of a valid audio file.
> [!NOTE]
> **The audio file must be a URL and not a local file.**<br/>
You can find audio URLs on soundboard sites, or create your own GitHub repository, add an audio file, and paste the raw link to it in the plugin's settings.

## DOWNLOAD INSTRUCTIONS
You can either __clone__ the repository OR __manually download__ it as a zip file.<br/>
> [!WARNING]
> Make sure you have the Vencord [developer build](https://github.com/Vendicated/Vencord/blob/main/docs/1_INSTALLING.md) installed.<br/>
> Inside the `Vencord` folder should be a folder called `src`. If you haven't already, create a folder called `userplugins` inside the `src` folder.

**CLONING:**
1. Open up the terminal (command prompt/CMD) and run
```shell
cd Vencord/src/userplugins
```
then run
```js
git clone https://github.com/ScattrdBlade/vencordo
```
2. The plugin folder (`vencordo`) should now be in the `userplugins` folder.
3. Ensure it's structured as `src/userplugins/vencordo`
4. Run `pnpm build` and the plugin should be added.

**MANUAL DOWNLOAD**
1. Click the green `<> Code` button at the top right of the repository and select `Download ZIP`
2. Unzip the downloaded ZIP file into the `userplugins` folder.
3. Ensure it's structured as `src/userplugins/vencordo` or `src/userplugins/vencordo-main`
5. Run `pnpm build` in the terminal (command prompt/CMD) and the plugin should be added.
