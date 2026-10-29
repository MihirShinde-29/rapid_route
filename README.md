# Dispatch: Autonomous Traffic & Emergency Response Simulation
Group Rapid Route, CS 549 (AI for Visual Computing)

Pillars: Pathfinding & Navigation, Swarm & Boids Modeling

Live demo: https://mihirshinde-29.github.io/rapid_route/ (add `?start=8` to open at the morning peak)

Assignment 3 video: https://www.youtube.com/watch?v=Ib8I2viWXsc

## Contents
- `docs/`: Assignment 1 (PDF + editable DOCX) and Assignment 2 (PDF, includes the approval email as page 3)
- `approval/`: approval request email (.eml) and screenshot of the approval thread (approved by Danrui Li, who is also the assigned mentor)
- `prototypes/`: standalone browser prototypes, open the .html files directly
  - `dispatch_2d.html`: 2D canvas version
  - `dispatch_3d.html`: 3D Three.js version (orbit/pan/zoom)
- `presentation/`: project approval presentation (PDF)

## Prototype status
The early prototypes implement A* routing, live congestion and road closures with rerouting for a small emergency fleet.
They were proofs of logic only; the MVP lives in `sim/`.

## Simulation (`sim/`, the Assignment 3 MVP)
TypeScript + Vite + Three.js. The sim core has no DOM access and runs headless in tests; `render3d/` (styled after the 3D prototype) only reads state.
```
cd sim
npm install
npm run dev     # open the printed localhost URL
npm test        # 63 tests: demand, car-following, junctions, signals, routing, incidents, blocked lanes, sites, trips, units, unit ETAs, yielding, coverage, station placement, block fill and dispatch
npm run build   # type-check and build a static site into sim/dist
```
Needs Node 20+. Vite is pinned to 6 / Vitest to 3 because newer releases need a newer Node.

Open `http://localhost:5173/?start=8` to open at 08:00 with the morning peak already loaded.
Add `&demand=1.2` to scale peak demand for a stress test (1 is the stable setting, 11,500 trips/h).

The live build at the link above is redeployed by GitHub Actions on every push to `main` (`.github/workflows/pages.yml`).

Done so far: zones with density, a production-constrained gravity OD matrix per time-of-day period, Poisson trip
generation with AM/PM peaks, IDM car-following, junction right-of-way with
fixed-time signals (yellow and all-red) and stop signs, A* route assignment using live mean link speeds,
and a 3D view of an irregular city with parks and a mall (buildings follow zone density, roads tint by congestion, OD arcs and heatmap). The app compares the
selected live route against a shorter distance-based candidate using current travel times. When a longer route is faster,
it is retained as the proof route, highlighted in yellow, and labeled in the sidebar.
Work split: `docs/MVP_WORK_SPLIT.md`.

Assignment 3 recording plan and evidence checklist: `docs/ASSIGNMENT3_DEMO_SCRIPT.md`.

Incidents: pick Accident, Lane closure or Road closure in the toolbar and click `Place on map`. During a shift or in
sandbox the same menu places a Medical, Fire or Crime call: click a building. An accident goes where
you click and blocks 12 m of that lane for 20 sim minutes. A lane closure takes two clicks along one lane, its start and
its end. Cars get past either one through the oncoming lane, one side at a time, like a one-lane bridge: the oncoming side
has priority, a blocked car goes when no oncoming car would reach the stretch before it is through, and after 10 s of
waiting the blocked side gets a turn of up to 15 s. A road closure (click a street) keeps all traffic off it except trips
that start or end on it. Cars already driving whose route uses the street are rerouted at their next junction when a
faster way exists; new trips route around it. Click an incident in the
sidebar to fly to it, or × to remove it.

Emergency units: click a unit on the map, or a driving unit in the unit list, to ride along with it. `Boids` shows how
cars make way (each unit's yield reach along its route, the junctions held for it, and each yielding car's steering
arrow). `Coverage` shades the city by how fast the nearest free unit could get there on live traffic (all units, then
each kind). Sirens are procedural Web Audio, louder near the camera; `Sound on` mutes them. Press `?` for the keyboard
shortcuts (Space pause, 1–5 speed, Tab next call, Enter send the fastest unit, F ride along, C coverage, B boids,
M mute, Esc back). If anything throws, an error panel replaces the frozen page.

The game: pick a mode, shift and difficulty and press `Start shift` (the city reloads at the shift's hour with traffic
on the roads). In Dispatcher mode, select a call (from the list, its pop-up, its pin on the map or the arrow at the screen
edge), pick a unit by ETA (a unit driving back to its station counts too) and assign it, or press Enter to send the fastest. Shifts are 2 sim hours at 20×. The A3 traffic panels are in the `Traffic panels` tab. Sandbox is free play like the A3 build: no score or call
list, all the traffic panels shown, and calls and accidents still bring units, sent automatically. Random accidents block a lane and bring crash
calls, more at rush hour, and stay until a unit has dealt with them. The end screen shows a grade, the score and each call's response time against its target; the
best score per mode, shift and difficulty is kept in the browser. Release notes: `docs/A4_RELEASE_NOTES.md`.

Before a shift, `Move a station (optional)` moves one hospital, fire station or police station to another building or
car park: click the station, then hover the map to see the coverage from each spot, and click to place it. The button
then undoes the move.

The OD matrix groups the zones into nine districts (downtown and eight suburban sectors). Cell colour is the model's
share for the current period; the number is the trips actually generated between the two districts in the last sim hour.

For a reproducible routing demo, click `Jam short route` and then `Probe trip`. The sidebar compares the selected live route with the shorter candidate and keeps the first longer-but-faster proof highlighted.
