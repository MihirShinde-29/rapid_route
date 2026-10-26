# Assignment 4 Plan: MVP 2.0 (Alpha) and Schedule to Final

Group Rapid Route: Mihir Shinde, Ananya Das Hullumane Neelameghashyam

Status: draft for discussion. Nothing below is built yet. Dates assume A4 is due Mon Nov 2 and the final is due around Dec 10; fix them once confirmed.

## 1. What A4 asks for, and our answer

| Brief | What we build |
|---|---|
| Start state (menu) | Title screen over the live city (it keeps running behind the menu). Pick a mode (Dispatcher or Sandbox), a shift (AM rush, midday, PM rush, night) and a difficulty (Easy, Normal, Hard). Best score per shift shown. Optional pre-shift step: choose where one station goes. How-to-play card. |
| Active state | A 2-hour sim shift. Emergency calls appear on the map; ambulances, fire engines and police cars leave stations and drive through the real traffic with sirens. |
| End state (win / loss / reset) | Dispatcher: the shift ends with a score card (calls handled, mean response time, missed calls, grade, a chart of each call's response against its target, new best score). Loss: 3 missed calls end the shift early. Sandbox: an End session button shows the same summary. Both: Play again (same mode and shift) or Menu. |
| Functional UI / HUD | Shift clock and time left, score, call list, unit list with status, pause and speed, existing traffic panels collapsed into a tab. Pop-up call alerts and edge-of-screen arrows to off-screen calls. Keyboard shortcuts with a help overlay. Ride along with any unit. Coverage map toggle. |
| City | Every building, park and car park is an address with its own entrance on the street. Every trip, and every emergency call, goes from one entrance to another; cars turn in and out from both directions. Parks get leisure trips. Buildings fill their blocks, with small structures in leftover space. Accidents block part of one lane and cars drive round them; lane closures close one side of a stretch. |
| Sound | Procedural siren on units (Web Audio, louder when the camera is near), new-call chime, UI clicks. Mute button. |
| Second pillar (Swarm & Boids) | Cars yield to sirens with local steering rules: separation (pull to the side, slow and stop), then merge back once the unit has passed. Junctions hold cross traffic for an approaching unit. A boids debug view draws each yielding car's steering arrow and the unit's yield radius. |
| First pillar (Pathfinding), made visible | Coverage map: the city shaded by how fast the nearest free unit could reach each junction right now, on live traffic (multi-source shortest paths). It turns red as units get busy or roads jam. |
| Stability | Runs without crashing on normal input; new tests for dispatch and yielding; an error overlay instead of a frozen page if something throws. |
| PDF (2 pages max) | Weekly schedule to the final (buffer week last), release notes since A3, link to the live build. |

## 2. Game design (agree on this first)

**Modes**
- **Dispatcher** (the game): calls wait until the player assigns a unit. Click a call (on the map or in the list); the panel shows the free units that can take it, each with a live ETA from A*, and marks the fastest. Click a unit, or press Enter to send the fastest.
- **Sandbox** (free play): units are sent automatically (nearest free unit by ETA). The player places accidents and closures (already built) and watches the response. No loss.

**Shift:** 2 sim hours. Default speed 20× (about 6 real minutes); the speed menu stays.

**Difficulty:** changes the call rate and the unit count.

| | Easy | Normal | Hard |
|---|---|---|---|
| Calls per sim hour | 12 | 20 | 30 |
| Units | as in the station table, +1 ambulance per hospital | as in the station table | −1 police car per station |
| Missed calls to lose | 4 | 3 | 2 |

Best score per mode, shift and difficulty is saved in the browser (localStorage) and shown on the menu and end screen.

**Station placement (pre-shift, Dispatcher only):** before the shift starts, the player can move one fire station to any junction; the coverage map previews the effect. Skippable.

**Random accidents:** during a shift, accidents happen on their own (about 3 per shift, more at rush hour). Each slows traffic on its street and creates a crash call; it clears when that call is handled.

**Call alerts:** each new call shows a short pop-up ("Medical call, Downtown") with a chime. Calls outside the view get an arrow at the screen edge; clicking the arrow or the pop-up selects the call and moves the camera there.

**Ride along:** click a unit (on the map or in the unit list) to follow it with the chase camera from the probe trip; Esc returns.

**Keyboard:** Space pause, 1–5 speed, Enter send the fastest unit to the selected call, Tab next call, F follow the selected unit, C coverage map, B boids debug view, M mute, Esc back or menu, ? help overlay.

**City: addresses and entrances**
- The layout moves from the 3D view into the simulation (`sim/src/city/sites.ts`), generated once from its own seed. The view only draws it.
- **Site** = a building, park, plaza, car park, mall or station, with a kind, footprint, size (floor area) and an **entrance**: the lane it opens onto and how far along it. Each site also gets a street address ("14 Oak St") for call alerts.
- Entrances are at least about 12 m from junctions and from each other. The driveway strip from the kerb to the door is kept clear of buildings.
- Small structures that fill leftover space (sheds, garages, kiosks, tanks, fences, hedges) are scenery, not addresses. A 1 m occupancy grid per block stops anything overlapping.
- **Trips:** the OD matrix still decides how many trips go zone to zone (so the OD panel and tests are unchanged). Each trip then picks an origin site and a destination site in those zones, weighted by size.
- **Leisure trips:** parks and the mall attract a leisure share, mostly midday and evening.
- **Turning in and out from both directions:**
  - a right turn in or out works like a normal turn;
  - a left turn in waits in its lane for a gap in oncoming traffic, holding up the cars behind it, as in real life;
  - a left turn out waits for gaps both ways.
- Cars pull out of and into the exact entrance, using the existing driveway animation with the site's door as the end point.
- **Drawn entrances:** a dropped kerb and driveway or path, plus a door marker by kind: garage door (house), lobby canopy (tower or apartment), loading dock (warehouse), gate (park), station doors.
- **Stations are sites:** hospitals, fire and police stations are real buildings with their own doors (this moves the station buildings from week 10 into A4).

**Incidents on a lane** (replaces today's whole-street speed caps)
- **Accident:** one click places it on the nearest lane, at that spot; it blocks about 12 m of that lane.
- **Lane closure:** closes one side of a stretch. Two clicks: the first snaps to the nearest lane and sets the start; a preview line follows the mouse along that lane; the second sets the end. The end is kept on the same lane and at least about 12 m from each junction. Esc cancels.
- **Getting past: one-lane-bridge control.**
  - The blocked stretch, plus a few metres either side, is a controlled zone covering both lanes.
  - Oncoming traffic has priority and drives through normally unless someone is passing.
  - A blocked car stops before the obstacle and waits for a gap: no oncoming car will reach the zone in the time it takes to pass, plus a margin.
  - It then passes through the oncoming lane at low speed, and oncoming cars arriving meanwhile hold at the zone edge.
  - Cars queued behind may follow through the same gap.
  - After about 10 s of waiting the blocked side gets a turn, as flaggers run work zones on two-lane roads.
- Road closures stay as they are (the whole street).
- Entrances inside a blocked stretch: trips approach from the open end or wait.

**Stations and units** (first pass, tune in play-testing)

| Station | Count | Units |
|---|---|---|
| Hospital (EMS) | 2 | 2 ambulances each |
| Fire station | 2 | 1 fire engine each |
| Police station | 2 | 2 police cars each |

Stations are sites (real buildings with their own entrances), spread so each covers part of the city.

**Calls**

| Type | Unit | On-scene time | Target | Expires (missed) |
|---|---|---|---|---|
| Medical | ambulance | 4 min | 8 min | 15 min |
| Fire | fire engine | 8 min | 8 min | 15 min |
| Crime | police | 3 min | 10 min | 20 min |
| Crash (from an accident) | police | 5 min | 10 min | 20 min |

- Calls arrive at random (about one every 3 sim minutes, busier at rush hour). Each happens at a site, picked by zone density and site size, so downtown gets more. Units drive to that site's entrance.
- A placed accident creates a crash call. The accident clears when that call is handled, not on a fixed timer.
- Response time = unit arrives minus call created.

**Unit states:** idle at station, en route (siren), on scene, returning (no siren, can be reassigned).

**Scoring (Dispatcher):** 100 points if the unit arrives within target, down to 20 at the expiry time, −50 for a missed call. Grade from the mean. Win: shift completed with fewer than 3 missed calls.

**Yielding (boids), in our one-lane-per-direction model**
- A car within about 120 m ahead of a unit with its siren on, on the unit's path, gets a separation steer. It moves to the shoulder (drawn as a sideways shift of up to about 2 m), slows and stops.
- The unit treats cars on the shoulder as passable and drives past them.
- Once the unit is about 20 m past, the car merges back when there is a gap.
- At a junction the unit is about to enter, other approaches are held (signal pre-emption), and the unit may go on red.
- Units drive up to 1.3× the speed limit with the siren on.

## 3. Work split

The split is by module, with one interface between the halves (section 4), like the MVP split. Anything that touches the traffic model, the camera or map picking sits with Mihir; dispatch, game rules and panels sit with Ananya.

| | **Mihir: traffic, camera and map side** (`sim/src/traffic/`, `render3d/`) | **Ananya: dispatch and game side** (`sim/src/dispatch/`, UI) |
|---|---|---|
| Core | Interface stub; emergency vehicles in the traffic model; boids yielding; junction pre-emption; emergency vehicle models and siren lights; yielding offsets in the 3D view; error overlay; performance check | Stations, units, call generator, unit state machine, assignment (nearest by A* ETA), scoring, shift end and loss; menu, HUD, call and unit panels, click-to-assign; end screen; Sandbox mode; accident → crash call |
| City | Sites module (layout moved out of the view); entrance-to-entrance trips; turns in and out from both directions; leisure trips; drawn entrances; block fill; lane-level accident and one-side lane closure; stations as sites | Use site addresses in calls, alerts and panels |
| Additions | Siren audio; boids debug view; ride along with a unit; keyboard shortcuts and help overlay; coverage map; station placement on the map | Difficulty and best scores; response-time chart on the end screen; random accidents; call alerts (pop-ups, edge arrows); new-call chime and UI sounds |
| Tests | Unit passes a queue; no overlaps among cars not on the shoulder; response with yielding is faster than without; pre-emption holds cross traffic; coverage times match single-source A*; no sites overlap and every entrance is reachable; left turns only go on a gap; the peak still carries about 700 cars with 0 gridlock removals; a car passing a blocked lane and an oncoming car are never in the zone together | Call lifecycle (created → assigned → on scene → resolved / missed); nearest-unit choice; scoring; shift end and loss per difficulty; random accidents clear when handled |
| Report | Schedule table, Known issues | Release notes, screenshots |

## 4. Interface (agree on Day 1, Oct 27)

Mihir lands a stub on Day 1. With it, units drive as ordinary cars, so Ananya can build dispatch against the real interface straight away; yielding and pre-emption replace the stub's internals later without changing its signatures.

```ts
// Vehicle kinds added to traffic/vehicleTypes.ts
type EmergencyKind = 'ambulance' | 'fire' | 'police';

// TrafficModel (Mihir)
enqueue(trip: Trip, route: number[], opts?: { siren?: boolean }): void; // siren: yield + pre-emption
setSiren(tripId: number, on: boolean): void;                            // e.g. off when returning
vehicleOf(tripId: number): Vehicle | undefined;                         // position for UI and ETA
// Simulation.step() also reports trips that arrived this step:
arrivals: Trip[];                                                       // cleared at the start of each step

// Dispatch (Ananya), owned by Simulation and stepped each tick after traffic
class DispatchCenter {
  constructor(sim: Simulation, opts: { mode: 'dispatcher' | 'sandbox' });
  step(t: number): void;                          // generate calls, expire them, auto-assign in sandbox, read arrivals
  assign(callId: number, unitId: number): void;   // player action
  candidates(callId: number): { unitId: number; eta: number }[]; // live A* ETA, fastest first
  readonly calls: Call[]; readonly units: Unit[]; readonly score: Score;
  readonly ended: null | 'win' | 'loss' | 'ended';
  readonly stations: Station[];
  moveStation(stationId: number, node: number): void;  // pre-shift station placement (Mihir's map UI calls it)
  // Events since the last step, for alerts, sounds and the camera:
  // 'call' | 'assigned' | 'arrived' | 'resolved' | 'missed' | 'ended', each with callId / unitId.
  readonly events: DispatchEvent[];
}

// Sites (Mihir). The Day-1 stub has one site per block side at today's driveway points;
// the real layout replaces it without changing these signatures.
type SiteKind = 'house' | 'apartment' | 'tower' | 'shop' | 'warehouse' | 'park' | 'plaza' | 'parking' | 'mall'
  | 'hospital' | 'fire_station' | 'police_station';
interface Site { id: number; kind: SiteKind; zone: number; size: number; address: string;
  entrance: { link: number; pos: number }; door: { x: number; y: number } }
sim.sites: Site[];
// Route from a site, or from a vehicle where it is now (a unit on the move), to a site's entrance.
sim.planTrip(from: Site | Vehicle, to: Site): { route: number[]; departPos: number; arrivePos: number; eta: number };

// Coverage (Mihir): seconds from the nearest free unit to every node, on live link costs.
coverageTimes(sources: number[]): Float64Array;    // multi-source Dijkstra over sim.router's cost
```

To send a unit, dispatch calls `sim.planTrip(unit's station site or vehicle, call site)`, builds a Trip (kind = unit type) and calls `traffic.enqueue(..., { siren: true })`. Arrival is detected through `sim.arrivals`. Stations come from `sim.sites` (hospital, fire_station, police_station).

## 5. A4 week (Oct 27 – Nov 2)

Mihir's side is now about twice a normal week. It fits only because most of that code is written with AI assistance (as in A3) and then reviewed and tested by Mihir; the cut order below protects the deadline.

| Day | Mihir | Ananya | Together |
|---|---|---|---|
| Tue Oct 27 | Interface stub merged by noon (emergency kinds, siren flag, `arrivals`, `vehicleOf`, stub `sites` and `planTrip`); sites module: layout data moved out of the view | `dispatch/` skeleton: stations, units, call generator, state machine, events, against the stub | Agree on interface and game numbers (30 min) |
| Wed Oct 28 | Entrance-to-entrance trips; turns in and out from both directions; leisure trips; re-tune to about 700 cars with 0 gridlock; tests | Assignment (nearest by ETA), scoring, shift end and loss, difficulty settings; calls at sites. Tests. | |
| Thu Oct 29 | Yielding (shoulder, pass, merge back); junction pre-emption; tests | Menu screen (mode, shift, difficulty), HUD, call and unit panels, click-to-assign | **Integration**: merge both halves |
| Fri Oct 30 | Lane-level accident and one-side lane closure; emergency vehicle models, siren lights, yielding offsets in the view; drawn entrances | End screen with response-time chart and best scores; Sandbox mode; accident → crash call; random accidents | Play-test both modes, tune numbers |
| Sat Oct 31 | Block fill pass; boids debug view; siren audio; ride along; keyboard shortcuts and help; error overlay; coverage map; station placement; performance check | Call alerts (pop-ups, edge arrows); new-call chime and UI sounds; release notes and screenshots | Freeze features at end of day |
| Sun Nov 1 | Schedule table and known issues; bug fixes | Bug fixes | Final test pass, deploy, PDF |
| Mon Nov 2 | | | Submit |

**If the week runs over**, cut in this order (each moves to week 10):
1. station placement;
2. the coverage map;
3. the response-time chart;
4. the block fill pass;
5. lane closures (accidents on a lane stay);
6. left turns into and out of entrances (fall back to right-in, right-out).

The core loop, yielding, sites with entrance-to-entrance trips, sound, alerts and shortcuts stay.

## 6. Schedule to the final (this table goes in the A4 PDF)

Semester weeks counted from Aug 31 (week 9 = Oct 26). Assets are procedural (built in code); we are not using AI-generated assets.

| Week | Engineering | Assets | Integration / milestone | Owner |
|---|---|---|---|---|
| W9 (Oct 26 – Nov 1) | Emergency vehicles, yielding, pre-emption, boids debug view; sites with entrances, entrance-to-entrance trips with turns both ways, leisure trips; lane-level accident and lane closure; dispatch core, scoring, difficulty; menu, HUD, end screen; alerts, shortcuts, ride along; coverage map; station placement | Ambulance, fire engine, police models; siren lights; station buildings; drawn entrances; block fill structures; call pins; siren audio, chime and UI sounds (procedural) | MVP 2.0 integrated Oct 29, submitted Nov 2 | Both (split above) |
| W10 (Nov 2 – 8) | Mutual aid (send from further away when local units are busy); returning units can be reassigned mid-route; anything cut from A4 | Anything cut from A4 | Merge mid-week; play-test | Ananya: mutual aid; Mihir: A4 carry-over |
| W11 (Nov 9 – 15) | Multi-unit calls (crash needs police and ambulance; fire needs engine and ambulance); severity priority | UI icons; sound mix and volume settings | Merge end of week | Ananya: multi-unit; Mihir: sound and icons |
| W12 (Nov 16 – 22) | Ordinary cars reroute mid-trip when a closure appears; yielding tuning at intersections and on arterials | Polish: night lighting of units, call markers | Feature-complete build | Mihir: rerouting; Ananya: polish |
| W13 (Nov 23 – 29) | Thanksgiving, light week: performance pass (1000 cars plus units), difficulty tuning | Final UI pass | Final feature freeze Nov 29 | Both |
| W14 (Nov 30 – Dec 6) | Could-have only if ahead: adaptive signals, severity-weighted dispatch | Video recording, report figures | Release candidate Dec 6 | Both |
| **W15 (Dec 7 – 13): Buffer** | **No new features.** Bug fixes, documentation, README, final report and video | | Final submission | Both |

## 7. Release notes so far (since A3, Oct 13)

New
- OD matrix redrawn as 9 districts (downtown plus 8 suburban sectors): model share as colour, live trip counts from the last sim hour (grader feedback).
- Real-time perturbations: place accidents, lane closures and road closures on any street; affected cars reroute at their next junction (grader feedback).
- Incident list with time left and cars rerouted; click to fly the camera there.
- Live demo deployed to GitHub Pages on every push.

Fixed
- OD panel was unreadable (572 × 572 zone pairs drawn in about 260 px) and only redrew when the time period changed.
- MVP checklist still said "target 150+ cars".

Known issues
- Lane closure is a speed cap; the model has one lane per direction, so no lane is physically closed.
- A road closure still admits trips that start or end on that street.
- Rerouting happens when an incident is placed; cars do not re-check their route afterwards.

## 8. Risks

- **Yielding in a one-lane model.** The pass-on-shoulder trick breaks lane ordering. Mitigation: cars on the shoulder are excluded from the overlap invariant and from car-following leaders, and a test drives a unit through a full queue. If it is not stable by Oct 29, fall back to pre-emption plus cars stopping (no passing) for A4.
- **Shift too long or too easy.** Tune call rate and unit counts in play-tests on Oct 30.
- **City change touches core traffic numbers.** Entrance-to-entrance trips and left turns change throughput, so the peak (about 700 cars, 0 gridlock) has to be re-verified on Wed Oct 28. If it drops, lower demand slightly and say so in the known issues.
- **Too much for one week.** Ten additions and the city work on top of the core. The cut order in section 5 keeps the core loop safe; nothing in the core depends on an addition.
- **Browser audio.** Browsers block sound until the first click, so audio starts from the menu's Start button.
- **Integration day slips.** The interface stub on Day 1 means dispatch is built against the real signatures from the start.

## 9. Open questions

1. Confirm the A4 and final due dates.
2. Default game speed: 20× (6-minute shift) or slower?
3. Who records the video and writes which part of the PDF?
