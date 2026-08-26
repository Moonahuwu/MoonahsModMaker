import type { SoundFx } from "../types";

/**
 * Live preview of a track's effect chain with WebAudio nodes, so dragging an
 * effect slider is audible instantly. The compile renders the same chain with
 * ffmpeg (audio.rs `fx_chain`) - this is an approximation of it, built from
 * the same parameters in the same order: eq -> crush -> modulation ->
 * compressor -> reverb (reverse and loudness are baked into the preview
 * render; pitch rides the media element's playback rate; the limiter sits
 * after the master gain, see `createLimiter`).
 */

export interface LiveFxChain {
  input: AudioNode;
  output: AudioNode;
  /** Which effects/kinds/presets the chain was built for; a change means rebuild. */
  key: string;
  /** Re-tune every node in place from new slider values (same structure). */
  update(fx: SoundFx | undefined): void;
  dispose(): void;
}

/** The parts of the chain that need a rebuild when they change (what's on,
 *  and which kind/preset) - everything else is a live parameter. */
export function liveFxKey(fx: SoundFx | undefined): string {
  if (!fx) return "";
  return [
    fx.eq ? `eq:${fx.eq.preset}` : "",
    fx.crush ? "crush" : "",
    fx.modulation ? `mod:${fx.modulation.kind}` : "",
    fx.compress ? "comp" : "",
    fx.reverb ? `rev:${fx.reverb.preset}` : "",
  ].join("|");
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));
const dbToLin = (db: number) => Math.pow(10, db / 20);

/** Decaying, darkened noise - the same recipe the ffmpeg render uses for its
 *  synthetic impulse response (anoisesrc pink + exp fade + lowpass). */
function makeImpulse(ctx: BaseAudioContext, decay: number, damp: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * decay));
  const buf = ctx.createBuffer(2, len, rate);
  // One-pole lowpass coefficient for the damping frequency.
  const k = 1 - Math.exp((-2 * Math.PI * damp) / rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      lp += k * (white - lp);
      // Exponential tail: -60 dB at `decay`.
      d[i] = lp * Math.exp((-6.9 * i) / len);
    }
  }
  return buf;
}

