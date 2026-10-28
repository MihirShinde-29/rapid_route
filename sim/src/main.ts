import { Simulation, FIXED_DT, DEFAULT_CONFIG, BLOCK_JUNCTION_M, type Incident, type IncidentKind } from './sim';
import { View3D, INCIDENT_HEX } from './render3d/view3d';
import { OdHeatmap } from './render3d/odHeatmap';
import { DISTRICTS } from './demand/districts';
import { formatClock, periodAt, HOUR, type Period } from './core/time';
import type { ZoneType } from './demand/zones';
import { VEHICLE_KINDS, VEHICLE_SPECS, type EmergencyKind, type VehicleKind } from './traffic/vehicleTypes';
import { DispatchCenter, type DispatchMode } from './dispatch/dispatch';
import { SirenAudio } from './render3d/sirenAudio';
import type { Vehicle } from './traffic/traffic';

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
const modeParam = new URLSearchParams(location.search).get('mode');
const initialDispatchMode: DispatchMode = modeParam === 'sandbox' ? 'sandbox' : 'dispatcher';
let dispatch: DispatchCenter | null = null;
const pageParams = new URLSearchParams(location.search);
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
const dispatchModeSelect = $('dispatchMode') as HTMLSelectElement;
dispatchModeSelect.value = initialDispatchMode;
const shiftSelect = $('dispatchShift') as HTMLSelectElement;
const difficultySelect = $('dispatchDifficulty') as HTMLSelectElement;
if (['am', 'midday', 'pm', 'night'].includes(pageParams.get('shift') ?? '')) shiftSelect.value = pageParams.get('shift')!;
if (['easy', 'normal', 'hard'].includes(pageParams.get('difficulty') ?? '')) difficultySelect.value = pageParams.get('difficulty')!;
let selectedCallId: number | null = null;
let selectedUnitId: number | null = null;
const endDispatchBtn = $('endDispatch') as HTMLButtonElement;
let paused = true;
let peakCars = 0;
pauseBtn.disabled = true;
const startDispatchBtn = $('startDispatch') as HTMLButtonElement;
startDispatchBtn.onclick = () => {
  const shifts: Record<string, { start: number; duration: number }> = {
    am: { start: 6, duration: 4 },
    midday: { start: 10, duration: 5 },
    pm: { start: 15, duration: 4 },
    night: { start: 22, duration: 8 },
  };
  const difficulties: Record<string, { callsPerHour: number; missedLimit: number }> = {
    easy: { callsPerHour: 12, missedLimit: 5 },
    normal: { callsPerHour: 20, missedLimit: 3 },
    hard: { callsPerHour: 30, missedLimit: 2 },
  };
  const shift = shifts[shiftSelect.value];
  const difficulty = difficulties[difficultySelect.value];
  const modeValue = dispatchModeSelect.value;
  if (!shift || !difficulty || (modeValue !== 'dispatcher' && modeValue !== 'sandbox')) {
    throw new RangeError('Invalid dispatch setup');
  }
  sim.time = shift.start * HOUR;
  dispatch = new DispatchCenter(sim, {
    mode: modeValue,
    shiftDurationSeconds: shift.duration * HOUR,
    ...difficulty,
  });
  pageParams.set('mode', dispatchModeSelect.value);
  pageParams.set('shift', shiftSelect.value);
  pageParams.set('difficulty', difficultySelect.value);
  pageParams.delete('replay');
  history.replaceState(null, '', `${location.pathname}?${pageParams.toString()}`);
  selectedCallId = null;
  selectedUnitId = null;
  paused = false;
  pauseBtn.disabled = false;
  pauseBtn.textContent = 'Pause';
  $('dispatchMenu').hidden = true;
  $('dispatchActive').hidden = false;
  syncDispatchPanel();
  updateSidebar();
};
endDispatchBtn.onclick = () => dispatch?.end();
$('playAgain').addEventListener('click', () => {
  pageParams.set('replay', '1');
  location.search = pageParams.toString();
});
$('returnMenu').addEventListener('click', () => {
  pageParams.delete('replay');
  location.search = pageParams.toString();
});
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
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved > 5) return;
  if (probeMode === 'idle' && placing === null) {
    // A click on a unit rides along with it.
    const unit = view.pickVehicle(e.clientX, e.clientY, isUnit);
    if (unit) rideAlong(unit.trip.id);
    return;
  }
  if (placing !== null) {
    let inc: Incident;
    if (placing === 'closure') {
      const link = view.pickLink(e.clientX, e.clientY);
      if (link === null) {
        setPickHint('No street there · click on a road · Esc to cancel');
        return;
      }
      inc = sim.addIncident('closure', link);
    } else {
      // An accident goes where it is clicked, on the nearest lane. A lane closure takes two clicks
      // along one lane: where it starts, then where it ends.
      const hit = view.pickLane(e.clientX, e.clientY, laneStart?.link);
      if (hit === null) {
        setPickHint('No lane there · click on a road · Esc to cancel');
        return;
      }
      if (placing === 'lane' && laneStart === null) {
        laneStart = hit;
        view.setLanePreview(hit.link, ...previewStretch(hit.link, hit.pos, hit.pos));
        setPickHint('Now click where the closure ends, along the same lane · Esc to cancel');
        return;
      }
      inc = placing === 'lane' ? sim.addIncident('lane', hit.link, laneStart!.pos, hit.pos) : sim.addIncident('accident', hit.link, hit.pos);
    }
    if (inc.kind === 'accident' && dispatch && dispatch.ended === null) {
      const { x, y } = sim.incidentPoint(inc);
      const site = sim.sites.reduce((nearest, candidate) =>
        Math.hypot(candidate.door.x - x, candidate.door.y - y) <
        Math.hypot(nearest.door.x - x, nearest.door.y - y) ? candidate : nearest,
      );
      dispatch.createCall('crash', site);
    }
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
  sirens.unlock();
  // Leave keys alone while a form control has focus (Space and Enter press buttons there).
  const inControl = e.target instanceof Element && e.target.closest('button, select, input, textarea') !== null;
  const help = $('helpOverlay');
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    help.hidden = !help.hidden;
    e.preventDefault();
    return;
  }
  if (!help.hidden && e.key === 'Escape') {
    help.hidden = true;
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!inControl && e.key === ' ') {
    if (!pauseBtn.disabled) pauseBtn.click();
    e.preventDefault();
    return;
  }
  if (!inControl && /^[1-5]$/.test(e.key)) {
    speedSel.selectedIndex = Number(e.key) - 1;
    return;
  }
  if (e.key === 'Tab' && dispatch && dispatch.ended === null && !inControl) {
    // Next waiting call, oldest first, wrapping round.
    const waiting = dispatch.calls.filter((call) => call.state === 'created');
    if (waiting.length > 0) {
      const k = waiting.findIndex((call) => call.id === selectedCallId);
      selectedCallId = waiting[(k + 1) % waiting.length].id;
      selectedUnitId = null;
      syncDispatchPanel();
    }
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter' && probeMode === 'idle' && !inControl && dispatch && dispatch.ended === null && selectedCallId !== null) {
    const unitId = selectedUnitId ?? dispatch.candidates(selectedCallId)[0]?.unitId;
    if (unitId !== undefined && dispatch.assign(selectedCallId, unitId)) lastSent = unitId;
    selectedCallId = null;
    selectedUnitId = null;
    syncDispatchPanel();
    return;
  }
  const key = e.key.toLowerCase();
  if (!inControl && key === 'f') {
    const unit = dispatch?.units[selectedUnitId ?? lastSent ?? -1];
    if (unit?.tripId != null && sim.traffic.vehicleOf(unit.tripId)) rideAlong(unit.tripId);
    else setPickHint('No unit on the road to ride along with · pick one in a call, or click one on the map', 3000);
    return;
  }
  if (!inControl && key === 'c') {
    coverageBtn.click();
    return;
  }
  if (!inControl && key === 'b') {
    boidsBtn.click();
    return;
  }
  if (!inControl && key === 'm') {
    muteBtn.click();
    return;
  }
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

