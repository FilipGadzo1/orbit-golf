/**
 * Generative ambient bed, synthesised at runtime like sfx.ts — no audio files.
 * A slow chord pad plus an occasional arpeggio note, scheduled on a timer while playing.
 */
export class Music {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private step = 0;
  volume = 0.35;
  private playing = false;

  /** Safe to call repeatedly; only resumes inside a user gesture. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
    if (v <= 0) this.stop();
    else if (!this.playing) this.start();
  }

  start(): void {
    if (this.playing || this.volume <= 0) return;
    this.unlock();
    if (!this.ctx) return;
    this.playing = true;
    this.tick();
    // A note every ~2.2s keeps the bed sparse and non-distracting.
    this.timer = setInterval(() => this.tick(), 2200);
  }

  stop(): void {
    this.playing = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One scheduled voice: a soft sine held for a few seconds, drifting through a scale. */
  private tick(): void {
    if (!this.ctx || !this.master) return;
    // A minor pentatonic-ish set, low and calm.
    const scale = [110, 130.81, 146.83, 164.81, 196, 220];
    const root = scale[this.step % scale.length];
    this.step++;
    this.voice(root, 4.5, 0.05);
    // A fifth above, quieter, on every other step for movement.
    if (this.step % 2 === 0) this.voice(root * 1.5, 3.5, 0.03);
  }

  private voice(freq: number, dur: number, gain: number): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.8);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }
}

export const music = new Music();
