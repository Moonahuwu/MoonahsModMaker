# Moonahs Mod Maker - Changelog

All notable changes since 1.0.4. Download: https://gamebanana.com/tools/23422

## 1.4 (2026-09-03)

### Animated paintings and signs (NEW)
- Wall Art can now play a GIF or video on in-world surfaces: the big painting above the hideout fireplace, plus 16 Midtown sign surfaces across two hosts (library paintings, the item ads outside the T1 camps, adframes, standees, a square billboard) - pick a surface, pick the file, compile, done. The animation is compiled into your pack like everything else: installs with your addon, joins Shared Pack sync, no separate files. Frames pack into a texture grid and a shader expression steps through them in game; the hideout bakes the room's dim warm light in so the picture sits naturally.
- Wall Art is now its own sidebar section with two tabs, Static Art and Animated Art, and you can fill AS MANY animated surfaces as you like - every sign gets its own art, speed and fit at once (the compile rebuilds the host model with one quad and one material per animated surface). The Wall Art section sits right under Sounds, and a filled wall stays tidy: click a tile to open its settings in one compact panel, with "Apply look to all" to copy one tile's fit and speed across the whole wall. Per-surface texture size is tiered by how many surfaces animate on one host (1-2: 8192px, 3-4: 4096px, 5+: 2048px) so a fully filled wall stays easy on video memory, and hover-played video previews release their memory as soon as you move away.
- "Modified only" now correctly keeps Wall Art visible when you have poster art queued (it used to hide the tab). The Animated tab shows every surface as a tile with its REAL in-game shape, grouped by host - your art renders inside the tile exactly as it will be cropped in game (GIFs animate right in the tile, videos play on hover), the hideout tile can preview the room's lighting.
- Fit options like regular posters: Fill (crop the overflow, with a position pick), Fit (letterbox), or Stretch - plus speed (or the source's own rate) and a frame cap. A still image works too: it becomes a static picture on the surface (handy for the Midtown signs, which have no regular region). The static hideout portrait sheet points at the Animated tab with a "can be animated" tag.
- A surface that cannot be read no longer sinks the wall: the compile drops just that surface, builds the rest, and retries the dropped one automatically on your next compile. Failed extractions now report the actual ffmpeg error (and the exact command) instead of three lines of progress noise, and leftover frames from an interrupted run can never pad a later build.
- Technique, host research and surface data by goldenboy44 (leonyarov), used with permission - check out the original Dynamic Paintings web tool at gamebanana.com/tools/23828. Midtown surfaces are marked beta, matching his own tool.

### Wall Art: missing signs found, hideout paintings fixed, "unused" explained
- 13 new sheets under Signs & Billboards: the street poster collages, billboards, the museum banner, hologram and six neon boards (the game's materials/signage/ tree) were never scanned into the manifest, so a whole family of in-world posters and signs simply was not offered. They start without pre-drawn regions - use the region editor to outline the poster you want (or replace the whole sheet).
- Hideout painting sheets load again: "Couldn't load the sheet texture: no color texture in models/hideout/..." was the tab rejecting color textures that live under models/ (all four hideout sheets were hit).
- "Unused" now says what it means: no MAP geometry samples that art - but sign props and models can still show it in game (the map scan cannot see those), and replacing an unused region still compiles and works. The toggle description and the amber chips explain this now; some unused entries really are cut content.

### Jumpscares: compiling on the downloaded tools
- Compiling a Jumpscares/Deaths mod with the app-downloaded compile tools failed ("resourcecompiler exit 1" with only localization warnings shown). Two fixes: the app now stages the one tiny file the download bundle is missing (core's panorama_config.txt, taken from your own game files) before compiling - panorama UI, images and the sounds batched after them all compile again; and compile errors now show the compiler's ACTUAL error lines instead of the first warnings it printed, so the next report says what really broke. Same fix applies to UI Master pushes.

## 1.3 (2026-08-25)

### Model Replacement: ragdolls work again
- Models built through the tool had no ragdoll: the decompile that produces the editing kit reconstructs the physics BODIES (hulls and per-bone capsules) but never the JOINTS between them, so the rebuilt model compiled with an empty joint list and reviewers rejected submissions for it. The tool now reads the joints straight from the original compiled model and regenerates them into the build (cone and twist limits, friction, collision flags, exact anchors). Verified against the real compiler: the rebuilt model has the same 18 joints as vanilla Haze to within 0.0002 units. Existing kits pick this up automatically - re-pick the hero once if the build log says the kit predates the physics cache.
- "Open in ModelDoc" (and the particle editor) now tell you up front when the compile tools are the downloaded compile-only bundle: those editors need the full Deadlock SDK with the game content (game/core and the citadel pak), which the bundle does not include - before, the tools opened and died on "can't open a citadel file".

### Model Replacement: mesh files with spaces in the name
- A mesh file named with spaces or other odd characters ("Harlem Ivy after rigging.fbx") failed every build with "RenderMeshFile: ... Node ... resolve failure". The mesh is now staged under a plain name (Harlem_Ivy_after_rigging.fbx) and the build log says so - rename nothing, just build again. Reproduced and verified against the real CS2 compiler.

### Settings: paths are checked properly, and fixed for you
- Pasting a folder where the pak01_dir.vpk file belongs (or a chunk like pak01_000.vpk, a disk path in Addon name, an absolute Sound folder) used to show a green check and then fail everywhere with baffling errors ("Access to the path ... is denied", "not in cache" for every sound file). Settings now checks each path for what it needs to BE, says what is wrong right under the field, and offers a one-click Fix when it can tell where the path should point - the Game pak is found from any folder inside your Deadlock install. Auto-detect (and every start of the app) applies those fixes automatically.
- Auto-detect also finds Steam libraries on other drives (D:\SteamLibrary, F:\Games\Steam, ...) that the registry lookup misses, e.g. when the app was started as a different admin account.
- Refresh game data tells you when the Game pak is not the pak file (and where it found the real one) instead of listing every file as "not in cache". The Events chip is now "Game data" and says how to fill it.
- Installing into a fresh Deadlock that has no addons folder yet creates it instead of failing.

### Hero textures: Ivy's hollow black eyes fixed
- Recoloring or reskinning some heroes (reported on Ivy) could turn parts of them solid black - most visibly her eyes. The recompile sometimes creates small helper textures with new names, and the build left them out of the vpk; when the game couldn't find one anywhere the whole material broke. Every texture a recompiled material actually uses now ships in the vpk (verified against the real compiler on all four of Ivy's materials). Heroes like Paige only worked by luck - their helper textures happened to match files the game already has. Just recompile, nothing else to change.

### Mod combiner: import a folder, live
- Import a FOLDER of loose mod files (game layout: sounds/, particles/, materials/, ...), not just a .vpk - new "Import a folder…" button, or paste the folder path. The folder stays linked live: it is re-read on every compile, so edits you make in it land in the next build automatically - perfect for a mod you are still working on. Its card shows a "live folder" tag.
- Works with the existing "Decompile a .vpk" button as a full edit loop: decompile any mod into a folder, import that folder, then open and tweak its files freely - great for merging mods and adjusting what they override.
- Housekeeping files a working folder can carry (.git, .vscode, __MACOSX) never ship in the built vpk and stay out of the review list.

### Track editor: layers, effects, live preview
- Layers got a proper mixer: a "Length" choice per track (your clip / longest layer / custom seconds) so a long original can ring out under a short hit (anything past the end shows red-hatched), per-layer fade in/out and "duck" (lower your track while the layer plays), mute, a label column with the game's original marked as "Original", and a "Yours starts at" delay so your track can come in after the original.
- Effects on any track or layer: Reverse, Pitch (semitones and speed independently), EQ presets (radio, telephone, muffled, bass, bright, or custom), Crush, Chorus/Flanger/Tremolo, Compress, Reverb (room, hall, cave, slapback), plus Limiter and "Match loudness" (measures the game's original and matches your bite to it - works on very short clips too). Effects apply live while the preview plays; the compiled sound is rendered by ffmpeg with the same settings.
- Editor feel: typed start/end fields, Space to play, [ and ] to set the trim at the playhead, arrow-key nudging, Ctrl+Z undo, loop tracks preview looped, a level meter with a clip warning, and "Match length" to trim exactly to the original.

### Sounds: every sound event, Most used vs All
- Every sound tab now has a "Most used | All" switch. Most used is the curated set plus anything you pinned or changed; All lists every sound event the tab covers (grouped by game file, searchable, with a preview button) and turns any of them into a normal slot the moment you open it. Layered and per-track sounds (the hideout ambience close/mid/far layers, the 8-track events) are listed as their own rows.
- Pin any sound (the flag on a row or a slot) to put it in Most used. "Reset pins to shipped" goes back to the set the app ships with. The shipped set now includes the stat-box and crate breaks, the stat / soul pickups, souls gained, hit / kill / death feedback, parry, shield break, stun, zipline, trooper and guardian sounds, and two ambience loops.
- New Combat tab: the hit, hurt, status-effect and player feedback sounds (damage, status_effects and player files) live there now; the crit slots moved over with their tracks. Gameplay keeps last hit, deny, souls and the rest of gameplay.vsndevts. Map SFX, Ambience and NPCs are always visible too.
- Misc / Search: one "Find a sound" box over every sound event in the game (event name, file, or a plain word like crate or gold), grouped by tab, with a Go-to-tab jump that opens the sound right where it lives.

### Sounds: Rift
- The four "In the rift" loop slots (main, contested, blocked, approaching/FX) are real random pools now: add several tracks to a layer and the game picks one at random each time it starts, like every other slot. Before, only the first track of a layer ever played. Your existing rift tracks carry over untouched - just recompile. (Loop tracks still want Looping turned on.)

### Heroes
- Billy: the tracks you had on "Blasted (E)" from the old flat Heroes tab now show up on Billy's Blasted card (Ambient Looping) - they were compiling but invisible in the drill-in, with an empty twin slot next to them. Pack Builder module membership follows.
- Ability cards no longer pull a hero's regular gun, reload, zoom and landing sounds onto an ability just because the ability also fires the gun (Grey Talon's Rain of Arrows listed his whole rifle; Werewolf's Slamfire listed the regular rifle shots). Those live in "More sounds" under Gunfire / Movement.
- Sounds whose Valve original is a file borrowed from somewhere else (Billy's Blasted healing plays Rescue Beam's heal clip; Slork's invisibility uses Haze's smoke bomb; Ivy's air drop uses Stasis Bomb / Silence Wave) now say so under the slot instead of looking mis-filed. They are the real game data: replacing one only changes that hero event.
- Three ability sounds that showed with an empty title (Grey Talon / Shiv / Slork impact rows) are named now.

## 1.2 (2026-08-18)

### Model Replacement
- Use models from other mods: pick any mod's pak01_dir.vpk, choose a model inside, and the app extracts it with its textures and converts it for your target - e.g. turn a soul container mod into an urn mod. No fbx/dmx needed. The mesh picker also accepts .glb/.gltf files directly (converted via Blender).
- The Build button now streams every step live and tells you the expected time (fast build 1 to 3 minutes, full 10 to 20) - it looked stuck before. A genuinely stuck compiler is stopped after 40 minutes with what to check.
- The CS2 Workshop Tools banner now checks that the Workshop Tools DLC is actually installed, not just that CS2 is (a CS2 install without the DLC used to fail only at Build), and has one-click Steam buttons to install CS2 and the DLC.
- Auto-rig and Fix model moved behind Settings > Experimental ("Auto-rig and Fix model (Blender)"), off by default. Two fixes for how they broke models: Auto-rig refuses a model that is already rigged to the hero instead of throwing the rigging away, and Fix model converts meter/centimeter scenes to game units so the result isn't tiny or huge.
- Fixed: a pack containing only a model swap could not compile (the Compile button stayed off until some unrelated content existed).

### Heroes
- Fixed missing hero backgrounds for Paige and Lady Geist (the game stores them under different names).
- Fixed the Textures section disappearing for Infernus: his materials live in a different folder than his model. Material lists now come straight from the model, which also makes them more accurate for a few other heroes.

### Pack Builder
- Bundled mod rows have a "contents" expander: see every model, particle, sound and file inside the vpk, and exclude the parts you don't want shipped (per file or per category). Exclusions apply to compiles and module exports; the vpk on disk is never changed.
- Search box: find any content by name, kind or tab, shown inside whichever module holds it.

### Compile
- Model swaps count in the "Your pack" summary.

## 1.1.1 (2026-08-13)

- Auto-rig / Fix model: a Blender path pointing at the install FOLDER now finds blender.exe inside it automatically - the "Access is denied (os error 5)" error this caused is gone. Quotes from Explorer's "Copy as path" are handled too.
- If Blender came from the Microsoft Store (which Windows blocks other apps from launching), the error now says exactly that and points at blender.org / Steam instead of "os error 5".
- The Blender path setting gained a Browse button that picks blender.exe directly.
- Wall Art: new "Reset sheet" button removes every replacement and hidden decal on a sheet at once (with a confirm step).
- Wall Art: every removal now tells you the original poster is back after the next Compile + Install - on Remove, Unhide, and deleting a custom region.

## 1.1 (2026-08-12)

### Model Replacement
- Replace the game's OBJECTS too, not just heroes: the urn, crates, soul containers and map props, with a picker that shows real renders of each object. The original's physics and behaviour are kept.
- Auto-rig: pick any model (fbx/obj/glb) and the app binds it to the hero's skeleton for you via Blender, found automatically - no rigging skills needed. Works best on humanoid-ish models.
- 3D preview of the real in-game model, plus "Download for Blender (.glb)" to start modeling from the original. The turntable is opt-in so the app stays smooth.
- Extra bones are officially fine: tails and physics chains build in and ride with their parent bone (proven against the real compiler). The old advice telling you to remove them is gone.
- New "Fix model automatically" button when a model fails the checks: Blender bakes un-applied transforms, strips vertex colors, fixes .001 names and binds loose physics meshes - your rigging and meshes are kept, nothing is deleted.
- Material FX: give any part a "space glow" (the animated starfield look, with classic or NASA Hubble star sets, a color slider, and speed/brightness tuning), cosmic veil, pulse glow, glass, ghost, fabric sheen or flat toon - on your own textures or on top of the game's materials.
- My Textures fixes: .jpeg and odd-sized images now work (auto-rescaled), textures auto-detect from the model file and its folder, and the app says so when a model carries none.
- Fast build is on by default (skips the baked animation list heroes don't use - saves 10 to 20 minutes per build).
- ModelDoc round trip for advanced users: open the staged model in the Deadlock tools, edit anything (bodygroups, ragdoll), then "Build keeping ModelDoc edits". Heroes now open in ModelDoc without the NmSkeletonList error, and Inspect no longer hangs on the Valve splash screen.
- Multi-file DMX exports (one file per Blender collection) are supported alongside FBX.

### Jumpscares / Deaths
- The Deaths half is now available to everyone: videos that play when your respawn timer appears, alongside the random jumpscares.
- Name your mod: the in-game F8 menu title is now editable, so your pack shows up under its own name.
- The in-game menu only shows controls for what your build actually ships (no death rows in a jumpscare-only mod, and vice versa).

### Sounds
- Replace MANY sounds with one file: multi-select in All Sounds and in the slot tabs, then "Replace N with one file" - great for silencing or meme-ing whole categories at once.

### Compile and install
- The Auto install slot now stays on Auto: it remembers which pak slot is yours and keeps replacing that same install instead of filling a new slot every compile (and never overwrites another mod's slot).
- New "Open folder" button on the compile success banner: shows the built .vpk in Explorer right away when you compile without installing.
- New "zip the .vpk too" option: writes a ready-to-upload .zip next to the build (the combined build's zip includes your credits.txt).

### Pack Builder and Menu Art
- Remove content directly from the Pack Builder rows (two-step confirm). Sound slots clear their songs but stay in their tab; bundled mods leave the profile without touching the file on disk.
- Menu Art now lists images adopted from imported packs (tagged "imported") and images whose home tab is hidden, so nothing is stuck in your pack invisibly.

## 1.0.9 (2026-08-04)

- Model Replacement: exact vanilla attachment transforms are restored on every build - the real fix for the centered/offset third-person camera on custom models.
- Model Replacement: in-tab camera editor (distance, side offset, heights) and "Inspect in ModelDoc".
- Security hardening, thanks to Sirsyorrz (first community PR): download URL and filename handling hardened against injection and path traversal, SHA-256 verification of app updates, and a stricter webview content policy.

## 1.0.8 (2026-08-04)

- Menu Art: the new Ranked play-mode card slots from the game patch.
- Hero backgrounds and name logos now resolve for heroes whose internal names don't match (Venator, Holliday, Sinclair and friends).

## 1.0.7 (2026-08-03)

- Model Replacement shipped: put a custom Blender model on any hero. The app decompiles a per-hero Blender kit, checks your export before building, compiles through CS2 Workshop Tools, and ships the result with your normal compile. Includes rig checklist, build feed, and rebuild support.
- My Textures mode: your PNGs become real game materials (color, normal, roughness, metalness per material).
- Retexture bundled mods: swap any texture inside an imported mod's vpk - drop your art or hue-shift the original, no Blender needed.
- Wall Art: the hideout's paintings joined as a new category.
- Voicelines: bulk Silence (removes the stock audio) and silenced lines stay visible in the list.

## 1.0.6 (2026-07-28)

- Shared Pack: work on one modpack with a friend through any shared folder (a GitHub clone works great). Save writes the whole profile plus every file it uses; their Load imports it as a profile.
- Pack Builder: organize your pack into named modules, export each module as its own standalone vpk (with a conflict warning when two modules ship the same file), and package clean builds into release zips with a paste-ready GameBanana description.
- Menu Art tab: replace the game's screen art - play-mode cards, their hero portraits, or any menu image by path.
- Hideout: its own music slots (queue, ambient layers, build loop, load-in) plus queue-music slots in the UI tab.
- Rift: in-capture music is now moddable via direct-replace slots.
- Particle Guide: every particle function in the game with descriptions and the values Valve actually uses, plus an effect Inspector that outlines any effect and links its functions into the guide. Effect recolors gained gradient drivers.
- Easy Compile: world-texture mode (png to .vtex_c) with automatic power-of-two rescaling.
- Picked art is vaulted into app-data so moving or deleting the original file no longer breaks your pack.
- Fixed a boot crash: combined builds no longer ship a bundled pack's cfg or bin folders.

## 1.0.5 (2026-07-23)

- Hero textures: per-hero skin swap and hue shift with a master slider.
- Per-slot Sound settings: edit event attributes like volume and pitch, including per-team hearing offsets.
- Imports that collide with your tracks now add a "_2" variant instead of replacing yours, and identical files are detected by content so re-imports stay clean.
- Fixed imported stock-path replacements compiling into a silent empty array.
- Fixed Grey Talon images (and other heroes whose asset names differ from their codenames).
