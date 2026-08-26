import { useState } from "react";
import type { EqPreset, ModKind, ReverbPreset, SoundFx } from "../types";

/**
 * The effect chain editor. A row of chips, one per effect: click to switch
 * it on (with sensible defaults) or off again. Every effect that is on shows
 * its own strength controls right underneath, so there's nothing to hunt for.
 * The renderer applies them in a fixed order (reverse, pitch, eq, crush,
 * modulation, compressor, reverb, then volume); the chips read in that order
 * too. Song-level strips also get the bite-wide Limiter and Match-loudness.
 */
export function FxStrip({
  fx,
  onChange,
  accent,
  compact,
  onMeasureOriginal,
}: {
  fx: SoundFx | undefined;
  onChange: (fx: SoundFx | undefined) => void;
  accent: string;
  /** Layer strips: smaller, no bite-wide effects. */
  compact?: boolean;
  /** Song level: measure the original's loudness for "Match loudness". */
  onMeasureOriginal?: () => Promise<{ value: number; method: "lufs" | "rms" }>;
}) {
  const [measuring, setMeasuring] = useState(false);
  const [measureErr, setMeasureErr] = useState<string | null>(null);
  const cur: SoundFx = fx ?? {};

  const set = (patch: Partial<SoundFx>) => {
    const next: SoundFx = { ...cur, ...patch };
    // Drop unset keys so an all-off chain serializes as "no fx" at all.
    for (const k of Object.keys(next) as (keyof SoundFx)[]) {
      const v = next[k];
      if (v === undefined || v === false || v === null) delete next[k];
    }
    if (next.loudness == null) delete next.loudnessMethod;
    onChange(Object.keys(next).length ? next : undefined);
  };

  const DEFAULTS: Partial<Record<keyof SoundFx, () => Partial<SoundFx>>> = {
    reverse: () => ({ reverse: true }),
    pitch: () => ({ pitch: { semitones: 0, tempo: 1 } }),
    eq: () => ({ eq: { preset: "radio" } }),
    crush: () => ({ crush: { bits: 8, mix: 60 } }),
    modulation: () => ({ modulation: { kind: "chorus", depth: 50, rate: 1.5 } }),
    compress: () => ({ compress: { amount: 50 } }),
    reverb: () => ({ reverb: { preset: "room", wet: 35 } }),
    limiter: () => ({ limiter: true }),
  };

  const chips: { key: keyof SoundFx; label: string; hint: string }[] = [
    { key: "reverse", label: "Reverse", hint: "Play the clip backwards" },
    { key: "pitch", label: "Pitch", hint: "Pitch in semitones and speed, independently" },
    { key: "eq", label: "EQ", hint: "Radio / telephone / muffled / bass / bright, or your own" },
    { key: "crush", label: "Crush", hint: "Bit-crush distortion" },
    { key: "modulation", label: "Chorus", hint: "Chorus, flanger or tremolo" },
    { key: "compress", label: "Compress", hint: "Even out loud and quiet parts" },
    { key: "reverb", label: "Reverb", hint: "Room, hall, cave or slapback echo" },
    ...(compact
      ? []
      : [
          { key: "limiter" as const, label: "Limiter", hint: "Stop the finished bite from clipping" },
          {
            key: "loudness" as const,
            label: "Match loudness",
            hint: "Make the whole bite as loud as the game's original (measured, then matched with a gain)",
          },
        ]),
  ];

  const isOn = (k: keyof SoundFx) => {
    const v = cur[k];
    return v !== undefined && v !== false && v !== null;
  };

  async function toggle(k: keyof SoundFx) {
    if (isOn(k)) {
      set({ [k]: undefined } as Partial<SoundFx>);
      return;
    }
    if (k === "loudness") {
      if (!onMeasureOriginal) return;
      setMeasuring(true);
      setMeasureErr(null);
      try {
        const m = await onMeasureOriginal();
        set({ loudness: Math.round(m.value * 10) / 10, loudnessMethod: m.method });
      } catch (e) {
        setMeasureErr(String(e));
      } finally {
        setMeasuring(false);
      }
      return;
    }
    set(DEFAULTS[k]?.() ?? {});
  }

  const size = compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]";
  const on = chips.filter((c) => isOn(c.key) && c.key !== "reverse" && c.key !== "limiter");

  return (
    <div className={compact ? "mt-1" : "mt-2"}>
      <div className="flex flex-wrap items-center gap-1">
        {!compact && <span className="mr-1 text-[10px] uppercase tracking-wide text-zinc-600">Effects</span>}
        {chips.map((c) => {
          const active = isOn(c.key);
          return (
            <button
              key={c.key}
              onClick={() => void toggle(c.key)}
              title={`${c.hint}${active ? " - click to turn off" : ""}`}
              disabled={c.key === "loudness" && (measuring || !onMeasureOriginal)}
              style={active ? { borderColor: accent, color: accent, backgroundColor: `${accent}14` } : undefined}
              className={`rounded-md border border-zinc-700 ${size} text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200 disabled:opacity-40`}
            >
              {active && <span className="mr-1 text-[9px]">✓</span>}
              {c.key === "loudness" && measuring ? "Measuring…" : c.label}
            </button>
          );
        })}
        {measureErr && <span className="text-[10px] text-red-400">{measureErr}</span>}
      </div>
      {on.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {on.map((c) => (
            <div
              key={c.key}
              className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-zinc-800 bg-zinc-950/50 px-2.5 py-1.5 text-[11px] text-zinc-400"
            >
              <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wide" style={{ color: accent }}>
                {c.label}
              </span>
              {c.key === "pitch" && cur.pitch && (
                <>
                  <Knob label="Semitones" min={-24} max={24} step={1} value={cur.pitch.semitones} fmt={(v) => `${v > 0 ? "+" : ""}${v}`} onChange={(v) => set({ pitch: { ...cur.pitch!, semitones: v } })} />
                  <Knob label="Speed" min={0.5} max={2} step={0.05} value={cur.pitch.tempo} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ pitch: { ...cur.pitch!, tempo: v } })} />
                </>
              )}
              {c.key === "eq" && cur.eq && (
                <>
                  <Choice
                    value={cur.eq.preset}
                    options={[
                      ["radio", "Radio"],
                      ["telephone", "Telephone"],
                      ["muffled", "Muffled"],
                      ["bass", "Bass boost"],
                      ["bright", "Bright"],
                      ["custom", "Custom"],
                    ]}
                    onChange={(v) => set({ eq: { ...cur.eq!, preset: v as EqPreset } })}
                  />
                  {cur.eq.preset === "custom" && (
                    <>
                      <Knob label="Bass" min={-20} max={20} step={1} value={cur.eq.bass ?? 0} fmt={(v) => `${v}dB`} onChange={(v) => set({ eq: { ...cur.eq!, bass: v } })} />
                      <Knob label="Treble" min={-20} max={20} step={1} value={cur.eq.treble ?? 0} fmt={(v) => `${v}dB`} onChange={(v) => set({ eq: { ...cur.eq!, treble: v } })} />
                      <Knob label="Low cut" min={0} max={2000} step={20} value={cur.eq.highpass ?? 0} fmt={(v) => (v ? `${v}Hz` : "off")} onChange={(v) => set({ eq: { ...cur.eq!, highpass: v } })} />
                      <Knob label="High cut" min={0} max={16000} step={100} value={cur.eq.lowpass ?? 0} fmt={(v) => (v ? `${v}Hz` : "off")} onChange={(v) => set({ eq: { ...cur.eq!, lowpass: v } })} />
                    </>
                  )}
                </>
              )}
              {c.key === "crush" && cur.crush && (
                <>
                  <Knob label="Bits" min={2} max={16} step={1} value={cur.crush.bits} fmt={(v) => `${v}`} onChange={(v) => set({ crush: { ...cur.crush!, bits: v } })} />
                  <Knob label="Mix" min={0} max={100} step={5} value={cur.crush.mix} fmt={(v) => `${v}%`} onChange={(v) => set({ crush: { ...cur.crush!, mix: v } })} />
                </>
              )}
              {c.key === "modulation" && cur.modulation && (
                <>
                  <Choice
                    value={cur.modulation.kind}
                    options={[
                      ["chorus", "Chorus"],
                      ["flanger", "Flanger"],
                      ["tremolo", "Tremolo"],
                    ]}
                    onChange={(v) => set({ modulation: { ...cur.modulation!, kind: v as ModKind } })}
                  />
                  <Knob label="Depth" min={0} max={100} step={5} value={cur.modulation.depth} fmt={(v) => `${v}%`} onChange={(v) => set({ modulation: { ...cur.modulation!, depth: v } })} />
                  <Knob label="Rate" min={0.1} max={10} step={0.1} value={cur.modulation.rate} fmt={(v) => `${v.toFixed(1)}Hz`} onChange={(v) => set({ modulation: { ...cur.modulation!, rate: v } })} />
                </>
              )}
              {c.key === "compress" && cur.compress && (
                <Knob label="Strength" min={0} max={100} step={5} value={cur.compress.amount} fmt={(v) => `${v}%`} onChange={(v) => set({ compress: { amount: v } })} />
              )}
              {c.key === "reverb" && cur.reverb && (
                <>
                  <Choice
                    value={cur.reverb.preset}
                    options={[
                      ["room", "Room"],
                      ["hall", "Hall"],
                      ["cave", "Cave"],
                      ["slap", "Slapback"],
                    ]}
                    onChange={(v) => set({ reverb: { ...cur.reverb!, preset: v as ReverbPreset } })}
                  />
                  <Knob label="Amount" min={0} max={100} step={5} value={cur.reverb.wet} fmt={(v) => `${v}%`} onChange={(v) => set({ reverb: { ...cur.reverb!, wet: v } })} />
                  {cur.reverb.preset !== "slap" && (
                    <Knob label="Decay" min={0} max={6} step={0.1} value={cur.reverb.decay ?? 0} fmt={(v) => (v ? `${v.toFixed(1)}s` : "preset")} onChange={(v) => set({ reverb: { ...cur.reverb!, decay: v } })} />
                  )}
                </>
              )}
              {c.key === "loudness" && cur.loudness != null && (
                <>
                  <Knob
                    label="Target"
                    min={-45}
                    max={-6}
                    step={0.5}
                    value={cur.loudness}
                    fmt={(v) => `${v} ${cur.loudnessMethod === "rms" ? "dB" : "LUFS"}`}
                    onChange={(v) => set({ loudness: v })}
                  />
                  <span className="text-[10px] text-zinc-600">
                    {cur.loudnessMethod === "rms"
                      ? "mean level (the original is too short for a LUFS reading) - your bite gets the same"
                      : "the original's loudness - your bite gets the same"}
                  </span>
                </>
              )}
              <button
                onClick={() => void toggle(c.key)}
                className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-zinc-500 transition hover:bg-red-950/40 hover:text-red-300"
                title="Turn this effect off"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One strength control: a slider with its value, plus wheel nudging. */
function Knob({
  label,
  min,
  max,
  step,
  value,
  fmt,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  fmt: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  return (
    <label className="flex items-center gap-1.5" title={`${label}: scroll the wheel over the slider for fine steps`}>
      <span className="whitespace-nowrap text-zinc-500">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onWheel={(e) => {
          e.preventDefault();
          onChange(clamp(value + (e.deltaY < 0 ? step : -step)));
        }}
        className="h-1 w-24 accent-emerald-500"
      />
      <span className="w-14 text-right tabular-nums text-zinc-300">{fmt(value)}</span>
    </label>
  );
}

function Choice({
  value,
  options,
  onChange,
}: {
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <span className="flex overflow-hidden rounded-md border border-zinc-700">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`px-2 py-0.5 text-[10px] transition ${
            value === v ? "bg-zinc-700/70 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {label}
        </button>
      ))}
    </span>
  );
}
