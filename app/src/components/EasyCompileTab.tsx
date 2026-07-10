import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { easyCompile, type EasyCompiled } from "../lib/api";
import type { Settings } from "../lib/settings";
import { useToast } from "./Toaster";

const PICK_FILTERS = [
  {
    name: "Compilable sources",
    extensions: [
      "png", "jpg", "jpeg", "webp", "bmp", "tga", "svg",
      "wav", "mp3", "flac", "ogg", "m4a", "aac",
      "xml", "css", "js",
      "vsndevts", "vmat", "vpcf", "vdata",
    ],
  },
];

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** What a file will become, for the queue row's hint. */
function compiledKind(p: string): string {
  const ext = (p.split(".").pop() ?? "").toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "bmp", "tga"].includes(ext)) return ".vtex_c";
  if (ext === "svg") return ".vsvg_c";
  if (["wav", "mp3", "flac", "ogg", "m4a", "aac"].includes(ext)) return ".vsnd_c";
  if (ext === "xml") return ".vxml_c";
  if (ext === "css") return ".vcss_c";
  if (ext === "js") return ".vjs_c";
  if (["vsndevts", "vmat", "vpcf", "vdata"].includes(ext)) return `.${ext}_c`;
  return "?";
}

/**
 * Easy Compile (experimental): drop any moddable source file, get its
 * compiled `_c` form in a folder of your choice. Images use the community's
 * documented panorama_image_list method for UI vtex.
 */
export function EasyCompileTab({
  settings,
  update,
  dropRef,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  /** The window drop handler feeds files dropped on this tab in here. */
  dropRef?: React.MutableRefObject<((paths: string[]) => void) | null>;
}) {
  const { push } = useToast();
  const [queue, setQueue] = useState<string[]>([]);
  const [results, setResults] = useState<EasyCompiled[] | null>(null);
  const [busy, setBusy] = useState(false);
  const outDir = settings.easyCompileOutDir;

  useEffect(() => {
    if (!dropRef) return;
    dropRef.current = (paths) => {
      setResults(null);
      setQueue((q) => [...q, ...paths.filter((p) => !q.includes(p))]);
    };
    return () => {
      dropRef.current = null;
    };
  });

  async function addFiles() {
    const sel = await open({
      multiple: true,
      title: "Compile which file(s)?",
      filters: PICK_FILTERS,
    });
    if (!sel) return;
    const files = Array.isArray(sel) ? sel : [sel];
    setResults(null);
    setQueue((q) => [...q, ...files.filter((p) => !q.includes(p))]);
  }

  async function pickOutDir() {
    const sel = await open({ directory: true, title: "Compiled files go where?" });
    if (typeof sel === "string") update({ easyCompileOutDir: sel });
  }

  async function compile() {
    if (queue.length === 0 || !outDir) return;
    setBusy(true);
    setResults(null);
    try {
      const s = settings;
      const res = await easyCompile({
        contentRoot: `${s.csdkRoot}/content/citadel_addons/${s.addonName}`,
        compiledRoot: `${s.csdkRoot}/game/citadel_addons/${s.addonName}`,
        gameInfoDir: `${s.csdkRoot}/game/citadel`,
        resourceCompiler: `${s.csdkRoot}/game/bin_tools/win64/resourcecompiler.exe`,
        ffmpegPath: s.ffmpegPath || undefined,
        files: queue,
        outDir,
      });
      setResults(res);
      const ok = res.filter((r) => r.output).length;
      const failed = res.length - ok;
      push(
        failed === 0 ? "success" : "info",
        `Compiled ${ok} of ${res.length} file${res.length > 1 ? "s" : ""}${failed ? `, ${failed} failed` : ""}`,
      );
      if (ok > 0) {
        try {
          await revealItemInDir(res.find((r) => r.output)!.output!);
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      push("error", `Compile failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  const resultFor = (p: string) => results?.find((r) => r.input === p);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <h3 className="text-sm font-semibold text-zinc-200">Easy Compile</h3>
      <p className="mt-2 text-xs leading-relaxed text-zinc-500">
        Drop any moddable source file (or use the picker) and get its compiled{" "}
        <span className="font-mono">_c</span> form in a folder of your choice - no project,
        no install. Images become <span className="font-mono">.vtex_c</span> via the
        panorama image list method, audio becomes <span className="font-mono">.vsnd_c</span>,
        panorama xml/css/js and vsndevts/vmat/vpcf/vdata compile directly.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => void addFiles()}
          className="rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500"
        >
          Add files…
        </button>
        <button
          onClick={() => void pickOutDir()}
          title={outDir || "Pick where compiled files land"}
          className="max-w-[50%] truncate rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
        >
          {outDir ? `Output: ${outDir}` : "Pick an output folder…"}
        </button>
        <button
          onClick={() => void compile()}
          disabled={busy || queue.length === 0 || !outDir}
          className="ml-auto rounded-md bg-amber-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-amber-500 disabled:opacity-50"
        >
          {busy ? "Compiling…" : `Compile${queue.length ? ` ${queue.length}` : ""}`}
        </button>
      </div>

      <div className="mt-4 flex flex-col gap-1.5">
        {queue.length === 0 && (
          <span className="text-xs text-zinc-600">
            Nothing queued - drop files anywhere on this tab.
          </span>
        )}
        <AnimatePresence initial={false}>
          {queue.map((p) => {
            const r = resultFor(p);
            return (
              <motion.div
                key={p}
                layout
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -6 }}
                className="rounded-md border border-zinc-700 bg-zinc-800/40 px-3 py-1.5 text-xs"
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-zinc-300" title={p}>
                    {baseName(p)}
                  </span>
                  <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
                    → {compiledKind(p)}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {r?.output && (
                      <button
                        onClick={() => void revealItemInDir(r.output!)}
                        className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300 transition hover:bg-emerald-500/25"
                        title={r.output}
                      >
                        ✓ {baseName(r.output)}
                      </button>
                    )}
                    {r?.error && (
                      <span className="max-w-64 truncate text-[10px] text-red-400" title={r.error}>
                        ✕ {r.error}
                      </span>
                    )}
                    <button
                      onClick={() => setQueue((q) => q.filter((x) => x !== p))}
                      aria-label="Remove from queue"
                      className="rounded p-0.5 text-zinc-500 transition hover:bg-red-950/40 hover:text-red-300"
                    >
                      ✕
                    </button>
                  </span>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
        {queue.length > 0 && (
          <button
            onClick={() => {
              setQueue([]);
              setResults(null);
            }}
            className="self-start text-[11px] text-zinc-600 transition hover:text-zinc-400"
          >
            Clear the queue
          </button>
        )}
      </div>
    </section>
  );
}
