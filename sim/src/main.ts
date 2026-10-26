import { Simulation, FIXED_DT, DEFAULT_CONFIG, type Incident, type IncidentKind } from './sim';
import { View3D, INCIDENT_HEX } from './render3d/view3d';
import { OdHeatmap } from './render3d/odHeatmap';
import { DISTRICTS } from './demand/districts';
import { formatClock, periodAt, HOUR, type Period } from './core/time';
import type { ZoneType } from './demand/zones';
import { VEHICLE_KINDS, VEHICLE_SPECS, type VehicleKind } from './traffic/vehicleTypes';

// ?start=7.75 opens at 07:45 with the previous 30 sim minutes already run,
// so the roads are loaded instead of empty (useful for demos).
const WARMUP_H = 0.5;
const startParam = new URLSearchParams(location.search).get('start');
const startHour = startParam !== null && Number(startParam) >= WARMUP_H && Number(startParam) < 24 ? Number(startParam) : null;
// ?demand=1.2 scales peak demand, for stress tests past the stable setting.
const demandParam = Number(new URLSearchParams(location.search).get('demand'));
const demand = demandParam > 0 && demandParam <= 3 ? demandParam : 1;
const sim = new Simulation({
  ...DEFAULT_CONFIG,
  startHour: startHour !== null ? startHour - WARMUP_H : DEFAULT_CONFIG.startHour,
  peakTripsPerHour: DEFAULT_CONFIG.peakTripsPerHour * demand,
});
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
const probeBtn = $('probe') as HTMLButtonElement;
const jamBtn = $('jam') as HTMLButtonElement;
const incidentBtn = $('incident') as HTMLButtonElement;
const incidentKind = $('incidentKind') as HTMLSelectElement;
let paused = false;
let peakCars = 0;
pauseBtn.onclick = () => {
  paused = !paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
};
arcsBtn.onclick = () => {
  view.showDesireLines = !view.showDesireLines;
  arcsBtn.setAttribute('aria-pressed', String(view.showDesireLines));
};
// Probe trip: click Probe trip, then click a start and a destination on the map (Enter uses
// the default cross-town pair). The camera follows the probe car until it arrives.
const DEFAULT_PROBE: [number, number] = [sim.probeFrom, sim.probeTo];
let probeMode: 'idle' | 'start' | 'end' = 'idle';
let probeStart = -1;
let hintTimer = 0;
const mapEl = $('three-container');
function setPickHint(text: string | null, clearAfterMs = 0): void {
  const el = $('pickHint');
  el.hidden = text === null;
  if (text !== null) el.textContent = text;
  clearTimeout(hintTimer);
  if (text !== null && clearAfterMs > 0) hintTimer = window.setTimeout(() => setPickHint(null), clearAfterMs);
}
function endPicking(): void {
  probeMode = 'idle';
  probeBtn.textContent = 'Probe trip';
  probeBtn.removeAttribute('aria-pressed');
  mapEl.style.cursor = '';
}
function launchProbe(from: number, to: number): void {
  endPicking();
  const d = sim.spawnProbeTrip(from, to);
  view.setProbePins(from, to);
  view.follow(d.tripId);
  $('routeLog').textContent = `PROBE trip #${d.tripId} assigned at ${formatClock(sim.time)}. Watch its route and costs.`;
  setPickHint('Following the probe car · drag to look around · Esc to stop following');
  updateSidebar();
}
view.onFollowEnd = () => {
  view.setProbePins(null, null);
  setPickHint('Probe car arrived', 3000);
};
probeBtn.onclick = () => {
  endPlacing();
  if (probeMode !== 'idle') {
    endPicking();
    view.setProbePins(null, null);
    setPickHint(null);
    return;
  }
  view.follow(null);
  view.setProbePins(null, null);
  probeMode = 'start';
  probeBtn.textContent = 'Cancel probe';
  probeBtn.setAttribute('aria-pressed', 'true');
  mapEl.style.cursor = 'crosshair';
  setPickHint('Click a start point on the map · Enter for the default route · Esc to cancel');
};
// A click (not an orbit drag) picks the nearest intersection.
let downAt: [number, number] | null = null;
mapEl.addEventListener('pointerdown', (e) => {
  downAt = e.button === 0 ? [e.clientX, e.clientY] : null;
});
mapEl.addEventListener('pointerup', (e) => {
  if (!downAt || (probeMode === 'idle' && placing === null)) return;
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved > 5) return;
  if (placing !== null) {
    const link = view.pickLink(e.clientX, e.clientY);
    if (link === null) {
      setPickHint('No street there · click on a road · Esc to cancel');
      return;
    }
    const inc = sim.addIncident(placing, link);
    endPlacing();
    setPickHint(`${INCIDENT_LABEL[inc.kind]} placed · ${inc.rerouted} cars and waiting trips rerouted`, 4000);
    updateSidebar();
    return;
  }
  const node = view.pickNode(e.clientX, e.clientY);
  if (node === null) return;
  if (probeMode === 'start') {
    probeStart = node;
    view.setProbePins(node, null);
    probeMode = 'end';
    setPickHint('Now click the destination · Esc to cancel');
  } else if (node !== probeStart) {
    launchProbe(probeStart, node);
  }
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (placing !== null) {
      endPlacing();
    } else if (probeMode !== 'idle') {
      endPicking();
      view.setProbePins(null, null);
    } else if (view.following) {
      view.follow(null);
    }
    setPickHint(null);
  } else if (e.key === 'Enter' && probeMode !== 'idle') {
    launchProbe(...DEFAULT_PROBE);
  }
});
jamBtn.onclick = () => {
  const active = sim.toggleProbeJam();
  jamBtn.textContent = active ? 'Remove short-route jam' : 'Jam short route';
  $('routeMechanism').textContent = active
    ? 'Controlled jam active on the shortest route between the last probe start and destination. Send a probe trip between them to test it.'
    : 'Controlled jam removed. New trips use observed traffic only.';
};
$('reset').onclick = () => location.reload();

