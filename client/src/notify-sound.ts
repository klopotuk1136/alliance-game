// «Штаб» sounds, synthesized with WebAudio (no files): short, soft, a little brass and wood.
// At most one sound per 400 ms; nothing until the first tap/key (browsers, iOS especially,
// only let a page make sound after a user gesture).

export type SoundKind =
  /** A message in the room-wide chat: a soft wooden tick. */
  | 'chat'
  /** A private or group message: two rising notes. */
  | 'dm'
  /** You were attacked: a low thud. */
  | 'hit'
  /** You were eliminated: a thud and a falling tone. */
  | 'fall'
  /** AP gained (tick or gift): a bright brass ding. */
  | 'ap'
  /** The game started / ended: a short fanfare. */
  | 'start'
  /** A peace proposal: a chime. */
  | 'peace'
  /** Blitz: a new turn. */
  | 'turn'
  /** Blitz: 10 seconds left. */
  | 'hurry';

export const SOUND_KINDS: SoundKind[] = ['chat', 'dm', 'hit', 'fall', 'ap', 'start', 'peace', 'turn', 'hurry'];

const MIN_GAP_MS = 400;

type Ctx = AudioContext;
let ctx: Ctx | null = null;
let unlocked = false;
let lastAt = 0;

function audio(): Ctx | null {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC({ latencyHint: 'interactive' });
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Call once at startup: the first gesture creates/resumes the audio context (and plays silence, for iOS). */
export function installAudioUnlock(): void {
  const unlock = (): void => {
    const c = audio();
    if (!c) return;
    void c.resume().catch(() => undefined);
    if (!unlocked) {
      try {
        const b = c.createBuffer(1, 1, 22050);
        const src = c.createBufferSource();
        src.buffer = b;
        src.connect(c.destination);
        src.start(0);
      } catch {
        /* ignore */
      }
    }
    if (c.state === 'running') {
      unlocked = true;
      for (const ev of EVENTS) window.removeEventListener(ev, unlock, true);
    }
  };
  const EVENTS = ['pointerdown', 'keydown', 'touchend'] as const;
  for (const ev of EVENTS) window.addEventListener(ev, unlock, { capture: true, passive: true });
}

// ---------------------------------------------------------------- building blocks

interface Voice {
  freq: number;
  /** Start offset (s). */
  at?: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  /** Frequency glide target (s-curve to it over `dur`). */
  to?: number;
  /** Low-pass cutoff; with `bright` it opens and closes like a brass note. */
  cutoff?: number;
  bright?: boolean;
  attack?: number;
}

function tone(c: Ctx, out: AudioNode, t0: number, v: Voice): void {
  const start = t0 + (v.at ?? 0);
  const osc = c.createOscillator();
  osc.type = v.type ?? 'sine';
  osc.frequency.setValueAtTime(v.freq, start);
  if (v.to) osc.frequency.exponentialRampToValueAtTime(v.to, start + v.dur);
  const g = c.createGain();
  const peak = v.gain ?? 0.3;
  const attack = v.attack ?? 0.006;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(peak, start + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, start + v.dur);
  let node: AudioNode = osc;
  if (v.cutoff) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 0.7;
    if (v.bright) {
      f.frequency.setValueAtTime(v.cutoff * 0.35, start);
      f.frequency.exponentialRampToValueAtTime(v.cutoff, start + 0.04);
      f.frequency.exponentialRampToValueAtTime(v.cutoff * 0.3, start + v.dur);
    } else {
      f.frequency.value = v.cutoff;
    }
    osc.connect(f);
    node = f;
  }
  node.connect(g);
  g.connect(out);
  osc.start(start);
  osc.stop(start + v.dur + 0.05);
}

let noiseBuf: AudioBuffer | null = null;

function noise(c: Ctx, out: AudioNode, t0: number, o: { at?: number; dur: number; gain: number; type: BiquadFilterType; freq: number; q?: number }): void {
  if (!noiseBuf || noiseBuf.sampleRate !== c.sampleRate) {
    noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.5), c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let seed = 7;
    for (let i = 0; i < d.length; i++) {
      seed = (seed * 16807) % 2147483647;
      d[i] = (seed / 2147483647) * 2 - 1;
    }
  }
  const start = t0 + (o.at ?? 0);
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const f = c.createBiquadFilter();
  f.type = o.type;
  f.frequency.value = o.freq;
  f.Q.value = o.q ?? 1;
  const g = c.createGain();
  g.gain.setValueAtTime(o.gain, start);
  g.gain.exponentialRampToValueAtTime(0.0001, start + o.dur);
  src.connect(f);
  f.connect(g);
  g.connect(out);
  src.start(start);
  src.stop(start + o.dur + 0.02);
}

