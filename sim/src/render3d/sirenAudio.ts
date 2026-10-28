import type { EmergencyKind } from '../traffic/vehicleTypes';

// Procedural siren (Web Audio, no samples): a sawtooth swept up and down by a low-frequency
// oscillator, through a low-pass filter. Ambulances and fire engines wail (a slow sweep), police
// cars yelp (a fast one). One voice plays the unit nearest the camera, louder the nearer it is.
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

  // Each frame: the nearest unit with its siren on and its distance (m), or null for silence.
  update(nearest: { kind: EmergencyKind; dist: number } | null, playing: boolean): void {
    if (!this.ctx || !this.gain || !this.lfo) return;
    const near = nearest && playing && !this.muted ? Math.max(0, 1 - nearest.dist / AUDIBLE_M) : 0;
    const now = this.ctx.currentTime;
    this.gain.gain.setTargetAtTime(MAX_GAIN * near * near, now, 0.08);
    if (nearest) this.lfo.frequency.setTargetAtTime(nearest.kind === 'police' ? SWEEP_RATE.yelp : SWEEP_RATE.wail, now, 0.05);
  }
}
