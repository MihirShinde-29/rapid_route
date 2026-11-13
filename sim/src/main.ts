import { Simulation, FIXED_DT, DEFAULT_CONFIG, BLOCK_JUNCTION_M, STATION_KINDS, type Incident, type IncidentKind } from './sim';
import type { Site } from './city/sites';
import { View3D, INCIDENT_HEX, BUS_LINE_HEX, type CallScene } from './render3d/view3d';
import { OdHeatmap } from './render3d/odHeatmap';
import { DISTRICTS } from './demand/districts';
import { formatClock, periodAt, HOUR, type Period } from './core/time';
import type { ZoneType } from './demand/zones';
import { VEHICLE_KINDS, VEHICLE_SPECS, type EmergencyKind, type VehicleKind } from './traffic/vehicleTypes';
import { DispatchCenter, sortCallsByPriority, type CallKind, type DispatchMode, type EmergencyCall } from './dispatch/dispatch';
import { responseChart, formatMinutes } from './ui/responseChart';
import { SirenAudio } from './render3d/sirenAudio';
import { callIcon } from './ui/icons';
import { Tutorial } from './ui/tutorial';
import type { Vehicle, Weather } from './traffic/traffic';

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
let selectedEmergencyUnitId: number | null = null;
let followingEmergency = false;
const endDispatchBtn = $('endDispatch') as HTMLButtonElement;
let paused = true;
let peakCars = 0;
pauseBtn.disabled = true;
const startDispatchBtn = $('startDispatch') as HTMLButtonElement;
startDispatchBtn.onclick = () => {
  const shifts: Record<string, { start: number; duration: number }> = {
    am: { start: 7, duration: 2 },
    midday: { start: 11, duration: 2 },
    pm: { start: 16.5, duration: 2 },
    night: { start: 23, duration: 2 },
  };
  // Random accidents are per sim hour at peak demand, fewer when the roads are quiet.
  const difficulties: Record<string, { callsPerHour: number; missedLimit: number; unitCounts?: Partial<Record<EmergencyKind, number>>; accidentsPerHour: number }> = {
    easy: { callsPerHour: 12, missedLimit: 4, unitCounts: { ambulance: 3 }, accidentsPerHour: 0.7 },
    normal: { callsPerHour: 20, missedLimit: 3, accidentsPerHour: 1 },
    hard: { callsPerHour: 30, missedLimit: 2, unitCounts: { police: 1 }, accidentsPerHour: 1.5 },
  };
  const shift = shifts[shiftSelect.value];
  const difficulty = difficulties[difficultySelect.value];
  const modeValue = dispatchModeSelect.value;
  if (!shift || !difficulty || (modeValue !== 'dispatcher' && modeValue !== 'sandbox')) {
    throw new RangeError('Invalid dispatch setup');
  }
  endMoving();
  if (stationMove) pageParams.set('move', `${stationMove.from.id}.${stationMove.to.id}`);
  else pageParams.delete('move');
  // The shift starts at its own time of day with traffic already on the roads: unless the city is
  // there already, reload at that hour (half an hour of traffic is run first) and start again.
  if (pageParams.get('start') !== String(shift.start) || Math.abs(sim.time - shift.start * HOUR) > 15 * 60) {
    pageParams.set('mode', modeValue);
    pageParams.set('shift', shiftSelect.value);
    pageParams.set('difficulty', difficultySelect.value);
    pageParams.set('start', String(shift.start));
    pageParams.set('replay', '1');
    location.search = pageParams.toString();
    return;
  }
  playedKey = bestKey();
  resultShown = false;
  sirenTrips.clear();
  lastSirenTrip.clear();
  dispatch = new DispatchCenter(sim, {
    mode: modeValue,
    shiftDurationSeconds: modeValue === 'sandbox' ? Infinity : shift.duration * HOUR, // sandbox runs until the menu
    ...difficulty,
  });
  pageParams.set('mode', dispatchModeSelect.value);
  pageParams.set('shift', shiftSelect.value);
  pageParams.set('difficulty', difficultySelect.value);
  pageParams.delete('replay');
  history.replaceState(null, '', `${location.pathname}?${pageParams.toString()}`);
  selectedCallId = null;
  selectedUnitId = null;
  selectedEmergencyUnitId = null;
  paused = false;
  pauseBtn.disabled = false;
  pauseBtn.textContent = 'Pause';
  speedSel.value = '5'; // 5x by default in both modes (a 2-hour shift takes 24 real minutes); 1-5 keys change it
  endDispatchBtn.textContent = modeValue === 'sandbox' ? 'End session' : 'End shift';
  $('dispatchMenu').hidden = true;
  $('dispatchActive').hidden = modeValue === 'sandbox';
  if (modeValue === 'sandbox') showSandbox();
  else tutorial.start();
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
  followingEmergency = false;
  selectedEmergencyUnitId = null;
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
  followingEmergency = false;
  selectedEmergencyUnitId = null;
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
  if (moving !== 'off') {
    pickForMove(e.clientX, e.clientY);
    return;
  }
  if (placingCall !== null) {
    const site = view.pickSite(e.clientX, e.clientY, () => true);
    if (!site || !dispatch || dispatch.ended !== null) {
      setPickHint('No address there · click a building, park or car park · Esc to cancel');
      return;
    }
    const kind = placingCall;
    const call = dispatch.createCall(kind, site);
    endPlacing();
    setPickHint(`${CALL_LABEL[kind]} call placed at ${site.address}${dispatch.mode === 'sandbox' ? ' · the nearest free unit is on its way' : ''}`, 4000);
    if (dispatch.mode === 'dispatcher') selectCall(call.id, false);
    return;
  }
  if (probeMode === 'idle' && placing === null) {
    // A click on a unit rides along with it.
    const unit = view.pickVehicle(e.clientX, e.clientY, isUnit);
    if (unit) rideAlong(unit.trip.id);
    // With the bus lines shown, a click on a bus follows it.
    const bus = unit || !view.showBusLines ? null : view.pickVehicle(e.clientX, e.clientY, (v) => v.trip.kind === 'bus');
    if (bus) followBus(bus.trip.id);
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
      dispatch.createCrashCall(inc);
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
  if (e.key === 'Tab' && dispatch?.mode === 'dispatcher' && dispatch.ended === null && !inControl) {
    // Next waiting call in the list's order (critical first, then soonest to expire), wrapping round.
    const waiting = sortCallsByPriority(dispatch.calls.filter(needsUnitAssignment), sim.time);
    if (waiting.length > 0) {
      const k = waiting.findIndex((call) => call.id === selectedCallId);
      selectedCallId = waiting[(k + 1) % waiting.length].id;
      selectedUnitId = null;
      syncDispatchPanel();
    }
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter' && probeMode === 'idle' && !inControl && dispatch?.mode === 'dispatcher' && dispatch.ended === null && selectedCallId !== null) {
    const unitId = selectedUnitId ?? dispatch.candidates(selectedCallId)[0]?.unitId;
    if (unitId !== undefined && dispatch.assign(selectedCallId, unitId)) {
      lastSent = unitId;
      selectedEmergencyUnitId = unitId;
    }
    selectedCallId = nextWaitingCall();
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
  if (!inControl && key === 'l') {
    busLinesBtn.click();
    return;
  }
  if (!inControl && key === 'w') {
    weatherSel.selectedIndex = (weatherSel.selectedIndex + 1) % weatherSel.options.length;
    weatherSel.dispatchEvent(new Event('change'));
    return;
  }
  if (!inControl && key === 'm') {
    muteBtn.click();
    return;
  }
  if (!inControl && key === 'g') {
    graphicsBtn.click();
    return;
  }
  if (e.key === 'Escape' && moving !== 'off') {
    endMoving();
    setPickHint(null);
    return;
  }
  if (e.key === 'Escape' && dispatch?.ended != null && !$('dispatchResult').hidden) {
    $('returnMenu').click();
    return;
  }
  if (e.key === 'Escape') {
    if (placing !== null || placingCall !== null) {
      endPlacing();
    } else if (probeMode !== 'idle') {
      endPicking();
      view.setProbePins(null, null);
    } else if (view.following) {
      view.follow(null);
      followingEmergency = false;
      selectedEmergencyUnitId = null;
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
// Call scenes on the map: units on scene parked with their lights going, fires burning until
// they are put out, police tape at crime scenes.
function syncScenes(): void {
  const scenes: CallScene[] = [];
  for (const call of dispatch?.calls ?? []) {
    const open = call.state === 'created' || call.state === 'assigned' || call.state === 'en_route';
    const units = dispatch!.units.filter((u) => u.state === 'on_scene' && u.callId === call.id).map((u) => u.kind);
    const burning = call.kind === 'fire' && open;
    if (units.length === 0 && !burning) continue;
    scenes.push({ id: call.id, kind: call.kind, site: call.site, units, burning });
  }
  view.setScenes(scenes);
}

// First-shift tutorial: a card over the map that moves on as the player does each step.
const tutorial = new Tutorial($('three-container').parentElement!);
$('replayTutorial').onclick = () => {
  try {
    localStorage.removeItem('dispatch.tutorialDone');
  } catch {
    // storage blocked: it shows every shift anyway
  }
  setPickHint('The tutorial will show on your next dispatcher shift', 3000);
};
function updateTutorial(): void {
  if (!tutorial.active || !dispatch || dispatch.mode !== 'dispatcher') return;
  if (dispatch.ended !== null) {
    tutorial.finish();
    return;
  }
  tutorial.update({
    calls: dispatch.calls.length,
    selected: selectedCallId !== null,
    sent: dispatch.units.some((u) => u.state === 'en_route'),
    following: view.following,
  });
}

// Siren trips this shift, for the yielding stats in the unit list and on the end screen.
const sirenTrips = new Set<number>();
const lastSirenTrip = new Map<number, number>(); // unit id -> its latest siren trip
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
  if (unit) {
    selectedEmergencyUnitId = unit.id;
    followingEmergency = unit.state === 'en_route';
    view.setEmergencyRoute(dispatch?.unitTravel(unit.id)?.route ?? null);
    lastSent = unit.id;
  } else {
    followingEmergency = false;
    selectedEmergencyUnitId = null;
    view.setEmergencyRoute(null);
  }
  view.follow(tripId, name);
  setPickHint(`Riding along with ${name} · drag to look around · Esc to stop`, 4000);
}
view.onFollowEnd = (tripId) => {
  view.setProbePins(null, null);
  if (followingEmergency) {
    followingEmergency = false;
    selectedEmergencyUnitId = null;
    setPickHint('Emergency unit arrived at the call', 3000);
  } else {
    setPickHint(tripId === sim.probeDecision?.tripId ? 'Probe car arrived' : 'Arrived', 3000);
  }
};
// Clicking a driving unit in the unit list rides along with it.
$('dispatchUnits').addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('button')) return;
  const id = (e.target as HTMLElement).closest('li')?.dataset.unit;
  const unit = id === undefined ? undefined : dispatch?.units[Number(id)];
  if (unit?.tripId != null && sim.traffic.vehicleOf(unit.tripId)) rideAlong(unit.tripId);
});

// Bus lines (L): each line's route and stops on the map, a pin over every bus, and a list of
// the buses on the road with a button to follow one.
const busLinesBtn = $('busLines') as HTMLButtonElement;
const busPanel = $('busPanel');
const busList = $('busList');
busLinesBtn.onclick = () => {
  view.showBusLines = !view.showBusLines;
  busLinesBtn.setAttribute('aria-pressed', String(view.showBusLines));
  busPanel.hidden = !view.showBusLines;
  renderBusList();
};
function busName(tripId: number): string {
  const veh = sim.traffic.vehicleOf(tripId);
  const at = veh ? sim.busLineOf(veh.trip) : null;
  return at ? `BUS · LINE ${at.line + 1}` : 'BUS';
}
function followBus(tripId: number): void {
  endPicking();
  endPlacing();
  followingEmergency = false;
  selectedEmergencyUnitId = null;
  view.setEmergencyRoute(null);
  view.follow(tripId, busName(tripId));
  setPickHint(`Following the ${busName(tripId).toLowerCase().replace(' · ', ' on ')} · drag to look around · Esc to stop`, 4000);
  renderBusList();
}
// Which way a route runs, as a compass heading (the map has north up, y down).
function heading(route: number[]): string {
  const net = sim.grid.net;
  const a = net.nodes[net.links[route[0]].from];
  const b = net.nodes[net.links[route[route.length - 1]].to];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'eastbound' : 'westbound') : dy > 0 ? 'southbound' : 'northbound';
}
function renderBusList(): void {
  if (busPanel.hidden) return;
  const buses = [...sim.traffic.vehicles].filter((v) => v.trip.kind === 'bus');
  const followed = view.followedTrip;
  busList.replaceChildren();
  sim.busLines.forEach((line, k) => {
    const head = document.createElement('div');
    head.className = 'line';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = `#${BUS_LINE_HEX[k % BUS_LINE_HEX.length].toString(16).padStart(6, '0')}`;
    const onLine = buses.filter((v) => sim.busLineOf(v.trip)?.line === k);
    head.append(sw, `Line ${k + 1} · ${heading(line.routes[0]).replace('bound', '')}–${heading(line.routes[1]).replace('bound', '')} · ${onLine.length} bus${onLine.length === 1 ? '' : 'es'}`);
    busList.append(head);
    if (onLine.length === 0) {
      const none = document.createElement('div');
      none.className = 'none';
      none.textContent = 'none on the road (buses run 06:00–22:00)';
      busList.append(none);
    }
    for (const v of onLine) {
      const at = sim.busLineOf(v.trip)!;
      const stops = line.stops[at.dir].length;
      const row = document.createElement('div');
      row.className = 'bus' + (followed === v.trip.id ? ' following' : '');
      const state = v.dwellUntil >= 0 ? 'at a stop' : v.v < 0.5 ? 'waiting' : `${Math.round(v.v * 3.6)} km/h`;
      const text = document.createElement('span');
      text.textContent = `${heading(line.routes[at.dir])} · stop ${Math.min(v.stopAt + 1, stops)}/${stops} · ${state}`;
      const btn = document.createElement('button');
      btn.textContent = followed === v.trip.id ? 'Following' : 'Follow';
      btn.disabled = followed === v.trip.id;
      btn.onclick = () => followBus(v.trip.id);
      row.append(text, btn);
      busList.append(row);
    }
  });
}
setInterval(renderBusList, 1000);

