# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

EasyIntroModder (shipped as **"Moonahs Mod Maker"** — GitHub repo
`Moonahuwu/MoonahsModMaker`; the local folder keeps the old name) is a local Tauri
desktop app for building custom Deadlock mods and compiling them into a
ready-to-install `.vpk`. It started as a music modder (match-intro,
urn/Idol, hero ability music) and has grown to cover most of the game's sound events
(map objectives, shop, UI/menu music, per-hero and per-item sounds), loose-file sound
replacement, hero/item image + wall-art (poster) replacement, a generated jumpscare/death
HUD mod (MoonahMasterUI, formerly DigiMaster), an experimental panorama UI editor with live preview (UI Master),
a gameplay config editor + randomizer, one-click custom-server hosting with an in-game
F8 mod menu, and an experimental VFX recolor tab. The core invariant for
sound-event edits is **MERGE, NEVER REPLACE**: the app splices *only the array entries it
owns* into the game's shared sound-event files and leaves the stock track and every other
mod's entries byte-for-byte intact.

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

**Installer gotchas:** `productName` in `tauri.conf.json` must NOT contain an
apostrophe — NSIS wraps shortcut paths in single quotes, so `Moonah's` explodes a
COM macro's argument list ("NSISCOMCALL requires 4 parameters, passed 8"). It's
"Moonahs Mod Maker" for the installer; the window title / in-app branding keep the
apostrophe. Installers land in `target/release/bundle/{nsis,msi}/`. The NSIS wizard is
branded (installer icon + dark-theme sidebar/header BMPs wired in `tauri.conf.json` >
`bundle.windows.nsis`); the BMPs are generated from `icons/icon.png` by
`app/src-tauri/installer/make-installer-art.ps1` — re-run it after changing the icon.
The wizard is DARK-THEMED via a custom NSIS template
(`app/src-tauri/installer/installer.nsi`, wired by `bundle.windows.nsis.template`):
it's the stock tauri-cli v2.11.4 template plus the "EimDark" blocks (MUI_BGCOLOR,
DWM dark titlebar, per-page SetCtlColors sweeps). If `@tauri-apps/cli` is upgraded,
re-vendor the matching stock template and re-apply those blocks.

