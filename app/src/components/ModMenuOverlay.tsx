// The F8 mod-menu overlay — a compact, always-on-top window that floats over
// Deadlock (in borderless-windowed) and drives the dedicated server over RCON.
// It shares the backend's stored RCON password, so it works as long as the
// server was launched from the app. Lives in its own Tauri window ("overlay").
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { rconExec, rconReady } from "../lib/api";
import { commandCatalog, quickActions } from "../lib/rconActions";

export function ModMenuOverlay() {
  const [tab, setTab] = useState<"actions" | "commands">("actions");
  const [map, setMap] = useState("dl_midtown");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cmd, setCmd] = useState("");
  const [out, setOut] = useState<{ text: string; err?: boolean } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Poll whether a host is running so the menu can show its state.
  useEffect(() => {
    let alive = true;
    const tick = () => rconReady().then((r) => alive && setReady(r)).catch(() => {});
    tick();
    const id = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  async function run(commands: string | string[]) {
    const list = (Array.isArray(commands) ? commands : [commands]).map((c) => c.trim()).filter(Boolean);
    if (list.length === 0) return;
    setBusy(true);
    try {
      let last = "";
      let err = false;
      for (const c of list) {
        try {
          const r = await rconExec(c);
          last = r.trim() || "(ok)";
        } catch (e) {
          last = String(e);
          err = true;
        }
      }
      setOut({ text: last, err });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden rounded-xl border border-violet-500/40 bg-zinc-950/95 text-zinc-200 shadow-2xl backdrop-blur">
      {/* drag handle */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2"
      >
        <span className="text-sm">🛡️</span>
        <span className="text-xs font-bold tracking-wide text-violet-200">MOD MENU</span>
        <span
          className={`h-2 w-2 rounded-full ${ready ? "bg-emerald-400" : "bg-zinc-600"}`}
          title={ready ? "Server live" : "No server launched from the app"}
        />
        <button
          onClick={() => void getCurrentWindow().hide()}
          className="ml-auto rounded px-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
          title="Hide (F8 to reopen)"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-auto p-3">
        {!ready && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
            No server yet — click <b>Host game now</b> in the app, then these controls go live.
          </div>
        )}

        <div className="flex items-center gap-1.5">
          <label className="text-[11px] text-zinc-500">Map</label>
          <input
            value={map}
            onChange={(e) => setMap(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-violet-500"
          />
        </div>

        {/* Actions vs Commands submenu */}
        <div className="flex gap-1 rounded-md bg-zinc-900 p-0.5 text-[11px]">
          {(["actions", "commands"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 rounded px-2 py-1 font-medium capitalize transition ${
                tab === t ? "bg-violet-500/25 text-violet-100" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "actions" && (
          <div className="grid grid-cols-2 gap-1.5">
            {quickActions(map).map((a) => (
              <button
                key={a.label}
                onClick={() => void run(a.cmds)}
                disabled={busy || !ready}
                title={a.title ?? a.cmds.join("  ·  ")}
                className="rounded-md border border-violet-500/40 bg-violet-500/10 px-2 py-1.5 text-[11px] font-medium text-violet-200 transition hover:bg-violet-500/20 disabled:opacity-40"
              >
                {a.label}
              </button>
            ))}
          </div>
        )}

        {tab === "commands" &&
          commandCatalog(map).map((g) => (
            <div key={g.title} className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{g.title}</div>
              <div className="grid grid-cols-2 gap-1.5">
                {g.items.map((a) => (
                  <button
                    key={a.label}
                    onClick={() => void run(a.cmds)}
                    disabled={busy || !ready}
                    title={a.title ?? a.cmds.join("  ·  ")}
                    className="rounded-md border border-zinc-700 bg-zinc-800/50 px-2 py-1 text-[11px] font-medium text-zinc-200 transition hover:border-violet-500/40 hover:bg-violet-500/15 disabled:opacity-40"
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          ))}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const c = cmd;
            setCmd("");
            void run(c);
          }}
          className="flex items-center gap-1.5"
        >
          <span className="text-violet-400">›</span>
          <input
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            placeholder="console command…"
            spellCheck={false}
            disabled={!ready}
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-200 outline-none focus:border-violet-500 disabled:opacity-40"
          />
          <button
            type="submit"
            disabled={busy || !ready || !cmd.trim()}
            className="rounded-md border border-violet-500/50 bg-violet-500/15 px-2 py-1 text-[11px] font-semibold text-violet-200 transition hover:bg-violet-500/25 disabled:opacity-40"
          >
            {busy ? "…" : "Send"}
          </button>
        </form>

        {out && (
          <div
            ref={logRef}
            className={`max-h-28 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap ${
              out.err ? "text-rose-400" : "text-zinc-400"
            }`}
          >
            {out.text}
          </div>
        )}
      </div>
    </div>
  );
}
