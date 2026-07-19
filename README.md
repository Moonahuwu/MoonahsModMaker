# Moonah's Mod Maker

A desktop app for making Deadlock mods without touching a compiler or a text
editor: replace music and sounds, swap images and wall art, bundle other
mods together, and build everything into a ready-to-install `.vpk` with one
button.

**[Download on GameBanana](https://gamebanana.com/tools/23422)** · or grab the
installer from [Releases](https://github.com/Moonahuwu/MoonahsModMaker/releases).
The app updates itself when a new version is released.

## What it can do

- **Music & sounds**: match intro, map objectives (urn, mid-boss, rifts,
  powerups), shop, per-hero abilities and voicelines, per-item sounds, and a
  browser to replace any of the game's ~79k sound files directly.
- **Audio editing built in**: trim, gain, fades, layered mixes, waveform
  preview, compare against the original in-game sound.
- **Images**: hero portraits, ability icons, and in-world posters/graffiti
  (drop a PNG on a map region).
- **Jumpscares (MoonahMasterUI)**: a generated HUD mod that plays your videos
  and sounds at random moments in-game.
- **Mod combiner**: bundle other creators' packs into one build, with imported
  events editable per slot and a generated credits file. Includes an in-app
  GameBanana browser.
- **One-click everything**: compile, install into an addon slot, launch the
  game. When Deadlock updates, a single "Fix for new patch" re-pulls the game
  data and rebuilds your pack.

Sound edits are **merged, never replaced**: the app splices only the entries
it owns into the game's shared sound-event files, so stock tracks and other
mods stay byte-for-byte intact.

## Building from source

Requires Rust, Node, the .NET SDK, and ffmpeg on PATH.

```sh
cd app
npm install
npm run tauri dev      # dev app with hot reload
npm run tauri build    # release build + installers
```

Tests: `cargo test` (KV3 merger + backend). The C# VPK helper builds with
`npm run build:helper` (from `app/`).

Compiling mods needs Valve game data and the community Reduced CSDK compiler;
the app's first-run wizard downloads a trimmed tools bundle (~430 MB) so end
users never need the full SDK.

| Path | What |
|------|------|
| `crates/kv3-core/` | Surgical KV3 merger - edits only owned entries, byte-preserving |
| `app/src/` | React/TS frontend |
| `app/src-tauri/` | Rust backend: audio, compile pipeline, install, project model |
| `tools/vpk-helper/` | C# CLI over ValvePak/ValveResourceFormat (pack, extract, decode) |

## Linux?

Windows-only for now. A native port is realistic and contributions are
welcome - the stack is mostly portable already:

- Tauri builds natively on Linux (webkit2gtk), the vpk-helper is
  cross-platform .NET, and ffmpeg is everywhere.
- The Windows-specific bits are small and localized: path autodetect
  (registry lookups in `commands.rs`), the updater (NSIS), the tools
  downloader (System32 curl/tar), and process listing (`tasklist`).
- The one hard dependency is Valve's `resourcecompiler.exe` (Windows-only),
  which would need to run through Wine. Sound compiles are the likely-easy
  case; texture compiles initialize a GPU device and need real testing.

If you want to take a swing at it, open an issue and we'll coordinate.

## Notes

- Extracted Valve game content (`ModFiles/`, `sounds/`, `soundevents/`,
  `VanillaFiles/`) and build output are git-ignored - not part of this repo.
- Made by Moonah. Discord: `moonah00`.
