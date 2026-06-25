# Deadlock Match-Intro Music Tool — Build Spec

## What we're building

A local desktop app that manages custom music tracks for Deadlock's match-intro
"playlist" sound events. It gives a clean single-page UI to add/remove/reorder
songs per side, trim and gain-boost audio with preview, compare your new clip's
waveform against the stock in-game intro, then one-button compile everything into
the game's folder structure — optionally packing it into a ready-to-use `.vpk`.

It must do all this **without ever hand-editing the game's sound event file by hand
and without destroying other mods** that share that same file.

### The manual workflow this replaces

Today the user does this by hand:
1. Pick an mp3.
2. Cut it down in FL Studio to match the in-game intro length, and boost it
   (in-game music is quieter than raw files).
3. Compile the mp3 to Valve's compiled sound format.
4. Place it in the same folder structure the game expects so references resolve.
5. Open the music sound-events file and add the mp3 to the intro array.
6. Compile the sound event + mp3 and pack into a `.vpk` (currently done via
   Source 2 Viewer).

The app automates steps 2–6.

### The game mechanic we're hooking into

When a Deadlock match starts, the game fires one of two events depending on which
side ("god") you're on: **King** (the Hidden King) or **Mother** (Archmother). Each
event holds a `vsnd_files` array. When the event fires, the game **picks one random
entry from that array** to play. So adding more entries = more possible intro songs.
That randomized array IS the "playlist" — there's no other mechanism to build.

The two target events are:
- `Music.MatchIntro.MatchStart.King`
- `Music.MatchIntro.MatchStart.Mother`

(Write the app so more events could be managed later — e.g. kill-streak stingers,
brawl overtime — but v1 only needs these two.)

---

## Feature checklist (the user's exact wants)

- [ ] Drag and drop an mp3 to add it to a side.
- [ ] Show the **waveform of the new clip compared to the stock in-game intro**
      audio for that side.
- [ ] **Trim** and **boost (gain)** controls, each with a **preview** (play the
      processed result).
- [ ] Show **what other sounds are currently in the array** for each intro
      (including other people's mods), so the user sees the full pool.
- [ ] Keep **most/all information on one page**.
- [ ] On compile: **never create a brand-new music sound event**, never alter any
      other event in the file — only **add to / subtract from** the two intro arrays.
- [ ] **Auto-compile** the sound event + mp3s.
- [ ] **Auto-recreate the folder structure** with the compiled files.
- [ ] **Optionally pack into a `.vpk`** (e.g. `pak01_dir.vpk`) so it drops straight
      into Deadlock mods. If the user prefers, output **just the folder structure**
      with compiled files and skip packing.

---

## Tech stack

- **Tauri** (Rust backend + web frontend). Small native binary, fast file I/O, easy
  shelling out to external tools.
- **Frontend:** React + TypeScript, Tailwind CSS, shadcn/ui, Motion (formerly
  Framer Motion). Aesthetic: minimalist, dark, tasteful motion. Single-page layout.
- **Waveform/preview:** wavesurfer.js (waveform render, draggable trim handles,
  playback).
- **Audio processing:** ffmpeg (trim + gain). Bundled or located on PATH.
- **Sound/event compiler:** Valve **Source 2 `resourcecompiler.exe`** (path set by
  user in settings).
- **VPK pack/unpack:** see the dedicated section below. Reference implementation is
  Valve Resource Format's **ValvePak** library.
- **Rust backend:** all file I/O, KV3 parse/write, ffmpeg calls, resourcecompiler
  calls, VPK pack/unpack calls, backups.
- **Frontend:** all UI, project state, drag-drop, sliders, waveforms.
- One mod project managed at a time.

---

## Core design principle: MERGE, NEVER REPLACE

The game's sound event file (`.vsndevts`, KV3 text) is **shared by many mods**. The
real file already contains dozens of other people's additions (Halo and League
sounds in the kill-streak arrays, ~27 brawl-overtime tracks, etc.). The app must
**only ever touch the specific array entries it owns** and leave everything else
intact.

