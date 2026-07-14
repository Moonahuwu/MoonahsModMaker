// The F8 mod-menu overlay — a compact, always-on-top window that floats over
// Deadlock (in borderless-windowed) and drives the dedicated server over RCON.
// It shares the backend's stored RCON password, so it works as long as the
// server was launched from the app. Lives in its own Tauri window ("overlay").
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { hostInfo, rconExec, type HostInfo } from "../lib/api";
import { commandCatalog, quickActions, type QuickAction } from "../lib/rconActions";

export function ModMenuOverlay() {
  const [tab, setTab] = useState<"actions" | "commands">("actions");
  const [map, setMap] = useState("dl_midtown");
  // The map follows the launched server until the user types their own.
  const mapTouched = useRef(false);
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [cmd, setCmd] = useState("");
  const [out, setOut] = useState<{ text: string; err?: boolean } | null>(null);
  // Destructive action (changelevel kicks everyone): click once to arm,
  // again to fire.
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 3500);
    return () => clearTimeout(t);
  }, [armed]);
  const logRef = useRef<HTMLDivElement>(null);

  const launched = !!info?.launched;
  const listening = !!info?.listening;
  const ready = launched && listening;

  // Poll the backend's server snapshot so the menu reflects reality (map,
  // connect id, actually-up vs booting vs dead). Skipped while the overlay
  // window is hidden - F8 shows it again and the next tick catches up.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (document.hidden) return;
      hostInfo()
        .then((i) => {
          if (!alive) return;
          setInfo(i);
          if (i.map && !mapTouched.current) setMap(i.map);
        })
        .catch(() => {});
    };
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

  /** Quick-action click with the arm step for destructive ones. */
  function clickAction(a: QuickAction) {
    if (a.destructive && armed !== a.label) {
      setArmed(a.label);
      return;
    }
    setArmed(null);
    void run(a.cmds);
  }

  const actionButton = (a: QuickAction, subtle: boolean) => (
    <button
      key={a.label}
      onClick={() => clickAction(a)}
      disabled={busy || !ready}
      title={
        a.destructive && armed !== a.label
          ? `Restarts the map (kicks everyone) - click again to confirm. ${a.cmds.join("  ·  ")}`
          : (a.title ?? a.cmds.join("  ·  "))
      }
      className={`rounded-md border px-2 py-1.5 text-[11px] font-medium transition disabled:opacity-40 ${
        armed === a.label
          ? "border-rose-500/60 bg-rose-500/15 text-rose-200"
          : subtle
            ? "border-zinc-700 bg-zinc-800/50 text-zinc-200 hover:border-violet-500/40 hover:bg-violet-500/15"
            : "border-violet-500/40 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20"
      }`}
    >
      {armed === a.label ? `${a.label}?` : a.label}
    </button>
  );

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden rounded-xl border border-violet-500/40 bg-zinc-950/95 text-zinc-200 shadow-2xl backdrop-blur">
      {/* drag handle */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2"
      >
        <span aria-hidden className="text-sm text-violet-300">◈</span>
        <span className="text-xs font-bold tracking-wide text-violet-200">MOD MENU</span>
        <span
          className={`h-2 w-2 rounded-full ${
            ready ? "bg-emerald-400" : launched ? "bg-amber-400" : "bg-zinc-600"
          }`}
          title={
            ready
              ? "Server live"
              : launched
                ? "Server starting or not responding"
                : "No server launched from the app"
          }
        />
        <button
          onClick={() => void getCurrentWindow().hide()}
          className="ml-auto rounded px-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
          title="Hide (F8 to reopen)"
          aria-label="Hide overlay"
        >
          ✕
        </button>
      </div>

      {/* Fixed top: status + map + submenu tabs */}
      <div className="space-y-2 px-3 pt-2">
        {!launched && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
            No server yet - click <b>Host game now</b> in the app, then these controls go live.
          </div>
        )}
        {launched && !listening && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
            The server process is gone (console closed or crashed) - host again from the app.
          </div>
        )}
        {info?.connectId && ready && (
          <div className="flex items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate rounded bg-zinc-900 px-1.5 py-1 text-[10px] text-emerald-300">
              connect {info.connectId}
            </code>
            <button
              onClick={() => void navigator.clipboard.writeText(`connect ${info.connectId}`)}
              title="Copy the connect command for friends"
              className="shrink-0 rounded-md border border-zinc-700 bg-zinc-800/60 px-1.5 py-1 text-[10px] text-zinc-300 transition hover:bg-zinc-800"
            >
              ⧉ Copy
            </button>
          </div>
        )}

        <div className="flex items-center gap-1.5">
          <label className="text-[11px] text-zinc-500">Map</label>
          <input
            value={map}
            onChange={(e) => {
              mapTouched.current = true;
              setMap(e.target.value);
            }}
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
      </div>

      {/* Scrollable middle: the buttons */}
      <div className="min-h-0 flex-1 space-y-2 overflow-auto px-3 py-2">
        {tab === "actions" && (
          <div className="grid grid-cols-2 gap-1.5">
            {quickActions(map).map((a) => actionButton(a, false))}
          </div>
        )}

        {tab === "commands" &&
          commandCatalog(map).map((g) => (
            <div key={g.title} className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{g.title}</div>
              <div className="grid grid-cols-2 gap-1.5">
                {g.items.map((a) => actionButton(a, true))}
              </div>
            </div>
          ))}
      </div>

      {/* Fixed bottom: free-text command + last output */}
      <div className="space-y-2 border-t border-zinc-800 px-3 pb-3 pt-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const c = cmd;
            setCmd("");
            void run(c);
          }}
          className="flex items-center gap-1.5"
        >
          <span aria-hidden className="text-violet-400">›</span>
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
            className={`max-h-24 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap ${
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
