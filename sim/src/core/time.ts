// Sim time is seconds since midnight. Units everywhere: metres, seconds.
export const HOUR = 3600;

export type Period = 'night' | 'am' | 'midday' | 'pm' | 'evening';

export function hourOf(t: number): number {
  return (((t / HOUR) % 24) + 24) % 24;
}

export function periodAt(t: number): Period {
  const h = hourOf(t);
  if (h >= 6 && h < 10) return 'am';
  if (h >= 10 && h < 15) return 'midday';
  if (h >= 15 && h < 19) return 'pm';
  if (h >= 19 && h < 22) return 'evening';
  return 'night';
}

// Relative citywide trip volume, ~1.0 at the 08:00 and 17:30 peaks.
export function volumeFactor(t: number): number {
  const h = hourOf(t);
  const bump = (mu: number, sigma: number) => Math.exp(-(((h - mu) / sigma) ** 2));
  const v = 0.08 + 0.92 * bump(8, 1.1) + 0.92 * bump(17.5, 1.3) + 0.3 * bump(12.5, 2.0);
  return Math.min(1, v);
}

export function formatClock(t: number): string {
  const h = hourOf(t);
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
