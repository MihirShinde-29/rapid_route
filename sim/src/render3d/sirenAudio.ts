import type { EmergencyKind } from '../traffic/vehicleTypes';

// Procedural siren (Web Audio, no samples): a sawtooth swept up and down by a low-frequency
// oscillator, through a low-pass filter. Ambulances and fire engines wail (a slow sweep), police
// cars yelp (a fast one). One voice plays the unit nearest the camera, louder the nearer it is.
// The same context plays the UI sounds (new-call chime, missed-call tone, button ticks).
const BASE_HZ = 1050;
const SWEEP_HZ = 420; // up and down from the base
const SWEEP_RATE = { wail: 0.22, yelp: 3.2 }; // sweeps per second
const AUDIBLE_M = 700; // silent beyond this distance from the camera
const MAX_GAIN = 0.12;

export class SirenAudio {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private lfo: OscillatorNode | null = null;
  muted = false;

  // Browsers only allow audio after a user gesture; call this from one (a click or key press).
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = BASE_HZ;
    const lfo = ctx.createOscillator();
    lfo.type = 'triangle';
    lfo.frequency.value = SWEEP_RATE.wail;
    const depth = ctx.createGain();
    depth.gain.value = SWEEP_HZ;
    lfo.connect(depth).connect(osc.frequency);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2400;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(filter).connect(gain).connect(ctx.destination);
    osc.start();
    lfo.start();
    this.ctx = ctx;
    this.gain = gain;
    this.lfo = lfo;
  }

  // New call: two rising sine notes.
  chime(): void {
    this.note(880, 0, 0.18, 0.09);
    this.note(1320, 0.12, 0.28, 0.09);
  }

  // Missed call: a low falling pair.
  alarm(): void {
    this.note(392, 0, 0.22, 0.1, 'triangle');
    this.note(294, 0.18, 0.35, 0.1, 'triangle');
  }

  // Button press: a very short tick.
  tick(): void {
    this.note(1600, 0, 0.03, 0.025, 'square');
  }

  private note(hz: number, delay: number, length: number, peak: number, type: OscillatorType = 'sine'): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = hz;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(peak, t0 + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + length);
    osc.connect(env).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + length + 0.02);
  }

  // Each frame: the nearest unit with its siren on and its distance (m), or null for silence.
  update(nearest: { kind: EmergencyKind; dist: number } | null, playing: boolean): void {
    if (!this.ctx || !this.gain || !this.lfo) return;
    const near = nearest && playing && !this.muted ? Math.max(0, 1 - nearest.dist / AUDIBLE_M) : 0;
    const now = this.ctx.currentTime;
    this.gain.gain.setTargetAtTime(MAX_GAIN * near * near, now, 0.08);
    if (nearest) this.lfo.frequency.setTargetAtTime(nearest.kind === 'police' ? SWEEP_RATE.yelp : SWEEP_RATE.wail, now, 0.05);
  }
}
