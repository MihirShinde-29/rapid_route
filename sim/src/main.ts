import { Simulation, FIXED_DT, DEFAULT_CONFIG } from './sim';
import { View3D } from './render3d/view3d';
import { OdHeatmap, zoneLabel } from './render3d/odHeatmap';
import { formatClock, periodAt, HOUR, type Period } from './core/time';
import type { ZoneType } from './demand/zones';

// ?start=7.75 opens at 07:45 with the previous 30 sim minutes already run,
// so the roads are loaded instead of empty (useful for demos).
const WARMUP_H = 0.5;
const startParam = new URLSearchParams(location.search).get('start');
const startHour = startParam !== null && Number(startParam) >= WARMUP_H && Number(startParam) < 24 ? Number(startParam) : null;
const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: startHour !== null ? startHour - WARMUP_H : DEFAULT_CONFIG.startHour });
const warmUntil = startHour !== null ? startHour * HOUR : -Infinity;
const WARMUP_STEPS_PER_FRAME = 600;
const $ = (id: string) => document.getElementById(id)!;

const view = new View3D($('three-container'), sim);
const heatmap = new OdHeatmap($('odCanvas') as HTMLCanvasElement, $('odReadout'), sim);

const PERIOD_LABEL: Record<Period, string> = {
  night: 'Night 22–06',
  am: 'AM 06–10',
  midday: 'Midday 10–15',
  pm: 'PM 15–19',
  evening: 'Evening 19–22',
};
const TYPE_CSS: Record<ZoneType, string> = {
  residential: 'var(--res)',
  commercial: 'var(--com)',
  industrial: 'var(--ind)',
  park: 'var(--park)',
};

const speedSel = $('speed') as HTMLSelectElement;
const pauseBtn = $('pause') as HTMLButtonElement;
const arcsBtn = $('arcs') as HTMLButtonElement;
let paused = false;
pauseBtn.onclick = () => {
  paused = !paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
};
arcsBtn.onclick = () => {
  view.showDesireLines = !view.showDesireLines;
  arcsBtn.setAttribute('aria-pressed', String(view.showDesireLines));
};
$('reset').onclick = () => location.reload();

function listItem(color: string, name: string, num: string): HTMLLIElement {
  const li = document.createElement('li');
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = color;
  const n = document.createElement('span');
  n.className = 'name';
  n.textContent = name;
  const v = document.createElement('span');
  v.className = 'num';
  v.textContent = num;
  li.append(dot, n, v);
  return li;
}

let shownPeriod: Period | null = null;
function updateSidebar(): void {
  const period = periodAt(sim.time);
  $('clock').textContent = formatClock(sim.time);
  $('period').textContent = PERIOD_LABEL[period];
  $('target').textContent = Math.round(sim.trips.ratePerHour(sim.time)).toLocaleString();
  $('rate').textContent = sim.observedTripsPerHour().toLocaleString();
  $('total').textContent = sim.totalTrips.toLocaleString();
  const traffic = sim.traffic;
  $('cars').textContent = traffic.vehicles.size.toLocaleString();
  $('arrived').textContent = traffic.arrived.toLocaleString();
  $('meanTrip').textContent = traffic.arrived > 0 ? `${Math.round(traffic.meanTravelTime)} s` : '—';
  $('backlog').textContent = traffic.waitingToDepart.toLocaleString();
  $('gridlock').textContent = `Removed by gridlock guard (stopped > 3 min): ${traffic.removedGridlock}`;

  const latestRoute = sim.routeLog[0];
  if (latestRoute) {
    const selected = latestRoute.chosen;
    const baseline = latestRoute.shortest;
    $('routeChosen').textContent = `${selected.cost.toFixed(1)} s`;
    $('routeBaseline').textContent = `${baseline.cost.toFixed(1)} s`;
    $('routeDelta').textContent = `${selected.links.length} links vs ${baseline.links.length} free-flow`;
    $('routeLog').textContent = `Trip #${latestRoute.tripId}: chosen ${selected.cost.toFixed(1)} s · shortest ${baseline.cost.toFixed(1)} s`;
  }

  if (period !== shownPeriod) {
    shownPeriod = period;
    $('periodStat').textContent = PERIOD_LABEL[period];
    $('odPeriod').textContent = PERIOD_LABEL[period];
    heatmap.update(period);
    $('topPairs').replaceChildren(
      ...heatmap
        .topPairs(5)
        .map((p) =>
          listItem(TYPE_CSS[sim.zones[p.o].type], `${zoneLabel(sim, p.o)} → ${zoneLabel(sim, p.d)}`, `${(p.share * 100).toFixed(2)}%`),
        ),
    );
  }

  const types: ZoneType[] = ['residential', 'commercial', 'industrial', 'park'];
  $('zoneTypes').replaceChildren(
    ...types.map((t) => {
      let out = 0;
      let inn = 0;
      let count = 0;
      for (const z of sim.zones) {
        if (z.type !== t) continue;
        count++;
        out += sim.produced[z.id];
        inn += sim.attracted[z.id];
      }
      return listItem(TYPE_CSS[t], `${t} (${count})`, `${out.toLocaleString()} / ${inn.toLocaleString()}`);
    }),
  );
}

const MAX_STEPS_PER_FRAME = 2000;
const SIDEBAR_MS = 250;
let acc = 0;
let last = performance.now();
let lastSidebar = -Infinity;

function frame(now: number): void {
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const warming = sim.time < warmUntil;
  $('warmup').hidden = !warming;
  if (warming) {
    for (let k = 0; k < WARMUP_STEPS_PER_FRAME && sim.time < warmUntil; k++) sim.step(FIXED_DT);
  } else if (!paused) {
    acc += realDt * Number(speedSel.value);
    let steps = 0;
    while (acc >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      view.addTrips(sim.step(FIXED_DT), now);
      acc -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) acc = 0; // fell behind; drop time rather than spiral
  }
  view.render(now);
  if (now - lastSidebar > SIDEBAR_MS) {
    lastSidebar = now;
    updateSidebar();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
