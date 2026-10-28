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
npm test        # 44 tests: demand, car-following, junctions, signals, routing, incidents, sites, trips, units and dispatch
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

Incidents: pick Accident, Lane closure or Road closure in the toolbar, click `Place incident`, then click a street.
An accident caps speed at 2.5 m/s and clears after 20 sim minutes, a lane closure caps it at 40% of the limit, and a road
closure keeps all traffic off the street except trips that start or end on it. Cars already driving whose route uses the
street are rerouted at their next junction when a faster way exists; new trips route around it. Click an incident in the
sidebar to fly to it, or × to remove it.

The OD matrix groups the zones into nine districts (downtown and eight suburban sectors). Cell colour is the model's
share for the current period; the number is the trips actually generated between the two districts in the last sim hour.

For a reproducible routing demo, click `Jam short route` and then `Probe trip`. The sidebar compares the selected live route with the shorter candidate and keeps the first longer-but-faster proof highlighted.