**One-stop setup / tools bundle:** users never need the 36GB CSDK. A trimmed
toolchain (proven sufficient by real audio + soundevents compiles) lives at
`../EIM_Tools/` (sibling of the repo) and ships as `../EIM_Tools_v1.zip` (~434MB:
`csdk/game/bin_tools` + `csdk/game/citadel/{bin,cfg,gameinfo,fgds}` + static
ffmpeg/ffprobe). It's uploaded as a GitHub release asset (tag `tools-v1`); the
first-run wizard's "Download the compile tools" button pulls it via the
`download_tools` command into app-data `tools/`. NOT needed in the bundle:
`game/core`, `game/citadel` content, `content/core`. If the CSDK updates, rebuild
the bundle and bump the tag + `TOOLS_BUNDLE_URL` (in `app/src/lib/settings.ts`).

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
  into **slots** = `(eventName, arrayKey, eventsRelpath)` grouped into **tabs/groups**;
  `Project::default_for_match_intro()` builds the default slot set (intro, urn, rift,
  midboss, powerups, teamobj, heroes, shop, ui). Slots may be `direct_only`
  (soundstack-driven events with NO vsnd refs to merge - e.g. the Rift in-capture
  loop `Music.Koth.Capture.Lp`, whose four layered `music_koth_capture_*_160bpm`
  files are Rift-tab slots): the track always compiles AT `stock_entry`'s path as a
  loose-file override; `buildCompileConfig` routes them into `soundOverrides`, the
  merge machinery skips them, and users should toggle Looping on loop tracks.
  Beyond slots, the project also carries
  override subsystems: `icon_mods` (also hero images + ability icons + SVG name logos:
  `.vsvg_c` targets wrap the PNG in an `<image>` svg), `sound_overrides` (loose-file
  `.vsnd_c` replacements), `effect_overrides` (VFX recolor), `vdata_overrides` /
  `global_overrides` / `world_overrides` (gameplay config editor), `poster_overrides`
  (wall art), `digimod` (Jumpscares/Deaths config incl. the shared sound library +
  `merge_vpks`), `ui_overrides` (UI Master whole-file panorama edits), and
  `mod_texture_overrides` (texture swaps INSIDE bundled mod vpks: user art or a
  hue-shift recompiled as a `.vtex_c` at the mod's exact internal path -
  texture-level on purpose, no material recompile, so custom shaders can't break;
  `compile_mod_textures` stages them into the COMBINED variant only, after the
  mod's own extraction so ours wins).
- `compile.rs` — the one-button pipeline. `compile_project` is **async** and wraps the
  heavy work in `spawn_blocking` so the UI stays responsive (returns a `CompileReport`
  with panic-safe error handling). Per song: ffmpeg render → `resourcecompiler`
  (audio mp3/wav → `.vsnd_c`) → kv3-core merge of events → timestamped backup → write
  merged events into the game tree → compile events → stage produced `_c` files →
  folder or `pak01_dir.vpk`. Produces two variants under `outputDir`: `mine/` (your
  tracks only, always) and `combined/` (yours + imported mods, when any). `skip_compile`
  bypasses resourcecompiler for tests. `is_up_to_date()` skips unchanged songs via a hash.
  Every recorded step carries a `pct` (0..=99) computed from `estimate_steps()`'s step
  budget (drives the UI progress bar); per-item failures `soft_fail` and the run continues
  with a failure roll-up at the end.
- `audio.rs` — ffmpeg probe + render (trim/gain/fade-in/fade-out via `build_af`).
- `digimod.rs` — the Jumpscares/Deaths (MoonahMasterUI, formerly DigiMaster; the
  `digimod` code names + serialized `digimod` project field keep the old name for
  compat) generator: proven HUD engine
  templates in `app/src-tauri/templates/digimod/` (base_hud hook + runtime-panel JS with
  CONFIG/LIBRARY injection markers), videos → VP9 webm (raw-shipped; panorama plays sound
  via generated `Moonah.*` events, one per shared library sound), PNGs → vtex via the
  panorama_image_list trick, base_hud compiles LAST (file:// refs resolve against the
  game tree). `merge_vpks` absorbs other base_hud UI mods (their panorama files ride
  raw; `inject_hooks` splices the engine hooks into THEIR base_hud). `import_from_vpk`
  adopts an installed MoonahMasterUI pak back into editable config (raw-extract the vjs_c:
  panorama resources embed source verbatim; VRF FileExtract can't do vjs_c); detection
  and import both fall back to the legacy `digi_master` stem / `Digi.*` prefix so old
  paks still work.
- `vpk.rs` — shells out to the C# helper.
- `install.rs` — one-click install into Deadlock's `game/citadel/addons`. Addons mount as
  `pakNN_dir.vpk` (NN = 01..99); a slot is "occupied" if any file there ends `pak<NN>_dir.vpk`
  (plain OR prefixed, e.g. `600744_pak07_dir.vpk`). `install()` picks the next free slot (or
  overwrites a caller-given one, backing up the occupant under `.eim_backups/`) and, when
  asked, adds the `citadel/addons` search path to the sibling `gameinfo.gi` if missing
  (with a `.gi.eim.bak`). Commands: `scan_addon_slots`, `install_to_game`.
- `packsync.rs` — Shared Pack profile sync (two people, one modpack, transport =
  any shared folder, typically a GitHub clone). Export walks the profile JSON
  **schema-blind**: every string that is an absolute path to something that exists
  (songs, icons, digimod media, adopted-entry source vpks, pack cache DIRS) is
  copied into the pack folder's `assets/` (app-data files keep their relative
  layout for stable git diffs; collisions get a path-hash salt) and rewritten to
  `pack://` form; import reverses against the reader's own clone, so pulls need no
  re-copy. Composite strings embedding paths (`lastCompiledHash`) are skipped via
  invalid-path-char detection. Writes starter `.gitattributes` (Git LFS for big
  types) + README once. Commands `export_shared_pack`/`import_shared_pack`; UI =
  Settings > "Shared Pack" (folder + Save/Load, `settings.sharedPackDir`); import
  resets `installSlot` to auto and folds `modExcludes`/`modCredits` arrays back
  into the path-keyed settings maps.
- `host.rs` — one-click custom-game hosting (no SteamCMD): patches `gameinfo.gi` for P2P
  dedicated-server mode and relaunches the client with `-dedicated`. Commands:
  `host_status`, `setup_hosting`, `revert_hosting`, `launch_host`, `launch_game`,
  `read_server_log`, `host_connect_id`.
- `rcon.rs` — minimal Source RCON client (port 27015) driving the in-app admin panel and
  the F8 in-game mod-menu overlay. Commands: `rcon_exec`, `rcon_ready`.
- `commands.rs` + `lib.rs` — Tauri command surface (registered in `lib.rs`
  `invoke_handler!`). **All backend types serialize camelCase** to match the TS side.
  `autodetect_paths` also returns the addons dir; `save_settings`/`load_settings` persist
  the (frontend-shaped) settings blob as `settings.json` in app-data. Notable command
  groups beyond the modules above: profiles (`list/save/load/delete/rename_profile`),
  custom-server config (`hero_roster`, `hero_detail`, `hero_config`, `item_config`,
  `global_config`, `world_config`, `randomize_config`), sound/particle browsing
  (`hero_voicelines`, `hero_sounds`, `browse_game_sounds`, `browse_particles`,
  `effect_preview`, `item_roster`, `item_detail`, `item_particles`), and the import /
  auto-discovery trio (`list_editable_events` — enumerate moddable events for
  "Fix for new patch" discovery; `import_pack_events` — scan a mod vpk for adoptable
  slots; `item_sound_index` — route imported item events to the Items tab).
  `download_tools` powers the wizard's one-click setup: downloads the prebuilt
  tools bundle (`TOOLS_BUNDLE_URL` in `lib/settings.ts`, a ~434MB zip of the
  **trimmed** CSDK — just `game/bin_tools` + `game/citadel/{bin,cfg,gameinfo,fgds}`,
  proven sufficient for audio + soundevents compiles — plus static ffmpeg/ffprobe)
  into app-data `tools/` via the System32-native curl+tar (bare names could hit
  MSYS/GNU tar, which chokes on `C:` paths). See "One-stop setup" under Build/run.
  Newer groups: digimod (`digimod_detected`/`list_ui_mods` — 4MB head-sniff of addon
  paks; NOTE a vpk dir tree stores ext/dir/stem as SEPARATE strings, so needles must be
  bare stems; `import_digimod`, `extract_video_audio`, `media_thumb` — ffmpeg thumbs
  disk-cached in app-data), UI Master (`list_ui_files`, `read_ui_file`,
  `push_ui_files`/`clear_pushed_ui` — compiles edits and drops them LOOSE into our own
  `citadel/eim_dev` dir mounted top-priority via `install::ensure_citadel_searchpath`;
  manifest-tracked for clean removal), and the one-click updater
  (`check_app_update`/`install_app_update` — GitHub latest release; numeric tags only,
  attach the NSIS `-setup.exe` asset to releases to light up "Install now").
  **Sync-command rule:** heavy commands MUST be `async` + `spawn_blocking` — sync Tauri
  commands run ON THE UI THREAD and freeze the window (this bit hero_detail/hero_images/
  list_ui_mods/check_app_update before they were wrapped).

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
(`.vsndevts_c` → KV3 text, used to import other mods and refresh vanilla data),
`texture` / `texturebatch` (`.vtex_c` decode, used for hero portraits and item icons),
`heroes` (hero roster/portrait queries).
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
`installSrcVpk`).