// Ride along: the chase camera follows a unit until it arrives (Esc stops).
const isUnit = (v: Vehicle) => v.trip.kind === 'ambulance' || v.trip.kind === 'fire' || v.trip.kind === 'police';
let lastSent: number | null = null; // the unit most recently sent from the keyboard
function rideAlong(tripId: number): void {
  endPicking();
  endPlacing();
  view.setProbePins(null, null);
  const unit = dispatch?.units.find((u) => u.tripId === tripId);
  const veh = sim.traffic.vehicleOf(tripId);
  const kind = unit?.kind ?? veh?.trip.kind ?? 'unit';
  const name = unit ? `${kind.toUpperCase()} ${unit.id + 1}` : kind.toUpperCase();
  view.follow(tripId, name);
  setPickHint(`Riding along with ${name} · drag to look around · Esc to stop`, 4000);
}
view.onFollowEnd = () => {
  view.setProbePins(null, null);
  setPickHint('Arrived', 3000);
};
// Clicking a driving unit in the unit list rides along with it.
$('dispatchUnits').addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest('li')?.dataset.unit;
  const unit = id === undefined ? undefined : dispatch?.units[Number(id)];
  if (unit?.tripId != null && sim.traffic.vehicleOf(unit.tripId)) rideAlong(unit.tripId);
});

