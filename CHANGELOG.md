# Moonahs Mod Maker - Changelog

All notable changes since 1.0.4. Download: https://gamebanana.com/tools/23422

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