The app keeps an authoritative list (in `project.json`) of the exact sound names it
has added. On compile it:
1. Reads the **current, live** sound-events data (from a source `.vsndevts` on disk,
   or by extracting/decompiling the `.vsndevts_c` out of an existing pak — see
   "Reading existing data").
2. For each managed event, edits **only** the array entries whose names match the
   app's owned list. The stock first entry and all foreign (other-mod) entries are
   never matched and never removed.
3. Writes the file back, after backing up the previous version.

`project.json` is the source of truth for **our** entries. The on-disk events file
is the source of truth for **everyone else's**. Compile = splice ours into theirs.
The app must **never emit a fresh standalone event** or rewrite the whole file from
its own template — it edits the real file in place at the array level.

---

## The file format (confirmed from a real pack)

The events file is **KV3 text** with this header line:

```
<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->
```

One big object. Each top-level key is an event name; each value is a block of
properties. The two target events look like this in the real file:

```
	Music.MatchIntro.MatchStart.King = 
	{
		base = "Base.Music.2d"
		volume = 3.0
		vsnd_files = 
		[
			"sounds/music/match_intro/music_match_intro_king_160bpm.vsnd",
			"sounds/music/match_intro/kingintro.vsnd",
			"sounds/music/match_intro/kingintro2.vsnd",
		]
		vsnd_duration = 27.0
	}
	Music.MatchIntro.MatchStart.Mother = 
	{
		base = "Base.Music.2d"
		volume = 5.0
		vsnd_files = 
		[
			"sounds/music/match_intro/music_match_intro_mother_160bpm.vsnd",
			"sounds/music/match_intro/motherintro.vsnd",
			"sounds/music/match_intro/motherintro2.vsnd",
			"sounds/music/match_intro/deltamotherintro.vsnd",
		]
		vsnd_duration = 28.874989
	}
```

In both, the **first** array entry is Valve's stock track; everything after is a mod.

### Critical format facts

- **References use the `.vsnd` (source) extension, NOT `.vsnd_c`.** Source 2
  references the source name; the compiler resolves it to the compiled `.vsnd_c` at
  load. So the string written into the array ends in `.vsnd`, but the actual file the
  app compiles and places on disk ends in `.vsnd_c`. **One naming rule must generate
  both, differing only by extension.** This is the single easiest bug to introduce.
- Paths are content-relative, e.g. `sounds/music/match_intro/mysong.vsnd`.
- `vsnd_duration` is a single value on the event, not per-array-entry. **Unknown
  whether it must cover the longest clip or is derived at runtime.** Default: recompute
  to the max trimmed clip length among array entries on compile, but make it
  overridable per event. Verify in-game (the compile loop makes this cheap).
- The KV3 has **no comments**, so we can't tag entries inline. Identify owned entries
  by exact name match against `project.json` (see below).

---

## VPK packing & reading (this is how Source 2 Viewer does it)

Source 2 Viewer packs/reads VPKs using the **ValvePak** .NET library
(github.com/ValveResourceFormat/ValvePak, MIT). Key facts that shape our design:

- The VPK format is the **uncompressed** archive format used by Source 2. You open
  and write **`pak01_dir.vpk`** (the `_dir` file is the directory; `pak01_001.vpk`
  etc. are data chunks). The user's chosen output name like `pak01_dir.vpk` is
  exactly right.
- **Writing** a pak is conceptually: add each file by its content-relative path, then
  write. ValvePak's API is literally:
  ```csharp
  using var package = new Package();
  package.AddFile("sounds/music/match_intro/mysong.vsnd_c", bytes);
  package.AddFile("soundevents/.../the_events_file.vsndevts_c", bytes);
  package.Write("pak01_dir.vpk");
  ```
  The path passed to `AddFile` becomes the path **inside** the pak — so our recreated
  folder structure maps 1:1 into the VPK. Get the folder layout right and packing is
  trivial.