**Tabs.** The sidebar is resizable (drag handle on its edge; dbl-click resets; width in
localStorage) and organizes into four tinted section buttons: HEROES (mint #a7fff1),
ITEMS (orange), WALL ART (violet), and the "SOUNDS" master (sky) which nests the
`TAB_CATEGORIES` groups (Match / In-game / Game SFX) plus `ui`, `unsorted`, and
`replacesounds` (labeled "All Sounds") with animated collapse/expand. Slot groups:
(`intro`, `match`, `stingers`, `brawl`, `urn`, `rift`, `midboss`, `powerups`, `teamobj`,
`sinners` (the Sinner's Sacrifice soul vault - `soundevents/npc/neut_vaults.vsndevts`,
incl. `track_2.track_vsnd_files` scalar slots for the hit jingles), `shop`, `gameplay`,
`combat`, `mapsfx`, `ambience`, `npcs`, `ui`). Non-slot tabs: `items`
(Deadlock-style shop UI, per-item sound events, `ItemsTab`), `replacesounds` (loose-file
browser over ~79k game sounds, `SoundBrowser` + `OverrideEditor`), `unsorted`
(auto-discovered events from new patches; slots created dynamically with
`AUTO_SLOT_PREFIX`/`IMPORT_SLOT_PREFIX` ids), `customserver` (config editor + randomizer
+ hosting, `CustomServer`/`ServerLogPanel`/`lib/rconActions.ts`), `modcombiner`
(`ImportedMods` — behind `experimentalModCombiner`, but the tab stays visible while
mods are already bundled so nothing ships invisibly; bundled mods keep compiling
either way; each bundled mod card has a "retex" button opening `ModRetexture`:
pick any texture inside the vpk via `list_vpk_textures`, preview via
`decode_pak_texture`, drop art or hue-shift → `mod_texture_overrides`),
`posters` (replace in-world posters/signs/graffiti: `PostersTab` +
`src/data/posterManifest.json`, the atlas-rect index generated by
`tools/poster-manifest/` — NOTE the four `hideout/*` sheets (category "hideout":
the hideout's painting atlases, MODEL materials under `models/hideout/materials/`)
are HAND-ADDED, a manifest regen must keep them, and `poster_sheet` accepts
`models/` material paths for them — drop a PNG on a sheet region; compile decompiles the
`materials/overlays` material from the pak via the helper's `material` cmd, ffmpeg-
composites the art into the rect (+ white-fills the trans rect for cut-out posters),
strips VRF's "Compiled Textures" block, recompiles the `.vmat`, and stages the
`.vmat_c`+`.vtex_c` at vanilla paths), `jumpscares` (`DigimodTab` — appears when
`digimod_detected` finds the engine in installed paks, the project configures it, or
the plain `enableJumpscares` Preferences toggle opts in (build your own from the blank
`DEFAULT_DIGIMOD` template, no installed mod needed);
video cards use disk-cached ffmpeg thumbnails + hover-to-play, adding a video
auto-extracts its audio into the shared sound library, sounds have a Waveform clip
editor), `uimaster` (`UiMasterTab` + `PanoramaPreview`/`lib/panorama.ts` — browse/edit
panorama layouts+styles with an approximate live HTML preview and a push-to-eim_dev
test loop; behind `experimentalUiMaster`), `customserver` (behind `experimentalServer`),
and `effects` (VFX recolor, `EffectsBrowser`/`EffectPreview` — behind
`settings.experimentalEffects`; experimental toggles are AUTHORITATIVE: hidden tabs'
overrides are also excluded from compiles). `menuart` (`MenuArtTab`, always visible) replaces the game's screen art:
curated play-page mode-card/portrait slots + any `panorama/images/` path by
hand; previews decode via `decode_pak_texture` (app-data cached) and entries
are plain `iconMods` (`menuart_` id prefix), so the icon pipeline compiles
them with zero extra machinery. `packbuilder` (`PackBuilderTab`, always visible)
organizes pack content into named modules (the future split points for
standalone releases): App.tsx flattens every subsystem into stable content keys
(`slot:<id>`, `icon:<id>`, `sound:/effect:/poster:/herotex:<id>`,
`ui:<targetRel>`, `mod:<vpk basename>`, units `digimod`/`gameplay` - machine
independent on purpose so modules survive Shared Pack sync) and membership
lives in `project.modules` (frontend-only field like `digimod`; profiles
persist untyped JSON so Rust needs no schema). "Sort Core by content type"
seeds kind buckets NON-destructively (only moves unassigned items). Phase 2
(built): "Export modules" compiles each selected module into its own
standalone `pak01_dir.vpk` under `<chosen>/<module name>/` - same pipeline via
`buildCompileConfig` with module-filtered arrays + module-scoped
importedMods/credits + `exportOnly: true` (no stamps/install), gameplay gated
identically to CompileBar; and a live conflict banner (warn, never block)
flags modules shipping the SAME output file (the lower-addon-slot-wins
clobber): events relpath for merge slots vs stock ref for direct-replace
slots (shared rule `slotNeedsEventsMerge` + `directReplaceTarget`), poster
SHEETS not regions, digimod↔UI-Master both claiming base_hud; bundled vpk
interiors are NOT inspected (noted in UI). Phase 3 (built): "Package for
release" (on by default) zips each CLEAN module build (vpk + README, via the
`zip` crate: `packsync::package_release`, cmd `package_module_release`) and
writes a paste-ready `description.txt` (App.tsx `buildModuleReleaseText`:
what's-inside summary, install steps, module-scoped `buildCreditsText`
credits, tools-page plug); partial builds never get zipped; per-module Show
reveals the zip, "Copy text" copies the description. `particleguide` (`ParticleReference`,
always visible) is a read-only reference of every particle function class with
descriptions + the values vanilla ships; its data (`src/data/particleCatalog.json`)
is generated by `tools/particle-catalog/` (decompile sweep → `build-catalog.mjs` →
`build-app-data.mjs`; curated text lives in `annotations.mjs`; `build-graph.mjs`
adds `particleGraph.json` = parent/child graph + vdata owners) — regenerate after
game patches, the app never mines at runtime; classes absent from the previous
shipped JSON get a NEW badge. The effect Inspector (`ParticleOutline`, opened from
the Guide or an Effects row) outlines any particle via `read_particle_text` +
`lib/kv3.ts`, walks to the root system via the graph, deep-links functions into the
Guide, and `open_in_particle_editor` stages the source tree into the CSDK's
`eim_inspect` addon and launches `Deadlock_with_tools.exe -asset <vpcf>`. Effects
recolors support gradient drivers (age/noise/index/rope/time + custom stops) and
every effect source is header-normalized to vpcf63 before compiling
(`normalize_vpcf_header`: the CSDK hard-fails on vpcf64+ and silently strips
newer ops from vpcf61). The Heroes tab drills portrait grid (`HeroGrid`)
→ per-hero abilities/sounds/voicelines (`HeroDetail`, `HeroSoundsSection`,
`VoicelinesPanel`). `ModMenuOverlay` is a separate always-on-top window (F8 in-game mod
menu / RCON admin).

**Chrome.** A ⚙ cog opens `SetupSection` as a modal (paths + toggles like
`includeUiSounds` and `experimentalEffects`); `ProfileSwitcher` in the top bar
switches/creates/renames named mod configs; sticky `CompileBar` drives compile **and
install** (Add-next-free vs Replace-slot-N, install-after-compile, patch-gameinfo, a
one-shot "Compile, Install & Launch", plus "Fix for new patch" = refresh vanilla +
rediscover events + recompile, and "Full merge" pack import). `FirstRunWizard` shows on
first launch (`firstRunDone`) and runs one-click setup (autodetect → import live game
music data). Waveform peaks are cached in-memory (`lib/peaksCache.ts`); `lib/songHash.ts`
fingerprints a song to skip unchanged recompiles. `lib/dataCache.ts` session-caches all
game-data reads and `preloadGameData` warms every hero's detail/sounds/images at boot
(HeroGrid shows the progress). The Backdrop renders the user's sigil (two inlined SVGs
from `app/public/backdrop/`, class names namespaced per file — inline SVG styles are
document-global) tinted by the active tab accent, with a JS spin driver that kicks on
category switches. A compile shows a 0-100% bar plus the "compile crew" sprites
(`app/public/loading/`). The sound clipboard (`lib/soundClipboard.ts`) copies a track +
its edits between slots.

