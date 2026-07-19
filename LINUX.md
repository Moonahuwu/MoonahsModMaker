# Linux build (experimental)

This branch carries the Linux port. Status: **compiles + packaged by CI,
untested on real hardware**. If you're the brave tester, this file is for you.

## Setup

1. **Install the two system tools** the app can't bring itself:

   ```sh
   # Debian/Ubuntu
   sudo apt install wine ffmpeg
   # Arch
   sudo pacman -S wine ffmpeg
   # Fedora
   sudo dnf install wine ffmpeg
   ```

   Wine is what runs Valve's Windows-only `resourcecompiler` during compiles;
   ffmpeg does all audio/image processing. Any recent versions are fine.

2. **Get the app**: repo → Actions tab → latest green `linux-build` run →
   download the `moonahs-mod-maker-linux` artifact (you must be signed in to
   GitHub). Unzip, then:

   ```sh
   chmod +x "Moonahs Mod Maker"*.AppImage && ./"Moonahs Mod Maker"*.AppImage
   ```

   (There's also a `.deb` in the artifact if you prefer installing it.)

3. **First-run wizard**: it auto-detects Steam and Deadlock on launch
   (`~/.steam`, `~/.local/share/Steam`, flatpak). If the Game pak / Addons
   lines show ✗, open Setup (⚙) and point them at your install manually,
   e.g. `.../steamapps/common/Deadlock/game/citadel/pak01_dir.vpk`.

4. **Click "Download the compile tools" (~430 MB)** in the wizard. Yes, the
   bundle contains Windows binaries - that's intentional, Wine runs them.
   The bundle's `ffmpeg.exe` is ignored on Linux; your system ffmpeg from
   step 1 is used instead.

5. Done - the wizard's checklist should be all green except things you skip.

## What to test (in order of expected pain)

1. Browse heroes/sounds/items (native helper - should just work).
2. Compile a SOUND mod: drop an mp3 on a music slot, hit Compile. Wine runs
   resourcecompiler headless here.
3. Compile an IMAGE mod (hero portrait or wall art). This initializes a GPU
   device inside resourcecompiler - the most likely thing to fail under Wine.
   If it fails, note whether sound-only compiles still succeed.
4. Install to game + launch (installs are plain file copies; launch goes
   through `steam://` via xdg-open).

## Known not-ported (gated off, not broken)

- One-click app updates (grab new builds from the Actions artifacts instead).
- Custom-server hosting (launches Windows console processes).

## Report back

Open a GitHub issue with: distro, Wine version, GPU/driver, and the compile
report (the "Copy report" button in the app copies every step as text).