- **Reading** a pak (same library) opens `pak01_dir.vpk`, finds an entry by path, and
  extracts its bytes. We use this for the "Reading existing data" step and for
  pulling the stock intro audio for the waveform comparison.

### Implementation decision for a Rust/Tauri app

ValvePak is **C#/.NET**, not Rust. Three options, in recommended order:

1. **Bundle a tiny C# CLI helper built on ValvePak** and shell out to it from Rust
   (same pattern as ffmpeg/resourcecompiler). Most reliable — uses the exact library
   Source 2 Viewer uses, so paks are guaranteed game-valid (correct CRC32s/hashes).
   The wrapper is ~30 lines: `pack <folder> <out.vpk>` and `extract <vpk> <path>
   <out>`. ValvePak is MIT, so bundling is fine. **Recommended for v1.**
2. **Use a maintained Rust VPK crate that supports Source 2 *writing*.** Keeps the
   backend pure Rust. Only choose this if a solid write-capable crate exists — verify
   it produces game-valid Source 2 paks before committing. (Many Rust VPK crates only
   read, or only handle Source 1.)
3. **Port the writer to Rust.** Most work, most risk of subtly-invalid paks. Skip.

Do NOT hand-roll the binary VPK format inline — hashes/CRC32s/signatures make that
error-prone. Use ValvePak (via helper) or a proven crate.

---

## Reading existing data (for the merge + the stock waveform)

The app needs the current sound-events data and the stock intro audio. Source of
truth, in priority order:

1. **A source `.vsndevts` on disk** (preferred — KV3 text, no decompile round-trip
   risk). Read directly.
2. **A `.vsndevts_c` inside an existing pak** — extract via the VPK reader, then
   decompile to KV3 text (ValveResourceFormat handles `vsndevts`). Use this when no
   source file exists.

For the **stock waveform comparison**: the stock intro is a compiled `.vsnd_c`
(inside a pak). wavesurfer.js can't read `.vsnd_c` directly. So either:
- extract + decode the stock `.vsnd_c` to a playable PCM/wav (ValveResourceFormat
  decodes `vsnd`), then feed wavesurfer; or
- let the user point at a source audio file for the stock track if they have one.
Plan for the decode path since the user usually only has the compiled asset.

---

## Data model: `project.json`

```jsonc
{
  "version": 1,
  "gameContentRoot": "/abs/path/.../content-root",   // base for recreated structure + .vsnd_c output
  "soundFolder": "sounds/music/match_intro",          // content-relative folder for refs & files
  "eventsFile": {
    "sourceVsndevtsPath": "/abs/path/to/source.vsndevts", // preferred if present
    "fromPakPath": "/abs/path/to/existing/pak01_dir.vpk", // fallback: extract+decompile from here
    "internalEventsPath": "soundevents/.../music.vsndevts_c" // path inside that pak
  },
  "tools": {
    "ffmpegPath": "ffmpeg",
    "resourceCompilerPath": "/abs/path/to/resourcecompiler.exe",
    "vpkHelperPath": "/abs/path/to/valvepak-helper.exe"     // the C# CLI wrapper
  },
  "output": {
    "mode": "folder" | "vpk",          // user's optional pack choice
    "vpkName": "pak01_dir.vpk",          // used when mode == "vpk"
    "outputDir": "/abs/path/to/output"   // where folder structure / vpk is written
  },
  "events": [
    {
      "side": "King",
      "eventName": "Music.MatchIntro.MatchStart.King",
      "stockEntry": "sounds/music/match_intro/music_match_intro_king_160bpm.vsnd",
      "vsndDurationMode": "auto" | "manual",
      "vsndDurationManual": null,
      "songs": [
        {
          "id": "uuid",
          "label": "My Cool Song",       // shown in UI
          "sourceMp3": "/abs/path/to/original.mp3",
          "soundName": "mysong",          // base name; drives ref + .vsnd_c path
          "trimStart": 0.0,               // seconds
          "trimEnd": 27.0,                // seconds
          "gainDb": 6.0,                  // decibel boost via ffmpeg
          "order": 0,                     // position among app entries in array
          "lastCompiledHash": null        // hash of {trim,gain,sourceMp3}; null if never compiled
        }
      ],
      "previousOwnedNames": ["mysong"]    // persist so renames/removals clean up correctly
    },
    {
      "side": "Mother",
      "eventName": "Music.MatchIntro.MatchStart.Mother",
      "stockEntry": "sounds/music/match_intro/music_match_intro_mother_160bpm.vsnd",
      "vsndDurationMode": "auto",
      "vsndDurationManual": null,
      "songs": [],
      "previousOwnedNames": []
    }
  ]
}
```

