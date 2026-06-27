# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

EasyIntroModder is a local Tauri desktop app for building custom Deadlock music mods
(match-intro tracks, urn/Idol music, hero ability music) and compiling them into a
ready-to-install `.vpk`. The core invariant is **MERGE, NEVER REPLACE**: the app splices
*only the array entries it owns* into the game's shared sound-event files and leaves the
stock track and every other mod's entries byte-for-byte intact.

## Build / run

All commands assume Rust, Node, the .NET SDK, and ffmpeg are installed. `cargo` is **not
on PATH in fresh shells** here — the dev `.bat` and VS Code tasks prepend it; if running
`cargo` directly fails, that's why.

```sh
# Dev app (hot reload). Run from app/. Uses fixed Vite port 1420.
cd app && npm install && npm run tauri dev

# Standalone release build -> repo-root target/release/app.exe (+ installers under
# target/release/bundle/). The standalone app.exe MUST NOT be running during a build
# (Windows "Access denied removing app.exe") — kill the `app` process first.
cd app && npm run tauri build

# Rust tests (workspace: kv3-core + the Tauri backend)
cargo test
cargo test -p kv3-core                 # just the KV3 merger
cargo test -p app --lib                # just the backend
# End-to-end real compile (ignored by default; needs the CSDK toolchain + ModFiles):
cargo test -p app --lib -- --ignored e2e_real_compile_to_vpk --nocapture

# C# VPK helper
cd tools/vpk-helper && dotnet build -c Release

# Frontend type-check / build
cd app && npx tsc --noEmit && npm run build
```

Convenience launchers exist: `Run EasyIntroModder (dev).bat` (double-click) and VS Code
tasks ("▶ Run app (dev, hot reload)" = Ctrl+Shift+B).

**OPS gotcha:** `tauri dev` binds Vite port 1420. Killing a dev run can leave a stray
`node` (Vite) + `app.exe` holding 1420 → next launch fails "Port 1420 already in use".
Fix: kill the PID from `Get-NetTCPConnection -LocalPort 1420` plus stray `app` processes.

## Architecture

Cargo workspace at the repo root (`Cargo.toml` members: `crates/kv3-core`,
`app/src-tauri`). Three cooperating layers:

### 1. `crates/kv3-core` — surgical `.vsndevts` merger
The reason this is hand-written instead of a real KV3 parse/serialize: the events file is
**shared by many mods**, so a full AST round-trip would reformat unrelated events and
produce noisy/destructive diffs. Instead it locates *only* the target event's array span
and `vsnd_duration` value **by byte offset** and splices in place; every other byte is
preserved (proven byte-identical against the real game file). Decoupled from path logic —
callers pass full reference strings (`sounds/music/match_intro/x.vsnd`); set membership is
plain string comparison. Key types: `EventMerge` (one array edit), `EventView` (read-only
pool view for the UI). Also `list_arrays` / `add_entries` for unioning other mods in.
When brace-scanning, scan must start **after** the `<!-- kv3 ... -->` header (the header
contains `{` braces).

### 2. `app/src-tauri` — Rust backend (Tauri 2)
- `paths.rs` — **the single source of truth for path derivation.** Nothing else may build
  these strings by hand. `derive()` emits the `.vsnd` reference, the `.vsnd_c` compiled
  output path, and the VPK-internal path together so they can only differ by extension
  (the easiest bug here is mixing `.vsnd` vs `.vsnd_c`).