function crushCurve(bits: number): Float32Array {
  const n = 4096;
  const curve = new Float32Array(n);
  const steps = Math.pow(2, Math.max(2, Math.min(16, bits)) - 1);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

/** Build the chain for `fx`. Returns a pass-through when nothing is on. */
export function createLiveFxChain(ctx: AudioContext, fx: SoundFx | undefined): LiveFxChain {
  const input = ctx.createGain();
  let tail: AudioNode = input;
  const nodes: AudioNode[] = [input];
  const oscillators: OscillatorNode[] = [];
  const updaters: ((fx: SoundFx | undefined) => void)[] = [];
  const link = (n: AudioNode) => {
    tail.connect(n);
    tail = n;
    nodes.push(n);
  };

  // ---- EQ ----
  if (fx?.eq) {
    const preset = fx.eq.preset;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    const bass = ctx.createBiquadFilter();
    bass.type = "lowshelf";
    bass.frequency.value = 110;
    const treble = ctx.createBiquadFilter();
    treble.type = "highshelf";
    treble.frequency.value = 3000;
    const trim = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    const shaperDry = ctx.createGain();
    const shaperWet = ctx.createGain();
    const apply = (f: SoundFx | undefined) => {
      const e = f?.eq;
      if (!e) return;
      let hpF = 0;
      let lpF = 0;
      let b = 0;
      let t = 0;
      let g = 1;
      let crushMix = 0;
      switch (preset) {
        case "radio":
          hpF = 300;
          lpF = 3000;
          g = 1.4;
          break;
        case "telephone":
          hpF = 400;
          lpF = 3400;
          crushMix = 0.25;
          break;
        case "muffled":
          lpF = 700;
          break;
        case "bass":
          b = 8;
          break;
        case "bright":
          t = 6;
          break;
        default:
          hpF = e.highpass ?? 0;
          lpF = e.lowpass ?? 0;
          b = e.bass ?? 0;
          t = e.treble ?? 0;
      }
      hp.frequency.value = hpF > 0 ? hpF : 10;
      lp.frequency.value = lpF > 0 ? lpF : 22000;
      bass.gain.value = b;
      treble.gain.value = t;
      trim.gain.value = g;
      shaperDry.gain.value = 1 - crushMix;
      shaperWet.gain.value = crushMix;
    };
    link(hp);
    link(lp);
    link(bass);
    link(treble);
    link(trim);
    if (preset === "telephone") {
      shaper.curve = crushCurve(12);
      const sum = ctx.createGain();
      tail.connect(shaperDry);
      shaperDry.connect(sum);
      tail.connect(shaper);
      shaper.connect(shaperWet);
      shaperWet.connect(sum);
      nodes.push(shaper, shaperDry, shaperWet, sum);
      tail = sum;
    }
    apply(fx);
    updaters.push(apply);
  }

  // ---- Crush ----
  if (fx?.crush) {
    const shaper = ctx.createWaveShaper();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const sum = ctx.createGain();
    const apply = (f: SoundFx | undefined) => {
      const c = f?.crush;
      if (!c) return;
      shaper.curve = crushCurve(c.bits);
      const mix = Math.min(1, Math.max(0, c.mix / 100));
      dry.gain.value = 1 - mix;
      wet.gain.value = mix;
    };
    tail.connect(dry);
    dry.connect(sum);
    tail.connect(shaper);
    shaper.connect(wet);
    wet.connect(sum);
    nodes.push(shaper, dry, wet, sum);
    tail = sum;
    apply(fx);
    updaters.push(apply);
  }

  // ---- Modulation ----
  if (fx?.modulation) {
    const kind = fx.modulation.kind;
    if (kind === "tremolo") {
      const amp = ctx.createGain();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.connect(lfoGain);
      lfoGain.connect(amp.gain);
      lfo.start();
      oscillators.push(lfo);
      const apply = (f: SoundFx | undefined) => {
        const m = f?.modulation;
        if (!m) return;
        const depth = Math.min(1, Math.max(0, m.depth / 100));
        amp.gain.value = 1 - depth / 2;
        lfoGain.gain.value = depth / 2;
        lfo.frequency.value = m.rate > 0 ? m.rate : 1;
      };
      link(amp);
      nodes.push(lfo, lfoGain);
      apply(fx);
      updaters.push(apply);
    } else {
      const delay = ctx.createDelay(0.1);
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const feedback = ctx.createGain();
      const sum = ctx.createGain();
      lfo.connect(lfoGain);
      lfoGain.connect(delay.delayTime);
      lfo.start();
      oscillators.push(lfo);
      const apply = (f: SoundFx | undefined) => {
        const m = f?.modulation;
        if (!m) return;
        const depth = Math.min(1, Math.max(0, m.depth / 100));
        lfo.frequency.value = m.rate > 0 ? m.rate : 1;
        if (kind === "flanger") {
          delay.delayTime.value = 0.002 + lerp(0.001, 0.01, depth) / 2;
          lfoGain.gain.value = lerp(0.001, 0.01, depth) / 2;
          feedback.gain.value = 0.5;
        } else {
          // chorus: ~55ms centre, swept by the depth (1..8 ms)
          delay.delayTime.value = 0.055;
          lfoGain.gain.value = lerp(0.001, 0.008, depth);
          feedback.gain.value = 0;
        }
        dry.gain.value = 0.75;
        wet.gain.value = 0.6;
      };
      tail.connect(dry);
      dry.connect(sum);
      tail.connect(delay);
      delay.connect(wet);
      delay.connect(feedback);
      feedback.connect(delay);
      wet.connect(sum);
      nodes.push(delay, dry, wet, feedback, sum, lfo, lfoGain);
      tail = sum;
      apply(fx);
      updaters.push(apply);
    }
  }

  // ---- Compressor ----
  if (fx?.compress) {
    const comp = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();
    const apply = (f: SoundFx | undefined) => {
      const c = f?.compress;
      if (!c) return;
      const t = Math.min(1, Math.max(0, c.amount / 100));
      comp.threshold.value = lerp(-10, -28, t);
      comp.ratio.value = lerp(1.5, 8, t);
      comp.knee.value = 6;
      comp.attack.value = 0.005;
      comp.release.value = 0.12;
      makeup.gain.value = dbToLin(lerp(0, 8, t));
    };
    link(comp);
    link(makeup);
    apply(fx);
    updaters.push(apply);
  }

  // ---- Reverb ----
  if (fx?.reverb) {
    const preset = fx.reverb.preset;
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const sum = ctx.createGain();
    let lastIr = "";
    if (preset === "slap") {
      const delay = ctx.createDelay(1);
      const fb = ctx.createGain();
      delay.connect(fb);
      fb.connect(delay);
      const apply = (f: SoundFx | undefined) => {
        const r = f?.reverb;
        if (!r) return;
        const w = Math.min(1, Math.max(0, r.wet / 100));
        delay.delayTime.value = 0.11;
        fb.gain.value = lerp(0.2, 0.6, w) * 0.6;
        dry.gain.value = 1;
        wet.gain.value = lerp(0.2, 0.6, w);
      };
      tail.connect(dry);
      dry.connect(sum);
      tail.connect(delay);
      delay.connect(wet);
      wet.connect(sum);
      nodes.push(delay, fb, dry, wet, sum);
      tail = sum;
      apply(fx);
      updaters.push(apply);
    } else {
      const conv = ctx.createConvolver();
      const apply = (f: SoundFx | undefined) => {
        const r = f?.reverb;
        if (!r) return;
        const w = Math.min(1, Math.max(0, r.wet / 100));
        const [presetDecay, damp] =
          preset === "hall" ? [1.8, 4500] : preset === "cave" ? [3.5, 2500] : [0.45, 6000];
        const decay = r.decay && r.decay > 0 ? Math.min(6, Math.max(0.1, r.decay)) : presetDecay;
        const irKey = `${decay}|${damp}`;
        if (irKey !== lastIr) {
          conv.buffer = makeImpulse(ctx, decay, damp);
          lastIr = irKey;
        }
        dry.gain.value = lerp(1, 0.55, w);
        wet.gain.value = lerp(0, 1.3, w);
      };
      tail.connect(dry);
      dry.connect(sum);
      tail.connect(conv);
      conv.connect(wet);
      wet.connect(sum);
      nodes.push(conv, dry, wet, sum);
      tail = sum;
      apply(fx);
      updaters.push(apply);
    }
  }

  return {
    input,
    output: tail,
    key: liveFxKey(fx),
    update(next) {
      for (const u of updaters) u(next);
    },
    dispose() {
      for (const o of oscillators) {
        try {
          o.stop();
        } catch {
          /* already stopped */
        }
      }
      for (const n of nodes) n.disconnect();
    },
  };
}

/** A brick-wall-ish limiter for the end of the chain (ffmpeg: alimiter 0.95). */
export function createLimiter(ctx: AudioContext): DynamicsCompressorNode {
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -1;
  lim.knee.value = 0;
  lim.ratio.value = 20;
  lim.attack.value = 0.001;
  lim.release.value = 0.05;
  return lim;
}

/** Pitch preview on the media element: semitones as a tape-style rate
 *  change (the compile keeps the clip's length with rubberband - this is the
 *  closest a live element can get), tempo as a pitch-preserving rate. */
export function applyLivePitch(el: HTMLMediaElement, fx: SoundFx | undefined) {
  const p = fx?.pitch;
  const semis = p?.semitones ?? 0;
  const tempo = p?.tempo && p.tempo > 0 ? p.tempo : 1;
  if (semis !== 0) {
    el.preservesPitch = false;
    el.playbackRate = Math.pow(2, semis / 12) * tempo;
  } else {
    el.preservesPitch = true;
    el.playbackRate = tempo;
  }
}