---

## The path-derivation rule (single source of truth)

Given a song's `soundName` plus `soundFolder` and `gameContentRoot`, ONE function
produces all derived values. Nothing else may construct these by hand.

```
referenceString    = `${soundFolder}/${soundName}.vsnd`
                     // e.g. "sounds/music/match_intro/mysong.vsnd" -> written into the array
compiledOutputPath = `${gameContentRoot}/${soundFolder}/${soundName}.vsnd_c`
                     // the actual compiled file placed on disk / into the pak
vpkInternalPath    = `${soundFolder}/${soundName}.vsnd_c`
                     // the path key used when AddFile-ing into the vpk
uiLabel            = song.label
```

`soundName` must be unique within the project, lowercase, no spaces (sanitize on
input). Reject or auto-rename collisions.

---

## Compile pipeline (the one button)

Per event, per song:

1. **Process audio (ffmpeg):** trim `[trimStart, trimEnd]` and apply `gainDb`.
   - Trim: `-ss {trimStart} -to {trimEnd}`
   - Gain: `-af "volume={gainDb}dB"` (simple, predictable; offer `loudnorm` later)
   - Output an intermediate file to a staging dir.
2. **Compile audio -> `.vsnd_c` (resourcecompiler):** output to `compiledOutputPath`.
   *(Exact flags/invocation: USER MUST PROVIDE — see below.)*
3. **Skip unchanged:** if `hash(trim,gain,sourceMp3) == lastCompiledHash` and the
   `.vsnd_c` exists, skip. Update hash after a successful compile.

Once per file:

4. **Read live events data** (source `.vsndevts`, else extract+decompile from pak).
5. **Backup** the current events file to `.bak/{name}.{ISO8601}.vsndevts` BEFORE
   writing. Keep last N backups.
6. **Merge per managed event:**
   - Take the event's existing `vsnd_files` array.
   - Partition into **stock** (`stockEntry`), **owned** (match current +
     `previousOwnedNames`), **foreign** (everything else).
   - Rebuild: `[stockEntry, ...foreign (unchanged order), ...owned (rebuilt from
     project.json in `order`)]`.
   - Update `previousOwnedNames` to the new owned set.
   - Recompute `vsnd_duration` if `auto` (max trimmed length among array entries),
     else use manual value.
7. **Write KV3 back**, preserving the header line and the original text style (tabs,
   `key =\n{` layout, trailing commas in arrays) so diffs stay minimal.
8. **Compile events file -> `.vsndevts_c`** via resourcecompiler.
   *(Exact invocation: USER MUST PROVIDE.)*
9. **Recreate folder structure** under `output.outputDir`, placing every `.vsnd_c`
   and the `.vsndevts_c` at their content-relative paths.
10. **If `output.mode == "vpk"`:** pack the output folder into `vpkName` via the VPK
    helper (`AddFile` each file by its content-relative path, then `Write`).
    **If `output.mode == "folder"`:** stop after step 9, leave the structure on disk.
11. Report success/failure per step in the UI with clear errors.

### Safety rules for the merge (must hold)
- Never delete or reorder a foreign entry.
- Never delete the stock entry (a future toggle could exclude it from the pool;
  default keeps it).
