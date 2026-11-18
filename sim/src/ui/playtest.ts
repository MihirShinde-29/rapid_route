// Playtest log (A6 user study). Opened with ?playtest=S1 (the subject's code); off otherwise.
// It records what the observer can't write down fast enough: every click and key, each call and
// what happened to it, how long each tutorial step took, the frame rate every few seconds and any
// drop below 40 fps with what was on screen, errors, and the end-of-shift result. Nothing leaves
// the browser: the log is kept in localStorage (so the reload when a shift starts doesn't lose it)
// and saved as a JSON file from the badge in the corner.

export interface LogEntry {
  t: number; // real seconds since the session started
  type: string;
  [k: string]: unknown;
}

interface Session {
  subject: string;
  started: string; // ISO time
  userAgent: string;
  screen: string;
  entries: LogEntry[];
}

const DIP_FPS = 40;
const SAMPLE_S = 5;

export class PlaytestLog {
  private s: Session;
  private key: string;
  private t0: number;
  private badge: HTMLDivElement;
  private win = { start: 0, frames: 0, worst: 0 };
  private sample = { start: 0, frames: 0, worst: 0 };
  private lastStep: string | null = null;
  private stepSince = 0;
  private saveTimer = 0;

  constructor(subject: string) {
    this.key = `dispatch.playtest.${subject}`;
    let s: Session | null = null;
    try {
      s = JSON.parse(localStorage.getItem(this.key) ?? 'null');
    } catch {
      s = null;
    }
    this.s = s ?? {
      subject,
      started: new Date().toISOString(),
      userAgent: navigator.userAgent,
      screen: `${screen.width}x${screen.height} @${devicePixelRatio}`,
      entries: [],
    };
    // Times run on from where the log left off before a reload.
    this.t0 = performance.now() - (Date.now() - Date.parse(this.s.started));
    this.badge = document.createElement('div');
    this.badge.className = 'playtest-badge';
    const label = document.createElement('span');
    const save = document.createElement('button');
    save.textContent = 'Save log';
    save.onclick = (e) => {
      e.stopPropagation();
      this.download();
    };
    const clear = document.createElement('button');
    clear.textContent = 'Clear';
    clear.onclick = (e) => {
      e.stopPropagation();
      if (!confirm(`Delete the log for ${subject}? Save it first.`)) return;
      this.s.entries = [];
      this.s.started = new Date().toISOString();
      this.t0 = performance.now();
      this.persist();
    };
    this.badge.append(label, save, clear);
    document.body.append(this.badge);
    setInterval(() => {
      const m = Math.floor(this.now() / 60);
      label.textContent = `● Playtest ${subject} · ${m} min · ${this.s.entries.length} events`;
    }, 1000);
    this.log('page', { url: location.search });
    document.addEventListener('click', (e) => this.click(e), true);
    document.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      this.log('key', { key: e.key, in: t.id || t.tagName.toLowerCase() });
    }, true);
    window.addEventListener('error', (e) => this.log('error', { message: String(e.message) }));
    window.addEventListener('unhandledrejection', (e) => this.log('error', { message: String(e.reason) }));
    window.addEventListener('beforeunload', () => this.persist());
  }

  private now(): number {
    return Math.round((performance.now() - this.t0) / 100) / 10;
  }

  log(type: string, data: Record<string, unknown> = {}): void {
    this.s.entries.push({ t: this.now(), type, ...data });
    // Written out at most once a second.
    if (!this.saveTimer) this.saveTimer = window.setTimeout(() => this.persist(), 1000);
  }

  // What was clicked, in words an observer can match to the screen.
  private click(e: MouseEvent): void {
    const el = e.target as HTMLElement;
    if (el.closest('.playtest-badge')) return;
    const named = el.closest('button, select, a, input, [id]') as HTMLElement | null;
    const what = named?.id || named?.className || el.tagName.toLowerCase();
    const text = (named?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
    this.log('click', { on: what, text, x: e.clientX, y: e.clientY });
  }

  // Every frame: frame time, plus what is on screen when it dips.
  frame(dtMs: number, context: () => Record<string, unknown>): void {
    const now = performance.now();
    for (const w of [this.win, this.sample]) {
      if (w.start === 0) w.start = now;
      w.frames++;
      w.worst = Math.max(w.worst, dtMs);
    }
    if (now - this.win.start >= 1000) {
      const fps = (this.win.frames * 1000) / (now - this.win.start);
      if (fps < DIP_FPS) this.log('fps_dip', { fps: Math.round(fps), worstFrameMs: Math.round(this.win.worst), ...context() });
      this.win = { start: now, frames: 0, worst: 0 };
    }
    if (now - this.sample.start >= SAMPLE_S * 1000) {
      const fps = (this.sample.frames * 1000) / (now - this.sample.start);
      this.log('fps', { fps: Math.round(fps), worstFrameMs: Math.round(this.sample.worst), ...context() });
      this.sample = { start: now, frames: 0, worst: 0 };
    }
  }

  // The tutorial step on screen (null when none); logs each change with how long the last one took.
  tutorialStep(step: string | null): void {
    if (step === this.lastStep) return;
    const now = performance.now();
    if (this.lastStep !== null) this.log('tutorial_step_done', { step: this.lastStep, seconds: Math.round((now - this.stepSince) / 100) / 10 });
    if (step !== null) this.log('tutorial_step', { step });
    this.lastStep = step;
    this.stepSince = now;
  }

  private persist(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    try {
      localStorage.setItem(this.key, JSON.stringify(this.s));
    } catch {
      // storage full or blocked: the in-memory log still saves from the badge
    }
  }

  download(): void {
    this.persist();
    const blob = new Blob([JSON.stringify(this.s, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `playtest-${this.s.subject}-${this.s.started.slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
