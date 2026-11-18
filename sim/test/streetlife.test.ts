import { describe, expect, it } from 'vitest';
import { share } from '../src/render3d/streetLife';

// Street life (A6): people out and parking taken follow the time of day.
describe('street life by time of day', () => {
  it('stays between 0 and 1 all day', () => {
    for (const kind of ['downtown', 'park', 'residential', 'industrial', 'shops', 'work', 'home'] as const) {
      for (let h = 0; h <= 24; h += 0.25) {
        const v = share(kind, h);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('fills downtown and the car parks by day and empties them at night', () => {
    expect(share('downtown', 12)).toBeGreaterThan(5 * share('downtown', 3));
    expect(share('shops', 13)).toBeGreaterThan(share('shops', 3));
    expect(share('work', 11)).toBeGreaterThan(share('work', 23));
  });

  it('keeps cars on house driveways at night and fewer during the working day', () => {
    expect(share('home', 2)).toBeGreaterThan(0.8);
    expect(share('home', 12)).toBeLessThan(0.5);
  });

  it('wraps past midnight', () => {
    expect(share('downtown', 25)).toBeCloseTo(share('downtown', 1));
    expect(share('home', -1)).toBeCloseTo(share('home', 23));
  });
});
