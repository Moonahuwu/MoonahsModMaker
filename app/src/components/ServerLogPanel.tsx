// Live server console, in-app. Tails the dedicated server's console.log so you
// never need the (blank-under-dev) console window. Polls while mounted, auto-
// sticks to the bottom, and can hide the engine's spammy networking/profiler
// chatter so real server events stand out.
import { useEffect, useMemo, useRef, useState } from "react";
import { readServerLog } from "../lib/api";

// Lines that are pure engine noise — safe to hide by default.
const NOISE =
  /VProf|SteamNetSockets|\[Networking\]|GetNumberOfConsoleInputEvents|Network frames|Tick messages|Receive margin|Bandwidth|Ping (?:histogram|distribution|location)|Latency variance|Prediction time|Netchan|RelayNetworkStatus|cl_clockdrift|Slamming client/;

export function ServerLogPanel({ deadlockRoot }: { deadlockRoot: string }) {
  const [raw, setRaw] = useState("");
  const [paused, setPaused] = useState(false);
  const [hideNoise, setHideNoise] = useState(true);
  const [filter, setFilter] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (!deadlockRoot || paused) return;
    let alive = true;
    const tick = () =>
      readServerLog(deadlockRoot)
        .then((t) => alive && setRaw(t))
        .catch(() => {});
    tick();
    const id = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [deadlockRoot, paused]);

  const lines = useMemo(() => {
    let ls = raw.split("\n");
    if (hideNoise) ls = ls.filter((l) => !NOISE.test(l));
    if (filter.trim()) {
      const q = filter.toLowerCase();
      ls = ls.filter((l) => l.toLowerCase().includes(q));
    }
    return ls.slice(-600);
  }, [raw, hideNoise, filter]);

  // Auto-scroll to bottom unless the user scrolled up.
  useEffect(() => {
    const el = boxRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-2xl text-zinc-400">≡</span>
        <h3 className="text-lg font-bold text-zinc-100">Server Output</h3>
        <span className="text-[11px] text-zinc-500">live tail of console.log</span>

        <div className="ml-auto flex items-center gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            spellCheck={false}
            className="w-28 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-zinc-500"
          />
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-400">
            <input
              type="checkbox"
              checked={hideNoise}
              onChange={(e) => setHideNoise(e.target.checked)}
              className="h-3.5 w-3.5 accent-sky-500"
            />
            Hide noise
          </label>
          <button
            onClick={() => setPaused((p) => !p)}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
              paused
                ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                : "border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:bg-zinc-800"
            }`}
          >
            {paused ? "▶ Resume" : "⏸ Pause"}
          </button>
        </div>
      </div>

      <div
        ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
        }}
        className="h-72 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-[11px] leading-relaxed"
      >
        {lines.length === 0 || (lines.length === 1 && !lines[0]) ? (
          <p className="text-zinc-600">
            No server output yet. Launch a host from the Server tab - output appears here live.
          </p>
        ) : (
          lines.map((l, i) => (
            <div key={i} className={`whitespace-pre-wrap ${lineClass(l)}`}>
              {l || " "}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

// Lightly colorize obvious severities / server events.
function lineClass(l: string): string {
  if (/error|fail|couldn't|unable|warning/i.test(l)) return "text-rose-400/90";
  if (/ServerSteamID|Spawn Server|ss_active|GameServerSteamAPIActivated|connected|bot/i.test(l))
    return "text-emerald-300/90";
  if (/\[Server\]|\[Host\]/.test(l)) return "text-sky-300/80";
  return "text-zinc-400";
}