### Adding a new tab / slot
Add the slot(s) with a new `group` + `events_relpath` in `project.rs`
`default_for_match_intro()`, add a `TAB_LABELS` entry and an `accentFor` color in
`App.tsx` (and add the group to `TAB_CATEGORIES` there if it belongs under a collapsible
category like "Map"). Note `reconcileProject()` in `App.tsx` merges saved state with the
current defaults, so new default slots appear for existing users automatically.

## Repo conventions / notes

- Extracted Valve game content and tool binaries are **git-ignored** and not shared:
  `ModFiles/`, `sounds/`, `soundevents/`, `compilerstuff/`, `VanillaFiles/`, plus build
  output. Several tests read `ModFiles/soundevents/music.vsndevts`, so they require those
  files present locally (the e2e compile test additionally needs the CSDK toolchain).
- Deadlock is installed at `D:\SteamLibrary\steamapps\common\Deadlock`; the CSDK toolchain
  used for verified compiles is `Reduced_CSDK_12`. Real paths are configured at runtime in
  the app's Setup panel (and auto-detected via `autodetect_paths`).
- **`app/src/App.css` must stay imported in App.tsx** (it silently wasn't for weeks —
  every animation was dead). It may contain ONLY eim-* animation/effect rules; never
  restyle bare elements (`button`, `input`, `:root`) globally — that fights Tailwind.
