# Moonah's Mod Maker

A local desktop app for building custom Deadlock sound/UI mods — match-intro tracks,
map music (urn/Idol, midboss, powerups, team objectives), hero ability sounds and
voicelines, shop-item sounds, and custom item icons — and compiling them into a
ready-to-install `.vpk`.

> Formerly **EasyIntroModder** — renamed as the scope grew well beyond the intro.

It merges your entries into the game's shared sound-event files (`music.vsndevts`,
`hero/*.vsndevts`) **without disturbing other mods**: it only touches the array
entries it owns and leaves the stock track and every foreign entry intact.

## Features

- **Tabs** for Deadlock Intro (King / Mother), Urn Music (carry, contest team/enemy,
  stingers), and Heroes (Billy's Blasted E).
- Drag-and-drop an mp3 onto a slot; **trim, gain, and fade-out** with live preview.
- **Waveform** of your clip, plus play/compare against the original in-game track.
- **Enable/disable or remove** any stock or other-mod entry per slot.
- One **Compile** button: ffmpeg → `resourcecompiler` → merge → backups → recreate
  folder structure → optional `pak01_dir.vpk` (via a bundled ValvePak helper).

## Layout

| Path | What |
|------|------|
| `crates/kv3-core/` | Surgical KV3 (`.vsndevts`) reader/merger — edits only owned array entries, byte-preserving. |
| `app/` | Tauri 2 + React/TS/Tailwind frontend. |
| `app/src-tauri/` | Rust backend (audio/ffmpeg, compile pipeline, vpk + project model). |
| `tools/vpk-helper/` | C# CLI over ValvePak/ValveResourceFormat (pack / extract / decode). |

## Build / run

Requires Rust, Node, .NET SDK, and ffmpeg on PATH.

```sh
cd app
npm install
npm run tauri dev      # dev with hot reload
npm run tauri build    # standalone build
```

Tests:

```sh
cargo test                                   # Rust (kv3-core + backend)
cd tools/vpk-helper && dotnet build -c Release
```

## Notes

- Extracted Valve game content (the `ModFiles/`, `sounds/`, `compilerstuff/`
  folders) and build output are **git-ignored** — they're not shared here.
- Compilation uses the community **Reduced CSDK** toolchain; paths are configured
  in the app's Setup panel.