// Weather (W): kept in the page address so a shift restart keeps it.
const weatherSel = $('weather') as HTMLSelectElement;
function setWeather(w: Weather): void {
  sim.weather = w;
  view.setWeather(w);
  weatherSel.value = w;
  if (w === 'clear') pageParams.delete('weather');
  else pageParams.set('weather', w);
  history.replaceState(null, '', `${location.pathname}?${pageParams.toString()}`);
}
weatherSel.onchange = () => setWeather(weatherSel.value as Weather);
{
  const w = pageParams.get('weather');
  if (w === 'rain' || w === 'fog') setWeather(w);
}

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
      if (kind !== 'all' && u.kind !== kind) continue;
      if (u.state === 'idle') nodes.add(links[u.location.entrance.link].to);
      // A unit driving back can be sent from where it is (its next junction).
      const veh = u.state === 'returning' && u.tripId !== null ? sim.traffic.vehicleOf(u.tripId) : undefined;
      if (veh) nodes.add(links[veh.route[veh.ri]].to);
    }
  } else {
    // Before a shift: every station, with the move being previewed (if any) applied.
    for (const s of sim.sites) {
      if (preview && s === preview.from) continue;
      const k = STATION_KIND[preview && s === preview.to ? preview.from.kind : s.kind];
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
function setCoverageMode(mode: EmergencyKind | 'all' | null): void {
  coverageMode = mode;
  coverageBtn.setAttribute('aria-pressed', String(coverageMode !== null));
  if (coverageMode === null) view.setCoverage(null);
  syncCoverage();
}
coverageBtn.onclick = () => setCoverageMode(COVERAGE_MODES[(COVERAGE_MODES.indexOf(coverageMode) + 1) % COVERAGE_MODES.length]);

// Station placement (before a shift, optional): click a station, then the building or car park
// to move it to. While choosing, the coverage map shows that kind of unit as if it were there.
// One move per shift; the button then undoes it.
let moving: 'off' | 'station' | 'target' = 'off';
let movingFrom: Site | null = null;
let preview: { from: Site; to: Site } | null = null;
let stationMove: { from: Site; to: Site } | null = null;
const moveBtn = $('moveStation') as HTMLButtonElement;
const SITE_LABEL: Record<string, string> = { hospital: 'Hospital', fire_station: 'Fire station', police_station: 'Police station' };
function endMoving(): void {
  if (moving === 'off') return;
  moving = 'off';
  movingFrom = null;
  preview = null;
  view.setSiteHighlight(null);
  mapEl.style.cursor = '';
  moveBtn.removeAttribute('aria-pressed');
  moveBtn.textContent = stationMove ? 'Undo station move' : 'Move a station (optional)';
  syncCoverage();
}
moveBtn.onclick = () => {
  if (stationMove) {
    // Undo: the station goes back (its old building can host it again).
    const { from, to } = stationMove;
    sim.moveStation(to, from);
    view.redrawSites([from, to]);
    stationMove = null;
    pageParams.delete('move');
    $('moveStationNote').hidden = true;
    moveBtn.textContent = 'Move a station (optional)';
    syncCoverage();
    return;
  }
  if (moving !== 'off') {
    endMoving();
    setPickHint(null);
    return;
  }
  endPicking();
  endPlacing();
  view.follow(null);
  moving = 'station';
  mapEl.style.cursor = 'crosshair';
  moveBtn.setAttribute('aria-pressed', 'true');
  moveBtn.textContent = 'Cancel';
  if (coverageMode === null) setCoverageMode('all');
  setPickHint('Click the hospital, fire station or police station to move · Esc to cancel');
};
function pickForMove(x: number, y: number): void {
  if (moving === 'station') {
    const site = view.pickSite(x, y, (s) => STATION_KINDS.includes(s.kind));
    if (!site) {
      setPickHint('No station there · click a hospital, fire station or police station · Esc to cancel');
      return;
    }
    movingFrom = site;
    moving = 'target';
    setCoverageMode(STATION_KIND[site.kind]);
    setPickHint(`Now click the building or car park to move the ${SITE_LABEL[site.kind].toLowerCase()} to · the map shows coverage from there · Esc to cancel`);
    return;
  }
  const from = movingFrom!;
  const to = view.pickSite(x, y, (s) => sim.canHostStation(s));
  if (!to || !sim.moveStation(from, to)) {
    setPickHint('A station needs a building or car park lot · Esc to cancel');
    return;
  }
  view.redrawSites([from, to]);
  stationMove = { from, to };
  const note = $('moveStationNote');
  note.textContent = `${SITE_LABEL[to.kind]} moved from ${from.address} to ${to.address}.`;
  note.hidden = false;
  endMoving();
  setPickHint(`${SITE_LABEL[to.kind]} moved to ${to.address}`, 4000);
}
mapEl.addEventListener('pointermove', (e) => {
  if (moving === 'off') return;
  const site = moving === 'station'
    ? view.pickSite(e.clientX, e.clientY, (s) => STATION_KINDS.includes(s.kind))
    : view.pickSite(e.clientX, e.clientY, (s) => s !== movingFrom && !STATION_KINDS.includes(s.kind));
  const ok = site !== null && (moving === 'station' || sim.canHostStation(site));
  view.setSiteHighlight(site, ok);
  const next = moving === 'target' && site && ok ? { from: movingFrom!, to: site } : null;
  if (next?.to !== preview?.to) {
    preview = next;
    syncCoverage();
  }
});
// A move made before a reload into the shift's hour (?move=from.to) is made again.
{
  const [a, b] = (pageParams.get('move') ?? '').split('.').map(Number);
  const from = sim.sites[a];
  const to = sim.sites[b];
  if (from && to && sim.moveStation(from, to)) {
    view.redrawSites([from, to]);
    stationMove = { from, to };
    const note = $('moveStationNote');
    note.textContent = `${SITE_LABEL[to.kind]} moved from ${from.address} to ${to.address}.`;
    note.hidden = false;
    moveBtn.textContent = 'Undo station move';
  }
}

// Siren sound (M mutes). Audio starts with the first click or key press, as browsers require.
const sirens = new SirenAudio();
const muteBtn = $('mute') as HTMLButtonElement;
muteBtn.onclick = () => {
  sirens.unlock();
  sirens.muted = !sirens.muted;
  muteBtn.setAttribute('aria-pressed', String(sirens.muted));
  muteBtn.textContent = sirens.muted ? '🔇 Muted' : '🔊 Sound';
};
window.addEventListener('pointerdown', () => sirens.unlock());
// Graphics quality (G): high draws the Kenney vehicle models, low the simple built-in ones. Kept
// for this browser.
const graphicsBtn = $('graphics') as HTMLButtonElement;
function setGraphics(high: boolean): void {
  view.setVehicleStyle(high ? 'models' : 'classic');
  view.effects.enabled = high;
  graphicsBtn.textContent = `Graphics: ${high ? 'high' : 'low'}`;
  try {
    localStorage.setItem('dispatch.graphics', high ? 'high' : 'low');
  } catch {
    // storage blocked: the choice lasts this visit only
  }
}
let savedGraphics: string | null = null;
try {
  savedGraphics = localStorage.getItem('dispatch.graphics');
} catch {
  savedGraphics = null;
}
setGraphics(savedGraphics !== 'low');
graphicsBtn.onclick = () => setGraphics(view.vehicleStyle !== 'models');
$('help').onclick = () => {
  $('helpOverlay').hidden = false;
};
$('helpOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $('helpOverlay').hidden = true;
});

// Incidents: pick a kind, click Place on map, then click a street. Placed incidents are
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
  if (placingCall !== null) view.setSiteHighlight(view.pickSite(e.clientX, e.clientY, () => true), true);
  if (placing !== 'lane' || laneStart === null) return;
  const hit = view.pickLane(e.clientX, e.clientY, laneStart.link);
  if (hit) view.setLanePreview(laneStart.link, ...previewStretch(laneStart.link, laneStart.pos, hit.pos));
});
let placingCall: CallKind | null = null;
function endPlacing(): void {
  if (placing === null && placingCall === null) return;
  if (placingCall !== null) view.setSiteHighlight(null);
  placingCall = null;
  placing = null;
  laneStart = null;
  view.setLanePreview(null);
  incidentBtn.textContent = 'Place on map';
  incidentBtn.removeAttribute('aria-pressed');
  mapEl.style.cursor = '';
}
incidentBtn.onclick = () => {
  if (placing !== null || placingCall !== null) {
    endPlacing();
    setPickHint(null);
    return;
  }
  if (probeMode !== 'idle') {
    endPicking();
    view.setProbePins(null, null);
  }
  if (incidentKind.value.startsWith('call:')) {
    // A call at a building or other address: during a shift or in sandbox.
    if (!dispatch || dispatch.ended !== null) {
      setPickHint('Calls can be placed during a shift or in sandbox', 3000);
      return;
    }
    placingCall = incidentKind.value.slice(5) as CallKind;
    incidentBtn.textContent = 'Cancel';
    incidentBtn.setAttribute('aria-pressed', 'true');
    mapEl.style.cursor = 'crosshair';
    setPickHint(`Click a building or other address for the ${placingCall} call · Esc to cancel`);
    return;
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

function missingCallNeeds(call: EmergencyCall): EmergencyCall['needs'] {
  const remaining = [...call.needs];
  for (const unitId of call.assignedUnitIds) {
    const kind = dispatch?.units[unitId]?.kind;
    const index = kind === undefined ? -1 : remaining.indexOf(kind);
    if (index >= 0) remaining.splice(index, 1);
  }
  return remaining;
}

function needsUnitAssignment(call: EmergencyCall): boolean {
  return (call.state === 'created' || call.state === 'assigned' || call.state === 'en_route') && missingCallNeeds(call).length > 0;
}

// The open call that still needs a unit and comes first in the list (critical first, then the
// earliest deadline), so Tab, Enter and the list agree.
function nextWaitingCall(): number | null {
  const waiting = dispatch?.calls.filter(needsUnitAssignment) ?? [];
  return waiting.length > 0 ? sortCallsByPriority(waiting, sim.time)[0].id : null;
}

function followEmergencyUnit(unitId: number): void {
  const info = dispatch?.unitTravel(unitId);
  if (!info) return;
  selectedEmergencyUnitId = unitId;
  followingEmergency = true;
  view.setEmergencyRoute(info.route);
  view.follow(info.tripId);
  setPickHint(`Following emergency unit to ${info.destination.address}`);
}

function syncDispatchPanel(): void {
  if (!dispatch) return;
  if (dispatch.mode === 'sandbox') {
    // Free play: no score, calls or assignment, just how many units are out.
    const out = dispatch.units.filter((u) => u.state !== 'idle').length;
    $('sandboxStatus').textContent = `Sandbox · ${out} of ${dispatch.units.length} units out`;
    return;
  }
  // Grouped: waiting calls first, the soonest to expire at the top; then calls with a unit
  // on the way or on scene; then the last few finished.
  const center = dispatch;
  const waitingCalls = sortCallsByPriority(center.calls.filter((call) => call.state === 'created'), sim.time);
  const servedCalls = sortCallsByPriority(center.calls.filter((call) => call.state === 'assigned' || call.state === 'en_route'), sim.time);
  const finishedCalls = center.calls.filter((call) => call.state === 'resolved' || call.state === 'missed').slice(-3).reverse();
  const callLabel = (call: EmergencyCall): string => {
    const missing = missingCallNeeds(call);
    if (call.state === 'created') {
      return `waiting for ${missing.join(' + ')} · ${Math.max(0, Math.ceil((call.expiresAt - sim.time) / 60))} min left`;
    }
    if (call.state === 'missed') return 'missed';
    if (call.state === 'resolved') return `done · reached in ${formatMinutes(call.responseTime ?? 0)}`;
    const arrived = call.arrivedUnitIds.length;
    const progress = `${arrived}/${call.needs.length} arrived`;
    return missing.length > 0 ? `needs ${missing.join(' + ')} · ${progress}` : `all units assigned · ${progress}`;
  };
  const callItems: HTMLLIElement[] = [];
  const groups: [string, EmergencyCall[]][] = [['Waiting', waitingCalls], ['Unit on the way or on scene', servedCalls], ['Recent', finishedCalls]];
  for (const [title, calls] of groups) {
    if (calls.length === 0) continue;
    const head = document.createElement('li');
    head.className = 'call-group';
    head.textContent = `${title} (${calls.length})`;
    callItems.push(head);
    for (const call of calls) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.className = `dispatch-call ${call.state === 'created' ? 'waiting' : ''} severity-${call.severity}`;
      const what = document.createElement('b');
      what.append(callIcon(call.kind), ` ${call.kind.toUpperCase()} · ${call.site.address}`);
      const severity = document.createElement('span');
      severity.className = 'call-severity';
      severity.textContent = call.severity;
      const state = document.createElement('span');
      state.textContent = callLabel(call);
      button.append(what, severity, state);
      button.setAttribute('aria-pressed', String(selectedCallId === call.id));
      button.disabled = call.state === 'resolved' || call.state === 'missed';
      button.onclick = () => {
        selectedCallId = call.id;
        selectedUnitId = null;
        selectedEmergencyUnitId = call.assignedUnitId;
        syncDispatchPanel();
      };
      li.append(button);
      callItems.push(li);
    }
  }
  setChildren($('dispatchCalls'), callItems);
  $('dispatchCallsEmpty').hidden = callItems.length > 0;

  const selectedCall = dispatch.calls.find((call) => call.id === selectedCallId && call.state !== 'resolved' && call.state !== 'missed');
  const candidateItems: HTMLLIElement[] = [];
  const assignedUnit = selectedCall?.assignedUnitId === null || selectedCall?.assignedUnitId === undefined
    ? undefined
    : dispatch.units[selectedCall.assignedUnitId];
  const travel = assignedUnit ? dispatch.unitTravel(assignedUnit.id) : null;
  $('dispatchCallDetails').textContent = selectedCall
    ? `${selectedCall.kind.toUpperCase()} · ${selectedCall.site.address} · ${selectedCall.arrivedUnitIds.length}/${selectedCall.needs.length} arrived${missingCallNeeds(selectedCall).length > 0 ? ` · needs ${missingCallNeeds(selectedCall).join(' + ')}` : ''}${travel && assignedUnit ? ` · ${assignedUnit.kind} ETA ${Math.ceil(travel.eta)} s` : ''} · expires in ${Math.max(0, Math.ceil((selectedCall.expiresAt - sim.time) / 60))} min`
    : 'Select a waiting or assigned call to see its details.';
  const selectedEmergencyTravel = selectedEmergencyUnitId === null
    ? null
    : dispatch.unitTravel(selectedEmergencyUnitId);
  if (selectedEmergencyUnitId !== null && !selectedEmergencyTravel) selectedEmergencyUnitId = null;
  const selectedAssignedUnit = assignedUnit && travel ? assignedUnit : undefined;
  const statusUnit = selectedAssignedUnit
    ?? (selectedEmergencyUnitId === null ? undefined : dispatch.units[selectedEmergencyUnitId])
    ?? dispatch.units.find((unit) => unit.state === 'en_route');
  const statusTravel = statusUnit ? dispatch.unitTravel(statusUnit.id) : null;
  $('dispatchTravelStatus').textContent = statusUnit && statusTravel
    ? `${statusUnit.kind[0].toUpperCase()}${statusUnit.kind.slice(1)} ${statusUnit.id + 1} en route to ${statusTravel.destination.address} — ETA ${Math.ceil(statusTravel.eta)} s`
    : 'No emergency units currently en route.';
  view.setEmergencyRoute(selectedEmergencyTravel?.route ?? null);
  if (selectedCall && needsUnitAssignment(selectedCall)) {
    for (const candidate of dispatch.candidates(selectedCall.id)) {
      const unit = dispatch.units[candidate.unitId];
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.className = 'dispatch-candidate';
      const notes = [
        candidateItems.length === 0 ? 'fastest' : '',
        candidate.mutualAid ? 'Mutual aid' : '',
        unit.state === 'returning' ? 'on its way back' : '',
      ].filter(Boolean);
      button.textContent = `${unit.kind.toUpperCase()} ${unit.id + 1} · ${Math.round(candidate.eta)} s${notes.length > 0 ? ` · ${notes.join(' · ')}` : ''}`;
      button.setAttribute('aria-pressed', String(selectedUnitId === unit.id));
      button.onclick = () => {
        selectedUnitId = unit.id;
        syncDispatchPanel();
      };
      li.append(button);
      candidateItems.push(li);
    }
  }
  setChildren($('dispatchCandidates'), candidateItems);
  $('dispatchCandidatesEmpty').hidden = candidateItems.length > 0;
  const assignBtn = $('assignDispatch') as HTMLButtonElement;
  assignBtn.disabled = selectedCall === undefined || selectedUnitId === null;
  assignBtn.onclick = () => {
    if (selectedCall && selectedUnitId !== null && dispatch?.assign(selectedCall.id, selectedUnitId)) {
      lastSent = selectedUnitId;
      selectedEmergencyUnitId = selectedUnitId;
      selectedCallId = needsUnitAssignment(selectedCall) ? selectedCall.id : nextWaitingCall() ?? selectedCallId;
    }
    selectedUnitId = null;
    syncDispatchPanel();
  };

  $('dispatchScore').textContent = dispatch.score.points.toLocaleString();
  $('dispatchWaiting').textContent = dispatch.calls.filter(needsUnitAssignment).length.toLocaleString();
  $('dispatchResolved').textContent = dispatch.score.resolvedCalls.toLocaleString();
  $('dispatchMissed').textContent = dispatch.score.missedCalls.toLocaleString();
  $('dispatchResponse').textContent = dispatch.score.resolvedCalls > 0
    ? `${Math.round(dispatch.score.meanResponseTime)} s`
    : '—';
  const left = Math.max(0, dispatch.shiftEndsAt - sim.time);
  $('dispatchStatus').textContent = `Dispatcher · ends ${formatClock(dispatch.shiftEndsAt)} · ${Math.floor(left / HOUR)}:${String(Math.floor((left % HOUR) / 60)).padStart(2, '0')} left`;
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
    if (!resultShown) {
      resultShown = true;
      showResult(dispatch, outcome);
    }
    paused = true;
    pauseBtn.textContent = 'Resume';
  }

  const unitRows = dispatch.units.map((unit) => {
    const li = listItem('var(--accent)', `${unit.kind} ${unit.id + 1} · ${unit.state.replace('_', ' ')}`, unit.location.address);
    li.dataset.unit = String(unit.id);
    li.classList.add('unit-row');
    // Yielding on this unit's siren trips: live while driving, then the last run's total.
    if (unit.tripId !== null && sim.unitStats(unit.tripId)) {
      sirenTrips.add(unit.tripId);
      lastSirenTrip.set(unit.id, unit.tripId);
    }
    const last = lastSirenTrip.get(unit.id);
    const stats = last === undefined ? null : sim.unitStats(last);
    if (stats) {
      const note = document.createElement('div');
      note.className = 'yield-note';
      const cars = `${stats.carsYielded} car${stats.carsYielded === 1 ? '' : 's'} made way`;
      const held = stats.junctionsHeld > 0 ? ` · ${stats.junctionsHeld} junction${stats.junctionsHeld === 1 ? '' : 's'} held` : '';
      note.textContent = stats.arrivedAt === null
        ? `On the way: ${cars}${held}`
        : `Last run: ${cars}${held}${stats.savedS !== null && stats.savedS > 0 ? ` · saved about ${Math.round(stats.savedS)} s` : ''}`;
      li.append(note);
    }
    if (unit.tripId !== null && sim.traffic.vehicleOf(unit.tripId)) {
      li.classList.add('rideable');
      li.title = 'Ride along';
    }
    const follow = document.createElement('button');
    follow.textContent = 'Follow';
    follow.disabled = unit.state !== 'en_route';
    follow.setAttribute('aria-label', `Follow ${unit.kind} ${unit.id + 1}`);
    follow.onclick = () => followEmergencyUnit(unit.id);
    li.append(follow);
    return li;
  });
  setChildren($('dispatchUnits'), unitRows);
}