- `project.rs` — the `project.json` data model: the source of truth for OUR entries (the
  on-disk events file is the source of truth for everyone else's). Events are generalized
  into **slots** = `(eventName, arrayKey, eventsRelpath)` grouped into **tabs/groups**.
- `compile.rs` — the one-button pipeline. Per song: ffmpeg render → `resourcecompiler`
  (audio mp3/wav → `.vsnd_c`) → kv3-core merge of events → timestamped backup → write
  merged events into the game tree → compile events → stage produced `_c` files →
  folder or `pak01_dir.vpk`. Produces two variants under `outputDir`: `mine/` (your
  tracks only, always) and `combined/` (yours + imported mods, when any). `skip_compile`
  bypasses resourcecompiler for tests. `is_up_to_date()` skips unchanged songs via a hash.
- `audio.rs` — ffmpeg probe + render (trim/gain/fade-in/fade-out via `build_af`).
- `vpk.rs` — shells out to the C# helper.
- `install.rs` — one-click install into Deadlock's `game/citadel/addons`. Addons mount as
  `pakNN_dir.vpk` (NN = 01..99); a slot is "occupied" if any file there ends `pak<NN>_dir.vpk`
  (plain OR prefixed, e.g. `600744_pak07_dir.vpk`). `install()` picks the next free slot (or
  overwrites a caller-given one, backing up the occupant under `.eim_backups/`) and, when
  asked, adds the `citadel/addons` search path to the sibling `gameinfo.gi` if missing
  (with a `.gi.eim.bak`). Commands: `scan_addon_slots`, `install_to_game`.
- `commands.rs` + `lib.rs` — Tauri command surface (registered in `lib.rs`
  `invoke_handler!`). **All backend types serialize camelCase** to match the TS side.
  `autodetect_paths` also returns the addons dir; `save_settings`/`load_settings` persist
  the (frontend-shaped) settings blob as `settings.json` in app-data.

#### The CSDK compile recipe (load-bearing, don't "fix" casually)
Headless compile uses the community **Reduced CSDK** toolchain via the content/game
**addon model**: sources go in `content/citadel_addons/<addon>/…`; resourcecompiler emits
`_c` to the parallel `game/citadel_addons/<addon>/…`; `-game` points at base
`game/citadel` (the dir containing `gameinfo.gi`, NOT the addon and NOT a file). The
invocation includes `-danger_mode_ignore_schema_mismatches` — **required** because the
CSDK tool DLLs mismatch the live game's particle schema and otherwise abort (benign for
audio/soundevents). Looping `_lp` sounds need an `encoding.txt` with a per-file `loop`
block in the same folder as the source wavs.

### 3. `tools/vpk-helper` — C# CLI (net10.0)
Thin wrapper over **ValvePak** + **ValveResourceFormat**. Subcommands (see
`Program.cs` switch): `pack`, `extract`, `extractall`, `list`, `decode` (`.vsnd_c` →
playable audio, used for "compare to original" and downloads), `decompile`
(`.vsndevts_c` → KV3 text, used to import other mods and refresh vanilla data).
Shipped **self-contained**: `npm run build:helper` (in `app/`) publishes a single-file
`tools/vpk-helper/dist/vpk-helper.exe` (~92MB, no .NET runtime needed); the tauri build
bundles it as a resource via `beforeBuildCommand: npm run build:bundle`. `vpk.rs` runs a
`.exe` directly or a `.dll` via `dotnet`. Path resolution prefers `dist/vpk-helper.exe`
(autodetect checks the bundled resource dir + a dev parent-walk).

### Frontend (`app/src`)
React 19 + Vite 7 + Tailwind v4 + `motion`. `lib/api.ts` is the typed wrapper around every
Tauri command; `types.ts` mirrors the Rust types (camelCase). State lives in `App.tsx`
(slots keyed by id, pools keyed by `eventName::arrayKey`); project state autosaves
(debounced) to the OS app-data dir via `save_state`/`load_state`; settings persist
durably via `save_settings`/`load_settings` (app-data `settings.json`) with a localStorage
cache for instant first paint (`lib/settings.ts`, with `buildCompileConfig` +
`installSrcVpk`). Left sidebar = tabs (groups) + a ⚙ cog opening `SetupSection` as a modal;
sticky `CompileBar` drives compile **and install** (Add-next-free vs Replace-slot-N,
install-after-compile, patch-gameinfo). `FirstRunWizard` shows on first launch
(`firstRunDone`) and runs one-click setup (autodetect → import live game music data).
Waveform peaks are cached in-memory (`lib/peaksCache.ts`); `lib/songHash.ts` fingerprints
a song to skip unchanged recompiles.

### Adding a new tab / slot
Add the slot(s) with a new `group` + `events_relpath` in `project.rs` `new_project`, add a
`TAB_LABELS` entry and an `accentFor` color in `App.tsx`.

## Repo conventions / notes

- Extracted Valve game content and tool binaries are **git-ignored** and not shared:
  `ModFiles/`, `sounds/`, `soundevents/`, `compilerstuff/`, `VanillaFiles/`, plus build
  output. Several tests read `ModFiles/soundevents/music.vsndevts`, so they require those
  files present locally (the e2e compile test additionally needs the CSDK toolchain).
- Deadlock is installed at `D:\SteamLibrary\steamapps\common\Deadlock`; the CSDK toolchain
  used for verified compiles is `Reduced_CSDK_12`. Real paths are configured at runtime in
  the app's Setup panel (and auto-detected via `autodetect_paths`).
- The user's local `ModFiles` events file can be **stale** vs the installed game (stock
  refs drift); the helper `decode` has a fuzzy stem-prefix fallback for previews, and
  `refresh_vanilla` re-decompiles the live pak to fix drifted stock refs.
