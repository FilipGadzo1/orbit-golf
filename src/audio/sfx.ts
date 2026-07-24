/**
 * All sound is synthesised at runtime — no audio assets to load or ship.
 * The context stays suspended until the first user gesture (browser autoplay policy).
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  enabled = true;
  volume = 0.6;

  /** Safe to call repeatedly; only the first call inside a gesture actually resumes. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.noiseBuffer = this.makeNoise(this.ctx);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  private makeNoise(ctx: AudioContext): AudioBuffer {
    const buf = ctx.createBuffer(1, ctx.sampleRate * 1.2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  private tone(
    freq: number,
    dur: number,
    type: OscillatorType,
    gain: number,
    at = 0,
    endFreq?: number,
  ): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    const t = this.ctx.currentTime + at;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, gain: number, filterHz: number, at = 0, q = 1): void {
    if (!this.ctx || !this.master || !this.noiseBuffer || !this.enabled) return;
    const t = this.ctx.currentTime + at;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = filterHz;
    filter.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /** `power` 0..1 — harder putts get brighter and punchier. */
  putt(power: number): void {
    this.tone(180 + power * 220, 0.16, 'triangle', 0.22, 0, 80);
    this.noise(0.08, 0.16 + power * 0.14, 900 + power * 1800, 0, 0.8);
  }

  bounce(strength: number): void {
    const f = 140 + strength * 320;
    this.tone(f, 0.09, 'sine', 0.06 + strength * 0.12, 0, f * 0.6);
    this.noise(0.05, 0.05 + strength * 0.1, 700 + strength * 1400, 0, 1.4);
  }

  sink(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((n, i) => this.tone(n, 0.34, 'sine', 0.16, i * 0.075));
    this.noise(0.5, 0.05, 1600, 0.05, 0.5);
  }

  lost(): void {
    this.tone(420, 0.9, 'sawtooth', 0.11, 0, 60);
    this.noise(0.7, 0.07, 400, 0, 0.4);
  }

  crush(): void {
    this.tone(90, 1.1, 'sawtooth', 0.16, 0, 28);
    this.noise(0.9, 0.14, 180, 0, 0.3);
  }

  ui(up = true): void {
    this.tone(up ? 880 : 520, 0.06, 'square', 0.045);
  }

  levelUp(): void {
    [392, 523.25, 659.25, 880].forEach((n, i) => this.tone(n, 0.28, 'triangle', 0.13, i * 0.09));
  }

  join(): void {
    this.tone(660, 0.12, 'sine', 0.09);
    this.tone(990, 0.16, 'sine', 0.07, 0.1);
  }
}

export const sfx = new Sfx();