// Sidebar tabs: the dispatch panel, or the traffic panels from the A3 build.
const trafficPanels = [...document.querySelectorAll<HTMLElement>('aside > section.panel:not(#dispatchPanel)')];
const tabDispatch = $('tabDispatch');
const tabTraffic = $('tabTraffic');
function showTab(traffic: boolean): void {
  tabDispatch.setAttribute('aria-selected', String(!traffic));
  tabTraffic.setAttribute('aria-selected', String(traffic));
  $('dispatchPanel').hidden = traffic;
  for (const panel of trafficPanels) panel.hidden = !traffic;
}
// Sandbox: no tabs; its short panel sits above all the traffic panels.
function showSandbox(): void {
  $('sandboxActive').hidden = false;
  document.querySelector<HTMLElement>('.side-tabs')!.hidden = true;
  $('dispatchPanel').hidden = false;
  for (const panel of trafficPanels) panel.hidden = false;
}
$('endSandbox').addEventListener('click', () => $('returnMenu').click());
tabDispatch.onclick = () => showTab(false);
tabTraffic.onclick = () => showTab(true);
showTab(false);

// Lists are rebuilt only when what they show changes, so a click is not lost to a rebuild
// between pressing and releasing the button.
const listSignatures = new WeakMap<Element, string>();
function setChildren(el: Element, items: HTMLElement[]): void {
  const signature = items.map((item) => item.outerHTML).join('');
  if (listSignatures.get(el) === signature) return;
  listSignatures.set(el, signature);
  el.replaceChildren(...items);
}

