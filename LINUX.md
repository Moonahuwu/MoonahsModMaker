# Linux build (experimental)

This branch carries the Linux port. Status: **compiles + packaged by CI,
untested on real hardware**. If you're the brave tester, this file is for you.

## What's done

- Native Linux build of the app (Tauri/webkit2gtk) - built automatically by
  the `linux-build` GitHub Actions workflow on this branch. Grab the AppImage
  from the latest run's artifacts (Actions tab).
- The vpk-helper (browse/extract/decode game files) publishes as a native
  linux-x64 binary - no Wine involved for any of the browsing features.
- Steam + Deadlock detection via `~/.steam` / `~/.local/share/Steam` /
  flatpak paths, including `libraryfolders.vdf` for extra drives.
- Platform tool swaps: curl/tar/md5sum/ps instead of the Windows built-ins.
- **Compiling goes through Wine**: Valve's `resourcecompiler` is Windows-only,
  so the compile pipeline runs it as `wine resourcecompiler.exe ...` with
  paths translated to Wine's `Z:\` view. The app tells you if Wine is missing.

## What needs you (the tester)

1. Install `wine` (any recent version) and `ffmpeg` from your package manager.
2. Run the AppImage. Point Setup at your Deadlock install if autodetect
   misses it. Use the wizard's "Download the compile tools" button - the
   bundle's Windows compiler is exactly what Wine runs.
3. The key experiments, in order of expected pain:
   - Browse heroes/sounds (native helper, should just work).
   - Compile a SOUND mod (one music slot). Wine runs resourcecompiler headless.
   - Compile an IMAGE mod (hero portrait). This initializes a GPU device in
     resourcecompiler - the most likely thing to fail under Wine; if it does,
     note whether sound-only compiles still succeed.
   - Install to game + launch (installs are plain file copies; launching goes
     through `steam://` via xdg-open).

## Known not-ported (gated off, not broken)

- One-click app updates (grab new builds from CI/releases instead).
- Custom-server hosting (launches Windows console processes).

## Report back

Open a GitHub issue with: distro, Wine version, GPU/driver, and the compile
report (the "Copy report" button in the app copies every step as text).
