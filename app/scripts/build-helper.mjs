// Publishes the self-contained vpk-helper for the CURRENT platform (win-x64
// on Windows, linux-x64 on Linux, osx-x64 on macOS) into tools/vpk-helper/dist.
// Used by `npm run build:helper` so the same script serves every build target.
import { spawnSync } from "node:child_process";

const rid =
  process.platform === "win32"
    ? "win-x64"
    : process.platform === "darwin"
      ? "osx-x64"
      : "linux-x64";

const r = spawnSync(
  "dotnet",
  [
    "publish",
    "../tools/vpk-helper",
    "-c",
    "Release",
    "-r",
    rid,
    "--self-contained",
    "true",
    "-p:PublishSingleFile=true",
    "-p:IncludeNativeLibrariesForSelfExtract=true",
    "-p:DebugType=none",
    "-p:DebugSymbols=false",
    "-o",
    "../tools/vpk-helper/dist",
  ],
  { stdio: "inherit", shell: process.platform === "win32" },
);
process.exit(r.status ?? 1);