/** A struck bell: a fundamental with slightly inharmonic partials and a long tail. */
function bell(c: Ctx, out: AudioNode, t0: number, freq: number, at: number, dur: number, gain: number): void {
  tone(c, out, t0, { freq, at, dur, gain, attack: 0.003 });
  tone(c, out, t0, { freq: freq * 2.01, at, dur: dur * 0.55, gain: gain * 0.35, attack: 0.002 });
  tone(c, out, t0, { freq: freq * 3.03, at, dur: dur * 0.3, gain: gain * 0.15, attack: 0.002 });
}

/** A short brass note: a sawtooth through a low-pass that opens on the attack. */
function brass(c: Ctx, out: AudioNode, t0: number, freq: number, at: number, dur: number, gain: number): void {
  tone(c, out, t0, { freq, at, dur, gain, type: 'sawtooth', cutoff: Math.min(6000, freq * 6), bright: true, attack: 0.018 });
  tone(c, out, t0, { freq: freq / 2, at, dur, gain: gain * 0.25, type: 'triangle', attack: 0.02 });
}

const RECIPES: Record<SoundKind, (c: Ctx, out: AudioNode, t: number) => void> = {
  chat(c, out, t) {
    noise(c, out, t, { dur: 0.05, gain: 0.35, type: 'bandpass', freq: 1900, q: 6 });
    tone(c, out, t, { freq: 1320, dur: 0.09, gain: 0.12, type: 'triangle', attack: 0.002 });
  },
  dm(c, out, t) {
    bell(c, out, t, 784, 0, 0.32, 0.2);
    bell(c, out, t, 1046.5, 0.11, 0.42, 0.2);
  },
  hit(c, out, t) {
    tone(c, out, t, { freq: 120, to: 48, dur: 0.32, gain: 0.7, attack: 0.004 });
    noise(c, out, t, { dur: 0.18, gain: 0.35, type: 'lowpass', freq: 420 });
  },
  fall(c, out, t) {
    tone(c, out, t, { freq: 110, to: 40, dur: 0.4, gain: 0.7, attack: 0.004 });
    noise(c, out, t, { dur: 0.2, gain: 0.3, type: 'lowpass', freq: 380 });
    tone(c, out, t, { freq: 392, to: 196, at: 0.12, dur: 0.6, gain: 0.12, type: 'triangle' });
  },
  ap(c, out, t) {
    bell(c, out, t, 1568, 0, 0.55, 0.16);
    brass(c, out, t, 784, 0, 0.18, 0.06);
  },
  start(c, out, t) {
    brass(c, out, t, 392, 0, 0.14, 0.12);
    brass(c, out, t, 523.25, 0.12, 0.14, 0.12);
    brass(c, out, t, 659.25, 0.24, 0.14, 0.12);
    brass(c, out, t, 784, 0.36, 0.42, 0.14);
  },
  peace(c, out, t) {
    bell(c, out, t, 659.25, 0, 0.9, 0.13);
    bell(c, out, t, 987.77, 0.16, 1.0, 0.11);
    bell(c, out, t, 1318.5, 0.32, 1.1, 0.08);
  },
  turn(c, out, t) {
    brass(c, out, t, 392, 0, 0.12, 0.12);
    brass(c, out, t, 587.33, 0.11, 0.3, 0.13);
  },
  hurry(c, out, t) {
    for (let i = 0; i < 3; i++) {
      noise(c, out, t, { at: i * 0.13, dur: 0.04, gain: 0.3, type: 'bandpass', freq: 2600, q: 8 });
      tone(c, out, t, { freq: 1760, at: i * 0.13, dur: 0.06, gain: 0.08, type: 'square', cutoff: 3000 });
    }
  },
};

/**
 * Plays one sound at `volume` (0..1). Returns false when it was skipped (audio locked or
 * unavailable, or another sound played less than 400 ms ago).
 */
export function playSound(kind: SoundKind, volume: number, force = false): boolean {
  const c = audio();
  if (!c || volume <= 0) return false;
  const now = performance.now();
  if (!force && now - lastAt < MIN_GAP_MS) return false;
  if (c.state !== 'running') {
    void c.resume().catch(() => undefined);
    if ((c.state as AudioContextState) !== 'running' && !force) return false;
  }
  lastAt = now;
  const out = c.createGain();
  out.gain.value = Math.min(1, volume) * 0.9;
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  out.connect(comp);
  comp.connect(c.destination);
  RECIPES[kind](c, out, c.currentTime + 0.01);
  setTimeout(() => {
    out.disconnect();
    comp.disconnect();
  }, 2000);
  return true;
}