- **UI copy style: never use em-dashes ("— ") in user-visible text** (labels, hints,
  toasts, Rust step details). Use " - ", commas, colons. Also: no emoji in the UI —
  monochrome glyphs (✕ ▶ ⚙ ⧉) that inherit text color only.
- **Browser preview debugging:** with the dev server up, the real frontend renders in a
  normal browser at `localhost:1420` (a `__TAURI_INTERNALS__` guard skips native-only
  hooks; invoke-backed data just no-ops). Claude can drive Chrome against it to verify
  UI changes visually — use it instead of guessing at geometry/styling.
- **Icons:** window/taskbar icon comes from `app/src-tauri/icons/` (generated via
  `npx tauri icon <1024px png>`; the source art is `app/public/MMMIcon.svg`). Changing
  icon files does NOT trigger a rebuild — touch `build.rs`/`tauri.conf.json` so the exe
  re-embeds them; Windows may also cache stale icons (`ie4uinit.exe -show`).
- `citadel/grimoire` in the user's gameinfo.gi is NOT vanilla — the third-party GRIMOIRE
  launcher injected it. Our dev-push uses our own `citadel/eim_dev` instead.
- Vite serves `app/public/` case-SENSITIVELY even on Windows (logo 404'd over
  `MMMLogo.svg` vs `MMMlogo.svg`).
- The user's local `ModFiles` events file can be **stale** vs the installed game (stock
  refs drift); the helper `decode` has a fuzzy stem-prefix fallback for previews, and
  `refresh_vanilla` re-decompiles the live pak to fix drifted stock refs. The
  settings-side `knownSoundEvents` baseline (seeded on first "Fix for new patch") is
  what makes later fixes surface only *new* patch events in the Unsorted tab.