// Best score per mode, shift and difficulty, kept in this browser.
const BEST_KEY = 'dispatch.best.v1';
interface BestScore { points: number; grade: string; date: string }
let playedKey = '';
let resultShown = false;
function bestKey(): string {
  return `${dispatchModeSelect.value}:${shiftSelect.value}:${difficultySelect.value}`;
}
function loadBest(): Record<string, BestScore> {
  try {
    return JSON.parse(localStorage.getItem(BEST_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
function showBest(): void {
  if (dispatchModeSelect.value === 'sandbox') {
    $('bestScore').textContent = 'Sandbox is free play: no score.';
    return;
  }
  const best = loadBest()[bestKey()];
  $('bestScore').textContent = best
    ? `Best here: ${best.points.toLocaleString()} points, grade ${best.grade} (${best.date})`
    : 'No best score yet for this mode, shift and difficulty.';
}
for (const select of [dispatchModeSelect, shiftSelect, difficultySelect]) select.addEventListener('change', showBest);
showBest();

// Grade from the mean score per finished call (100 within target, down to 20 when late, -50
// missed). Losing the shift is an F.
function gradeOf(center: DispatchCenter, outcome: string): { letter: string; within: number; finished: number; mean: number } {
  const finished = center.calls.filter((c) => c.state === 'resolved' || c.state === 'missed');
  const within = finished.filter((c) => c.state === 'resolved' && (c.responseTime ?? Infinity) <= c.targetResponseTime).length;
  const mean = finished.length > 0 ? center.score.points / finished.length : 0;
  const letter = outcome === 'loss' ? 'F' : finished.length === 0 ? '—' : mean >= 90 ? 'A' : mean >= 75 ? 'B' : mean >= 60 ? 'C' : mean >= 40 ? 'D' : 'F';
  return { letter, within, finished: finished.length, mean };
}

function showResult(center: DispatchCenter, outcome: string): void {
  const { letter, within, finished, mean } = gradeOf(center, outcome);
  $('resultGrade').textContent = letter;
  $('resultGradeNote').textContent = finished > 0
    ? `${Math.round(mean)} points per call · ${within} of ${finished} reached within target`
    : 'No calls finished';
  const points = center.score.points;
  const all = loadBest();
  const prev = all[playedKey];
  const best = $('resultBest');
  if (finished > 0 && (!prev || points > prev.points)) {
    all[playedKey] = { points, grade: letter, date: new Date().toISOString().slice(0, 10) };
    try {
      localStorage.setItem(BEST_KEY, JSON.stringify(all));
    } catch {
      // Storage blocked (private window): the best score is just not kept.
    }
    best.textContent = prev ? `New best score! (was ${prev.points.toLocaleString()})` : 'New best score!';
    best.classList.add('new');
  } else {
    best.textContent = prev ? `Best: ${prev.points.toLocaleString()} points, grade ${prev.grade}` : '';
    best.classList.remove('new');
  }
  // What yielding did for this shift's units (see sim.unitStats; the saving reads low).
  let cars = 0;
  let saved = 0;
  let runs = 0;
  for (const id of sirenTrips) {
    const s = sim.unitStats(id);
    if (!s) continue;
    cars += s.carsYielded;
    runs++;
    if (s.savedS !== null && s.savedS > 0) saved += s.savedS;
  }
  const yieldBox = $('resultYield');
  yieldBox.replaceChildren();
  if (runs > 0) {
    const b1 = document.createElement('b');
    b1.textContent = `${cars} car${cars === 1 ? '' : 's'}`;
    const b2 = document.createElement('b');
    b2.textContent = `about ${(saved / 60).toFixed(1)} min`;
    yieldBox.append('Yielding: ', b1, ` made way for your units on ${runs} siren run${runs === 1 ? '' : 's'}, saving `, b2, ' of driving this shift (a cautious estimate: it counts only time saved on the streets, not at junctions or driveways).');
  }
  const chartBox = $('responseChart');
  chartBox.replaceChildren(responseChart(center.calls, Math.max(200, chartBox.clientWidth || 288)));
  const done = center.calls.filter((c) => c.state === 'resolved' || c.state === 'missed');
  $('responseRows').replaceChildren(
    ...done.map((call, k) => {
      const tr = document.createElement('tr');
      const cells = [String(k + 1), CALL_LABEL[call.kind], call.site.address, call.state === 'missed' ? 'missed' : formatMinutes(call.responseTime ?? 0), formatMinutes(call.targetResponseTime)];
      cells.forEach((text, i) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (i >= 3) td.className = 'num';
        tr.append(td);
      });
      return tr;
    }),
  );
}

// Call alerts: a pop-up and a chime for each new call (a low tone for a missed one); a pin over
// each open call on the map, and an arrow at the edge for waiting calls out of view. Clicking a
// pop-up, pin or arrow selects the call and moves the camera there.
const CALL_LABEL: Record<EmergencyCall['kind'], string> = { medical: 'Medical', fire: 'Fire', crime: 'Crime', crash: 'Crash' };
const ALERT_MS = 6000;
const MAX_ALERTS = 3;
function districtOf(call: EmergencyCall): string {
  const name = DISTRICTS[sim.district[call.site.zone]];
  return name === 'Downtown' ? name : `${name} side`;
}
function selectCall(callId: number, focus: boolean): void {
  const call = dispatch?.calls.find((c) => c.id === callId);
  if (!call) return;
  selectedCallId = call.id;
  selectedUnitId = null;
  selectedEmergencyUnitId = call.assignedUnitId;
  if (focus) {
    followingEmergency = false;
    view.focusPoint(call.site.door.x, call.site.door.y);
  }
  syncDispatchPanel();
}
function showAlert(call: EmergencyCall, missed: boolean): void {
  const box = $('callAlerts');
  const alert = document.createElement('button');
  alert.className = missed ? 'call-alert missed' : 'call-alert';
  const head = document.createElement('b');
  head.append(callIcon(call.kind, 13), ` ${missed ? `Missed: ${CALL_LABEL[call.kind].toLowerCase()} call` : `${CALL_LABEL[call.kind]} call · ${districtOf(call)}`}`);
  const body = document.createElement('span');
  body.textContent = missed ? `${call.site.address} · no unit got there in time` : `${call.site.address} · click to show`;
  alert.append(head, body);
  alert.onclick = () => {
    if (!missed) selectCall(call.id, true);
    alert.remove();
  };
  box.prepend(alert);
  while (box.childElementCount > MAX_ALERTS) box.lastElementChild!.remove();
  setTimeout(() => alert.remove(), ALERT_MS);
}
function handleDispatchEvents(): void {
  if (!dispatch) return;
  if (dispatch.mode === 'sandbox') {
    dispatch.drainEvents(); // units go on their own; no alerts
    return;
  }
  let chime = false;
  let alarm = false;
  for (const e of dispatch.drainEvents()) {
    const call = e.callId === undefined ? undefined : dispatch.calls.find((c) => c.id === e.callId);
    if (!call) continue;
    if (e.type === 'call' && dispatch.mode === 'dispatcher') {
      showAlert(call, false);
      chime = true;
    } else if (e.type === 'missed') {
      showAlert(call, true);
      alarm = true;
    }
  }
  if (alarm) sirens.alarm();
  else if (chime) sirens.chime();
}
const markers = new Map<number, HTMLButtonElement>();
const EDGE_PX = 22;
function syncCallMarkers(): void {
  const layer = $('callMarkers');
  const open = dispatch && dispatch.ended === null && dispatch.mode === 'dispatcher' ? dispatch.calls.filter((c) => c.state !== 'resolved' && c.state !== 'missed') : [];
  const w = layer.clientWidth;
  const h = layer.clientHeight;
  const set = (el: HTMLElement, key: 'className' | 'title', value: string) => {
    if (el[key] !== value) el[key] = value;
  };
  for (const call of open) {
    let el = markers.get(call.id);
    if (!el) {
      el = document.createElement('button');
      el.onclick = () => selectCall(call.id, true);
      el.append(callIcon(call.kind, 11), document.createElement('span'));
      layer.append(el);
      markers.set(call.id, el);
    }
    const label = el.querySelector('span') as HTMLSpanElement;
    const p = view.screenPoint(call.site.door.x, call.site.door.y, 2);
    const waiting = call.state === 'created';
    set(el, 'title', `${CALL_LABEL[call.kind]} call · ${call.severity} severity · ${call.site.address} · ${waiting ? 'waiting' : 'unit on the way'}`);
    if (p.ahead && p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h) {
      set(el, 'className', `call-pin severity-${call.severity}${waiting ? '' : ' assigned'}${selectedCallId === call.id ? ' selected' : ''}`);
      const markerText = `${CALL_LABEL[call.kind]} · ${call.severity.toUpperCase()}`;
      if (label.textContent !== markerText) label.textContent = markerText;
      label.style.transform = '';
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
      el.hidden = false;
    } else if (waiting) {
      // On the edge, on the line from the middle of the map towards the call.
      let dx = p.x - w / 2;
      let dy = p.y - h / 2;
      if (!p.ahead) [dx, dy] = [-dx, -dy];
      const scale = Math.min((w / 2 - EDGE_PX) / Math.max(1e-6, Math.abs(dx)), (h / 2 - EDGE_PX) / Math.max(1e-6, Math.abs(dy)));
      set(el, 'className', `call-arrow severity-${call.severity}`);
      if (label.textContent !== '➜') label.textContent = '➜';
      label.style.transform = `rotate(${Math.atan2(dy, dx).toFixed(3)}rad)`;
      el.style.transform = `translate(${(w / 2 + dx * scale).toFixed(1)}px, ${(h / 2 + dy * scale).toFixed(1)}px)`;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }
  const openIds = new Set(open.map((c) => c.id));
  for (const [id, el] of markers) {
    if (openIds.has(id)) continue;
    el.remove();
    markers.delete(id);
  }
}
// A quiet tick on every button press.
document.addEventListener('click', (e) => {
  if (e.target instanceof Element && e.target.closest('button')) sirens.tick();
});

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
  startDispatchBtn.disabled = warming; // the shift starts once the roads are loaded
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
  const amb = view.ambience();
  sirens.ambience(amb.wind, amb.birds);
  const city = view.trafficSound();
  sirens.traffic(paused || warming ? 0 : city.level, city.wet, city.stuck);
  handleDispatchEvents();
  syncCallMarkers();
  updateTutorial();
  perf.drawMs = smooth(perf.drawMs, performance.now() - drawStart);
  if (now - lastSidebar > SIDEBAR_MS) {
    lastSidebar = now;
    updateSidebar();
    syncCoverage();
    syncScenes();
    $('perf').textContent =
      `${perf.fps.toFixed(0)} fps · sim ${perf.simMs.toFixed(1)} ms · draw ${perf.drawMs.toFixed(1)} ms · ` +
      `${view.renderer.info.render.calls} draw calls · ${sim.traffic.vehicles.size} cars`;
  }
  requestAnimationFrame(frame);
  if (!warming && pageParams.get('replay') === '1') startDispatchBtn.click();
}
requestAnimationFrame(frame);
