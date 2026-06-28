import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Custom Server tab — hub for dedicated-server hosting + (soon) a full gameplay
 * config editor that edits `scripts/abilities.vdata_c` (hero/item/ability values)
 * and custom gamemode configs.
 */
const HOSTING_URL = "https://deadlockmodding.pages.dev/dedicated-server-hosting";

export function CustomServer() {
  return (
    <div className="flex flex-col gap-5">
      {/* Dedicated server hosting */}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="flex items-start gap-4">
          <span className="text-3xl">🖥️</span>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-bold text-zinc-100">Dedicated Server Hosting</h3>
            <p className="mt-1 text-sm text-zinc-400">
              Run your own Deadlock dedicated server to play custom configs and gamemodes
              with friends. Follow the community guide for setup (SteamCMD, ports, launch
              options).
            </p>
            <button
              onClick={() => void openUrl(HOSTING_URL)}
              className="mt-3 inline-flex items-center gap-2 rounded-md border border-sky-500/50 bg-sky-500/10 px-3 py-1.5 text-sm font-medium text-sky-300 transition hover:bg-sky-500/20"
            >
              Open hosting guide ↗
            </button>
            <p className="mt-2 select-text break-all text-[11px] text-zinc-600">{HOSTING_URL}</p>
          </div>
        </div>
      </section>

      {/* Config editor (planned) */}
      <section className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-900/30 p-5">
        <div className="flex items-start gap-4">
          <span className="text-3xl">⚙️</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold text-zinc-100">Gameplay Config Editor</h3>
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                In progress
              </span>
            </div>
            <p className="mt-1 text-sm text-zinc-400">
              A visual editor for <code className="text-zinc-300">scripts/abilities.vdata</code> —
              tweak hero, item, and ability values and compile them into a config mod for
              your server.
            </p>
            <ul className="mt-3 space-y-1.5 text-sm text-zinc-400">
              <li className="flex gap-2">
                <span className="text-emerald-400">●</span> Browse by <b className="text-zinc-200">Heroes</b> (with portraits) and{" "}
                <b className="text-zinc-200">Items</b> (with icons)
              </li>
              <li className="flex gap-2">
                <span className="text-emerald-400">●</span> Edit ability properties — damage, cooldown, range, duration…
              </li>
              <li className="flex gap-2">
                <span className="text-emerald-400">●</span> Custom gamemode configs (build-only changes, server-side)
              </li>
              <li className="flex gap-2">
                <span className="text-emerald-400">●</span> Compile to a <code className="text-zinc-300">.vdata_c</code> override — same one-click pipeline
              </li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