// Boids debug view (B).
const boidsBtn = $('boids') as HTMLButtonElement;
boidsBtn.onclick = () => {
  view.showBoids = !view.showBoids;
  boidsBtn.setAttribute('aria-pressed', String(view.showBoids));
};

// Coverage map (C): streets shaded by how fast the nearest free unit could get there on live
// traffic. Cycles through all units, then each kind, then off.
const coverageBtn = $('coverage') as HTMLButtonElement;
const COVERAGE_MODES: (EmergencyKind | 'all' | null)[] = [null, 'all', 'ambulance', 'fire', 'police'];
const COVERAGE_LABEL = { all: 'nearest free unit', ambulance: 'nearest free ambulance', fire: 'nearest free fire engine', police: 'nearest free police car' };
const STATION_KIND: Record<string, EmergencyKind> = { hospital: 'ambulance', fire_station: 'fire', police_station: 'police' };
let coverageMode: EmergencyKind | 'all' | null = null;
// Junctions where the free units are: idle at their stations (every station before a shift).
function coverageSources(kind: EmergencyKind | 'all'): number[] {
  const links = sim.grid.net.links;
  const nodes = new Set<number>();
  if (dispatch) {
    for (const u of dispatch.units) {
      if (u.state === 'idle' && (kind === 'all' || u.kind === kind)) nodes.add(links[u.location.entrance.link].to);
    }
  } else {
    for (const s of sim.sites) {
      const k = STATION_KIND[s.kind];
      if (k && (kind === 'all' || k === kind)) nodes.add(links[s.entrance.link].to);
    }
  }
  return [...nodes];
}
function syncCoverage(): void {
  $('coverageLegend').hidden = coverageMode === null;
  if (coverageMode === null) return;
  $('coverageTitle').textContent = `Coverage · ${COVERAGE_LABEL[coverageMode]}`;
  const sources = coverageSources(coverageMode);
  view.setCoverage(sources.length > 0 ? sim.coverageTimes(sources) : new Float64Array(sim.grid.net.nodes.length).fill(Infinity));
}
coverageBtn.onclick = () => {
  coverageMode = COVERAGE_MODES[(COVERAGE_MODES.indexOf(coverageMode) + 1) % COVERAGE_MODES.length];
  coverageBtn.setAttribute('aria-pressed', String(coverageMode !== null));
  if (coverageMode === null) view.setCoverage(null);
  syncCoverage();
};