// Incidents: pick a kind, click Place incident, then click a street. Placed incidents are
// listed in the sidebar, where each can be removed.
const INCIDENT_LABEL: Record<IncidentKind, string> = { accident: 'Accident', lane: 'Lane closure', closure: 'Road closure' };
let placing: IncidentKind | null = null;
function endPlacing(): void {
  if (placing === null) return;
  placing = null;
  incidentBtn.textContent = 'Place incident';
  incidentBtn.removeAttribute('aria-pressed');
  mapEl.style.cursor = '';
}
incidentBtn.onclick = () => {
  if (placing !== null) {
    endPlacing();
    setPickHint(null);
    return;
  }
  if (probeMode !== 'idle') {
    endPicking();
    view.setProbePins(null, null);
  }
  placing = incidentKind.value as IncidentKind;
  incidentBtn.textContent = 'Cancel';
  incidentBtn.setAttribute('aria-pressed', 'true');
  mapEl.style.cursor = 'crosshair';
  setPickHint(`Click a street to place: ${INCIDENT_LABEL[placing].toLowerCase()} · Esc to cancel`);
};
const hexCss = (hex: number) => `#${hex.toString(16).padStart(6, '0')}`;
function incidentPlace(inc: Incident): string {
  const { net, opts } = sim.grid;
  const link = net.links[inc.links[0]];
  // District of the street's first junction (junction rows and columns, like the blocks).
  const band = (k: number, n: number) => (k < opts.suburbRing ? 0 : k > n - 1 - opts.suburbRing ? 2 : 1);
  const d = band(Math.floor(link.from / opts.cols), opts.rows) * 3 + band(link.from % opts.cols, opts.cols);
  return `${link.arterial ? 'arterial' : 'local street'} · ${DISTRICTS[d]}`;
}
// Rows are kept per incident and only their text changes, so the remove buttons stay clickable.
const incidentRows = new Map<number, { li: HTMLLIElement; detail: HTMLSpanElement }>();
// Clicking a row flies the camera to the incident; its × button removes it.
$('incidents').addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const remove = target.closest('button')?.dataset.id;
  if (remove !== undefined) {
    sim.removeIncident(Number(remove));
    updateSidebar();
    return;
  }
  const row = target.closest('li')?.dataset.id;
  const inc = sim.incidents.find((i) => String(i.id) === row);
  if (inc) view.focusIncident(inc);
});
function syncIncidentList(): void {
  const list = $('incidents');
  const live = new Set(sim.incidents.map((i) => i.id));
  for (const [id, row] of incidentRows) {
    if (live.has(id)) continue;
    row.li.remove();
    incidentRows.delete(id);
  }
  for (const inc of sim.incidents) {
    let row = incidentRows.get(inc.id);
    if (!row) {
      const li = document.createElement('li');
      li.className = 'incident';
      li.dataset.id = String(inc.id);
      li.title = 'Show on the map';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = hexCss(INCIDENT_HEX[inc.kind]);
      const text = document.createElement('div');
      text.className = 'name';
      const title = document.createElement('strong');
      title.textContent = `${INCIDENT_LABEL[inc.kind]} · ${incidentPlace(inc)}`;
      const detail = document.createElement('span');
      text.append(title, detail);
      const remove = document.createElement('button');
      remove.className = 'remove';
      remove.dataset.id = String(inc.id);
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${INCIDENT_LABEL[inc.kind].toLowerCase()}`);
      li.append(dot, text, remove);
      list.append(li);
      row = { li, detail };
      incidentRows.set(inc.id, row);
    }
    const left = inc.until === null ? 'until removed' : `clears in ${Math.max(1, Math.ceil((inc.until - sim.time) / 60))} min`;
    row.detail.textContent = `${left} · ${inc.rerouted} rerouted`;
  }
  $('incidentsEmpty').hidden = sim.incidents.length > 0;
}

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
  peakCars = Math.max(peakCars, traffic.vehicles.size);
  $('arrived').textContent = traffic.arrived.toLocaleString();
  $('meanTrip').textContent = traffic.arrived > 0 ? `${Math.round(traffic.meanTravelTime)} s` : '—';
  $('backlog').textContent = traffic.waitingToDepart.toLocaleString();
  $('gridlock').textContent = `Removed by gridlock guard (stopped > 3 min): ${traffic.removedGridlock}`;

  const invariantErrors = traffic.checkInvariants();
  $('mvpDemand').className = `proof-item done`;
  $('mvpTraffic').className = `proof-item ${peakCars >= 300 ? 'done' : 'active'}`;
  $('mvpSafety').className = `proof-item ${invariantErrors.length === 0 && traffic.removedGridlock === 0 ? 'done' : 'active'}`;
  $('mvpRouting').className = `proof-item ${sim.proofRoute ? 'done' : 'active'}`;
  $('mvpDemandDetail').textContent = `${sim.totalTrips.toLocaleString()} trips · ${PERIOD_LABEL[period]}`;
  $('mvpTrafficDetail').textContent = `peak ${peakCars} cars · target a few hundred`;
  $('mvpSafetyDetail').textContent = invariantErrors.length === 0 ? 'no overlaps / no gridlock' : `${invariantErrors.length} invariant warning(s)`;
  $('mvpRoutingDetail').textContent = sim.proofRoute ? 'longer route is faster · proof retained' : 'collecting a longer-but-faster example';

  const latestRoute = sim.proofRoute ?? sim.probeDecision ?? sim.routeLog[0];
  if (latestRoute) {
    const selected = latestRoute.chosen;
    const shorter = latestRoute.shorter;
    $('routeChosen').textContent = `${selected.cost.toFixed(1)} s`;
    $('routeBaseline').textContent = `${latestRoute.shorterLiveCost.toFixed(1)} s`;
    $('routeDelta').textContent = `${selected.links.length} links / ${latestRoute.chosenDistance.toFixed(0)} m vs ${shorter.links.length} links / ${latestRoute.shorterDistance.toFixed(0)} m`;
    $('routeLog').textContent = sim.proofRoute
      ? `PROOF trip #${latestRoute.tripId}: longer route is ${(latestRoute.shorterLiveCost - selected.cost).toFixed(1)} s faster`
      : latestRoute.kind === 'probe'
        ? `PROBE trip #${latestRoute.tripId}: assigned at departure; compare this result after jamming`
        : `Monitoring trip #${latestRoute.tripId}: waiting for a longer-but-faster example`;
    $('routeMechanism').textContent = sim.proofRoute
      ? 'New trips compare live link speeds at departure. Existing trips keep their assigned route; the proof route stays highlighted for the demo.'
      : 'New trips compare live link speeds at departure. Keep the simulation running at 60x until a longer-but-faster proof is found.';
  }

  heatmap.update(period);
  syncIncidentList();
  if (period !== shownPeriod) {
    shownPeriod = period;
    $('periodStat').textContent = PERIOD_LABEL[period];
    $('odPeriod').textContent = PERIOD_LABEL[period];
    $('topPairs').replaceChildren(
      ...heatmap
        .topPairs(5)
        .map((p) => listItem('#6fa8f0', `${DISTRICTS[p.o]} → ${DISTRICTS[p.d]}`, `${(p.share * 100).toFixed(1)}%`)),
    );
  }

  const onRoad = new Map<VehicleKind, number>();
  for (const v of traffic.vehicles) {
    const kind = v.trip.kind ?? 'sedan';
    onRoad.set(kind, (onRoad.get(kind) ?? 0) + 1);
  }
  $('vehicleTypes').replaceChildren(
    ...VEHICLE_KINDS.map((k) =>
      listItem('var(--text-dim)', `${k} · ${VEHICLE_SPECS[k].length} m`, (onRoad.get(k) ?? 0).toLocaleString()),
    ),
  );

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

// Performance readout (top right of the map), smoothed over ~1 s.
const perf = { fps: 60, simMs: 0, drawMs: 0 };
const smooth = (prev: number, next: number) => prev + 0.05 * (next - prev);

function frame(now: number): void {
  const realDt = Math.max(0, Math.min(0.1, (now - last) / 1000)); // rAF time can precede setup time
  if (now > last) perf.fps = smooth(perf.fps, 1000 / (now - last));
  last = now;
  const simStart = performance.now();
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
  const drawStart = performance.now();
  perf.simMs = smooth(perf.simMs, drawStart - simStart);
  view.render(now);
  perf.drawMs = smooth(perf.drawMs, performance.now() - drawStart);
  if (now - lastSidebar > SIDEBAR_MS) {
    lastSidebar = now;
    updateSidebar();
    $('perf').textContent =
      `${perf.fps.toFixed(0)} fps · sim ${perf.simMs.toFixed(1)} ms · draw ${perf.drawMs.toFixed(1)} ms · ` +
      `${view.renderer.info.render.calls} draw calls · ${sim.traffic.vehicles.size} cars`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