- Never create a new event or rewrite unrelated events.
- Always back up before write.
- If KV3 parse fails or the file looks unexpected, abort and surface the error — do
  not write.

---

## UI spec (single page, minimalist, dark)

Tabbed or two-column by side (King / Mother), everything visible at once.

**Per side panel:**
- Header: side name + count of songs in the pool.
- **Stock track** pinned at top, marked "Valve original (always in pool)", with its
  waveform available for comparison; not editable/removable.
- **Foreign entries** shown read-only ("N tracks from other mods — preserved"), so
  the user sees the full array contents but understands the app won't edit them.
- **App-managed song cards**, each with:
  - Editable label.
  - **Waveform of the new clip**, with the **stock intro waveform shown for
    comparison** (overlaid or stacked) so the user can match length/energy.
  - Draggable trim handles -> `trimStart/End`.
  - Gain (dB) slider with live readout.
  - **Preview** button: plays the processed (trimmed + boosted) result.
  - Drag handle to reorder -> `order`.
  - Remove button.
  - Status chip: `New` / `Compiled` / `Out of date` (out of date = current hash !=
    lastCompiledHash).
- **Drop zone** ("drop an .mp3 here to add to this side"): creates a song with
  sensible defaults (label & soundName from filename, trim = full length, gain =
  default e.g. +6 dB).

**Global controls:**
- **Output choice:** "Folder only" vs. "Pack into .vpk", with the vpk name field
  (default `pak01_dir.vpk`) and output directory.
- **Compile** button with progress + per-step log. Disabled while running.
- **Settings:** the tool paths and the events-file source (source `.vsndevts` path,
  or pak path + internal events path), all validated for existence.
- Subtle Motion transitions on add/remove/reorder.

---

## What the USER must provide / confirm

These are the remaining unknowns; everything else is specified.

1. **Exact `resourcecompiler.exe` invocation + flags** for (a) mp3/wav -> `.vsnd_c`
   and (b) `.vsndevts` -> `.vsndevts_c` — including working dir, input/output path
   expectations, and any `-game`/`-content` args.
2. **The content vs. game root paths** so `gameContentRoot` + `soundFolder` resolve
   correctly and match the reference strings.
3. **`vsnd_duration` behavior** — test whether it must cover the longest clip or is
   derived at runtime; adjust the auto/manual default.
4. **The events-file source** — confirm whether a source `.vsndevts` exists, or only
   a `.vsndevts_c` inside a pak (then the extract+decompile path is required and you
   confirm which pak + internal path).
5. **VPK helper choice** — confirm option 1 (bundle a C# ValvePak CLI) vs. a verified
   write-capable Rust crate.

---

## Build order

1. Tauri scaffold + Settings screen + path/source validation.
2. KV3 read/parse + write. **Round-trip the real file and diff to confirm formatting
   fidelity — this is the riskiest correctness piece, nail it first.**
3. VPK helper: pack a folder, extract a file. Verify the game accepts a produced pak.
4. `project.json` load/save + data model.
5. UI: side panels, song cards, drop zone, sliders, dual waveform (new vs stock).
6. ffmpeg processing (trim + gain) + preview; stock `.vsnd_c` decode for comparison.
7. resourcecompiler integration (user fills in invocations).
8. Merge logic + backups.
9. Wire Compile end-to-end, including folder-only vs. vpk output branch.
10. Test in-game; iterate on `vsnd_duration`.

## Definition of done (v1)
- Drop an mp3 onto King or Mother; see its waveform next to the stock intro; trim,
  boost, preview, reorder, remove.
- Choose "folder only" or "pack into pak01_dir.vpk".
- Hit Compile: `.vsnd_c` files land in the recreated structure; the `.vsndevts` gains
  exactly the right array entries with **all other mods' entries untouched and no new
  events created**; if chosen, a valid `.vpk` is produced.
- A backup of the previous events file exists.
- The new intro track plays in-game, randomly selected from the pool.