// Siren sound (M mutes). Audio starts with the first click or key press, as browsers require.
const sirens = new SirenAudio();
const muteBtn = $('mute') as HTMLButtonElement;
muteBtn.onclick = () => {
  sirens.unlock();
  sirens.muted = !sirens.muted;
  muteBtn.setAttribute('aria-pressed', String(sirens.muted));
  muteBtn.textContent = sirens.muted ? 'Muted' : 'Sound on';
};
window.addEventListener('pointerdown', () => sirens.unlock());
$('help').onclick = () => {
  $('helpOverlay').hidden = false;
};
$('helpOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $('helpOverlay').hidden = true;
});

// Incidents: pick a kind, click Place incident, then click a street. Placed incidents are
// listed in the sidebar, where each can be removed.
const INCIDENT_LABEL: Record<IncidentKind, string> = { accident: 'Accident', lane: 'Lane closure', closure: 'Road closure' };
let placing: IncidentKind | null = null;
let laneStart: { link: number; pos: number } | null = null; // first click of a lane closure
// The stretch a lane closure from `a` to `b` would block, kept clear of the junctions as sim does.
function previewStretch(link: number, a: number, b: number): [number, number] {
  const len = sim.traffic.lanes[link].geom.length;
  const clamp = (x: number) => Math.min(len - BLOCK_JUNCTION_M, Math.max(BLOCK_JUNCTION_M, x));
  const lo = clamp(Math.min(a, b));
  return [lo, Math.max(clamp(Math.max(a, b)), Math.min(len - BLOCK_JUNCTION_M, lo + 12))];
}
mapEl.addEventListener('pointermove', (e) => {
  if (placing !== 'lane' || laneStart === null) return;
  const hit = view.pickLane(e.clientX, e.clientY, laneStart.link);
  if (hit) view.setLanePreview(laneStart.link, ...previewStretch(laneStart.link, laneStart.pos, hit.pos));
});
function endPlacing(): void {
  if (placing === null) return;
  placing = null;
  laneStart = null;
  view.setLanePreview(null);
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
  setPickHint(
    placing === 'lane'
      ? 'Click on a lane where the closure starts · Esc to cancel'
      : `Click ${placing === 'accident' ? 'on a lane' : 'a street'} to place: ${INCIDENT_LABEL[placing].toLowerCase()} · Esc to cancel`,
  );
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

function syncDispatchPanel(): void {
  if (!dispatch) return;
  const activeCalls = dispatch.calls.filter((call) => call.state !== 'resolved' && call.state !== 'missed');
  const finishedCalls = dispatch.calls.filter((call) => call.state === 'resolved' || call.state === 'missed').slice(-3);
  const visibleCalls = [...activeCalls, ...finishedCalls].reverse();
  const callsList = $('dispatchCalls');
  callsList.replaceChildren();
  for (const call of visibleCalls) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'dispatch-call';
    button.textContent = `${call.kind.toUpperCase()} · ${call.site.address} · ${call.state.replace('_', ' ')}`;
    button.setAttribute('aria-pressed', String(selectedCallId === call.id));
    button.disabled = call.state !== 'created';
    button.onclick = () => {
      selectedCallId = call.id;
      selectedUnitId = null;
      syncDispatchPanel();
    };
    li.append(button);
    callsList.append(li);
  }
  $('dispatchCallsEmpty').hidden = visibleCalls.length > 0;

  const selectedCall = dispatch.calls.find((call) => call.id === selectedCallId && call.state === 'created');
  const candidatesList = $('dispatchCandidates');
  candidatesList.replaceChildren();
  $('dispatchCallDetails').textContent = selectedCall
    ? `${selectedCall.kind.toUpperCase()} · ${selectedCall.site.address} · expires in ${Math.max(0, Math.ceil((selectedCall.expiresAt - sim.time) / 60))} min`
    : 'Select a waiting call to see its location and response deadline.';
  if (selectedCall) {
    for (const candidate of dispatch.candidates(selectedCall.id)) {
      const unit = dispatch.units[candidate.unitId];
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.className = 'dispatch-candidate';
      button.textContent = `${unit.kind.toUpperCase()} ${unit.id + 1} · ${Math.round(candidate.eta)} s`;
      button.setAttribute('aria-pressed', String(selectedUnitId === unit.id));
      button.onclick = () => {
        selectedUnitId = unit.id;
        syncDispatchPanel();
      };
      li.append(button);
      candidatesList.append(li);
    }
  }
  $('dispatchCandidatesEmpty').hidden = candidatesList.childElementCount > 0;
  const assignBtn = $('assignDispatch') as HTMLButtonElement;
  assignBtn.disabled = selectedCall === undefined || selectedUnitId === null;
  assignBtn.onclick = () => {
    if (selectedCall && selectedUnitId !== null && dispatch?.assign(selectedCall.id, selectedUnitId)) lastSent = selectedUnitId;
    selectedCallId = null;
    selectedUnitId = null;
    syncDispatchPanel();
  };

  $('dispatchScore').textContent = dispatch.score.points.toLocaleString();
  $('dispatchWaiting').textContent = dispatch.calls.filter((call) => call.state === 'created').length.toLocaleString();
  $('dispatchResolved').textContent = dispatch.score.resolvedCalls.toLocaleString();
  $('dispatchMissed').textContent = dispatch.score.missedCalls.toLocaleString();
  $('dispatchResponse').textContent = dispatch.score.resolvedCalls > 0
    ? `${Math.round(dispatch.score.meanResponseTime)} s`
    : '—';
  $('dispatchStatus').textContent = `${dispatch.mode === 'sandbox' ? 'Sandbox' : 'Dispatcher'} · shift ends ${formatClock(dispatch.shiftEndsAt)}`;
  const outcome = dispatch.ended;
  endDispatchBtn.hidden = outcome !== null;
  const isEnded = outcome !== null;
  pauseBtn.disabled = isEnded;
  $('dispatchActive').hidden = isEnded;
  $('dispatchResult').hidden = !isEnded;
  if (isEnded) {
    $('dispatchResultTitle').textContent = outcome === 'win' ? 'Shift complete' : outcome === 'loss' ? 'Shift failed' : 'Session ended';
    $('dispatchResultState').textContent = outcome.toUpperCase();
    $('resultResolved').textContent = dispatch.score.resolvedCalls.toLocaleString();
    $('resultMissed').textContent = dispatch.score.missedCalls.toLocaleString();
    $('resultResponse').textContent = dispatch.score.resolvedCalls > 0 ? `${Math.round(dispatch.score.meanResponseTime)} s` : '—';
    $('resultScore').textContent = dispatch.score.points.toLocaleString();
    paused = true;
    pauseBtn.textContent = 'Resume';
  }

  $('dispatchUnits').replaceChildren(
    ...dispatch.units.map((unit) => {
      const li = listItem('var(--accent)', `${unit.kind} ${unit.id + 1} · ${unit.state.replace('_', ' ')}`, unit.location.address);
      li.dataset.unit = String(unit.id);
      if (unit.tripId !== null && sim.traffic.vehicleOf(unit.tripId)) {
        li.classList.add('rideable');
        li.title = 'Ride along';
      }
      return li;
    }),
  );
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
  syncDispatchPanel();
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
  sirens.update(view.nearestSiren(), !paused && !warming);
  perf.drawMs = smooth(perf.drawMs, performance.now() - drawStart);
  if (now - lastSidebar > SIDEBAR_MS) {
    lastSidebar = now;
    updateSidebar();
    syncCoverage();
    $('perf').textContent =
      `${perf.fps.toFixed(0)} fps · sim ${perf.simMs.toFixed(1)} ms · draw ${perf.drawMs.toFixed(1)} ms · ` +
      `${view.renderer.info.render.calls} draw calls · ${sim.traffic.vehicles.size} cars`;
  }
  requestAnimationFrame(frame);
  if (pageParams.get('replay') === '1') startDispatchBtn.click();
}
requestAnimationFrame(frame);
