import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

/**
 * Top-bar profile picker: shows the active build config and a dropdown to
 * switch, create, duplicate, rename, or delete profiles. The built-in "Vanilla"
 * profile (an empty config) can't be renamed or deleted. Name entry is inline
 * (no browser prompt() — those block the Tauri webview).
 */
export function ProfileSwitcher({
  profiles,
  active,
  vanillaName,
  busy,
  onSwitch,
  onCreate,
  onDuplicate,
  onRename,
  onDelete,
}: {
  profiles: string[];
  active: string;
  vanillaName: string;
  busy?: boolean;
  onSwitch: (name: string) => void;
  onCreate: (name: string) => void;
  onDuplicate: (name: string) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Inline name entry: which action is in progress + the typed value.
  const [mode, setMode] = useState<null | "new" | "duplicate" | "rename">(null);
  const [draft, setDraft] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setMode(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (mode) inputRef.current?.focus();
  }, [mode]);

  const isVanilla = active === vanillaName;

  function startMode(m: "new" | "duplicate" | "rename") {
    setMode(m);
    setDraft(m === "rename" ? active : m === "duplicate" ? `${active} copy` : "");
  }

  function commit() {
    const name = draft.trim();
    if (!name) return;
    if (mode === "new") onCreate(name);
    else if (mode === "duplicate") onDuplicate(name);
    else if (mode === "rename") onRename(name);
    setMode(null);
    setDraft("");
    setOpen(false);
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        title="Switch / manage profiles"
        className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/70 px-3 py-1.5 text-sm text-zinc-200 transition hover:border-zinc-500 disabled:opacity-50"
      >
        <span className="text-[11px] uppercase tracking-wide text-zinc-500">Profile</span>
        <span className="max-w-[12rem] truncate font-medium">{active || "—"}</span>
        <span className="text-zinc-500">▾</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
          >
            <div className="max-h-64 overflow-y-auto py-1">
              {profiles.map((name) => {
                const isActive = name === active;
                return (
                  <button
                    key={name}
                    onClick={() => {
                      if (!isActive) onSwitch(name);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition ${
                      isActive
                        ? "bg-zinc-800 text-zinc-100"
                        : "text-zinc-300 hover:bg-zinc-800/60"
                    }`}
                  >
                    <span className="w-4 text-emerald-400">{isActive ? "✓" : ""}</span>
                    <span className="flex-1 truncate">{name}</span>
                    {name === vanillaName && (
                      <span className="rounded bg-zinc-700/60 px-1 text-[9px] uppercase text-zinc-400">
                        stock
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {mode ? (
              <div className="border-t border-zinc-800 p-2">
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                    if (e.key === "Escape") setMode(null);
                  }}
                  placeholder={
                    mode === "new"
                      ? "New profile name"
                      : mode === "duplicate"
                        ? "Copy name"
                        : "Rename to…"
                  }
                  className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    onClick={() => setMode(null)}
                    className="rounded px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={commit}
                    className="rounded bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500"
                  >
                    {mode === "rename" ? "Rename" : "Create"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-1 border-t border-zinc-800 p-2 text-xs">
                <button
                  onClick={() => startMode("new")}
                  className="rounded px-2 py-1 text-zinc-300 hover:bg-zinc-800"
                >
                  + New
                </button>
                <button
                  onClick={() => startMode("duplicate")}
                  className="rounded px-2 py-1 text-zinc-300 hover:bg-zinc-800"
                >
                  Duplicate
                </button>
                <button
                  onClick={() => startMode("rename")}
                  disabled={isVanilla}
                  className="rounded px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                >
                  Rename
                </button>
                <button
                  onClick={() => {
                    onDelete();
                    setOpen(false);
                  }}
                  disabled={isVanilla || profiles.length <= 1}
                  title={isVanilla ? "The Vanilla profile can't be deleted" : "Delete this profile"}
                  className="ml-auto rounded px-2 py-1 text-red-400 hover:bg-red-500/10 disabled:opacity-40"
                >
                  Delete
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
