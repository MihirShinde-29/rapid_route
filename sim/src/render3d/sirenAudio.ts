import type { EmergencyKind } from '../traffic/vehicleTypes';

// All the game's sound, procedural (Web Audio, no samples): traffic, wind and birdsong round the
// camera (see traffic() and ambience()), the UI sounds, and the siren. Procedural siren: a sawtooth swept up and down by a low-frequency
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
  private windGain: GainNode | null = null;
  private rumbleGain: GainNode | null = null;
  private hissGain: GainNode | null = null;
  private nextChirp = 0;
  private nextHorn = 0;
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
    // Ambience: a soft wind (looping noise through a band-pass, swelling slowly).
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 420;
    band.Q.value = 0.5;
    const swell = ctx.createOscillator();
    swell.frequency.value = 0.13;
    const swellDepth = ctx.createGain();
    swellDepth.gain.value = 180;
    swell.connect(swellDepth).connect(band.frequency);
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    src.connect(band).connect(windGain).connect(ctx.destination);
    src.start();
    swell.start();
    this.windGain = windGain;
    // Traffic: a low rumble of engines and tyres, and a higher hiss (wet roads hiss more), both from
    // the same noise through different filters.
    const rumbleSrc = ctx.createBufferSource();
    rumbleSrc.buffer = noise;
    rumbleSrc.loop = true;
    rumbleSrc.playbackRate.value = 0.5;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 260;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0;
    rumbleSrc.connect(low).connect(rumbleGain).connect(ctx.destination);
    const hissSrc = ctx.createBufferSource();
    hissSrc.buffer = noise;
    hissSrc.loop = true;
    const high = ctx.createBiquadFilter();
    high.type = 'bandpass';
    high.frequency.value = 1800;
    high.Q.value = 0.7;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0;
    hissSrc.connect(high).connect(hissGain).connect(ctx.destination);
    rumbleSrc.start();
    hissSrc.start();
    this.rumbleGain = rumbleGain;
    this.hissGain = hissGain;
  }

  // Each frame: the traffic heard from the camera (0 none .. ~1 a busy street close by), whether the
  // roads are wet, and how many cars close by are stuck (for the odd horn).
  traffic(level: number, wet: boolean, stuck: number): void {
    if (!this.ctx || !this.rumbleGain || !this.hissGain) return;
    const now = this.ctx.currentTime;
    const l = this.muted ? 0 : Math.min(1.2, level);
    this.rumbleGain.gain.setTargetAtTime(0.11 * l, now, 0.3);
    this.hissGain.gain.setTargetAtTime((wet ? 0.05 : 0.018) * l, now, 0.3);
    if (this.muted || stuck < 3 || now < this.nextHorn) return;
    this.nextHorn = now + 3 + Math.random() * 10 / Math.min(4, stuck / 3);
    // A car horn: two detuned square tones, filtered, short (sometimes twice).
    const beeps = Math.random() < 0.35 ? 2 : 1;
    for (let b = 0; b < beeps; b++) {
      const t0 = now + b * 0.3;
      const len = 0.18 + Math.random() * 0.25;
      const env = this.ctx.createGain();
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(0.03 * Math.min(1, l * 1.5), t0 + 0.02);
      env.gain.setValueAtTime(0.03 * Math.min(1, l * 1.5), t0 + len);
      env.gain.linearRampToValueAtTime(0, t0 + len + 0.04);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1500;
      lp.connect(env).connect(this.ctx.destination);
      const base = 380 + Math.random() * 120;
      for (const hz of [base, base * 1.26]) {
        const o = this.ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = hz;
        o.connect(lp);
        o.start(t0);
        o.stop(t0 + len + 0.05);
      }
    }
  }

  // Each frame: the wind (0 calm .. ~1.5) and how much birdsong to play (0 none .. 1, by day near
  // the ground). A chirp is two or three quick rising notes.
  ambience(wind: number, birds: number): void {
    if (!this.ctx || !this.windGain) return;
    const now = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(this.muted ? 0 : 0.012 + 0.03 * wind, now, 0.5);
    if (this.muted || birds <= 0 || now < this.nextChirp) return;
    this.nextChirp = now + 1.5 + Math.random() * 4 / birds;
    const base = 2600 + Math.random() * 1400;
    const notes = 2 + Math.floor(Math.random() * 2);
    for (let k = 0; k < notes; k++) this.chirp(base * (1 + 0.08 * k), k * 0.11, 0.022 * birds);
  }

  private chirp(hz: number, delay: number, peak: number): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(hz, t0);
    osc.frequency.exponentialRampToValueAtTime(hz * 1.35, t0 + 0.07);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(peak, t0 + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
    osc.connect(env).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.1);
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
