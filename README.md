# Dispatch: Autonomous Traffic & Emergency Response Simulation
Group Rapid Route, CS 549 (AI for Visual Computing)

Pillars: Pathfinding & Navigation, Swarm & Boids Modeling

## Contents
- `docs/`: Assignment 1 (PDF + editable DOCX) and Assignment 2 (PDF, includes the approval email as page 3)
- `approval/`: approval request email (.eml) and screenshot of the approval thread (approved by Danrui Li, who is also the assigned mentor)
- `prototypes/`: standalone browser prototypes, open the .html files directly
  - `dispatch_2d.html`: 2D canvas version
  - `dispatch_3d.html`: 3D Three.js version (orbit/pan/zoom)
- `presentation/`: project approval presentation (PDF)

## Prototype status
Both prototypes implement A* routing, live congestion, and road closures with live rerouting for a small emergency fleet.
They do not yet include the zone/density demand model, OD matrix, car-following microsimulation, junction rules,
or cost-based route assignment. Those are the planned MVP work for the mid-term.

## Simulation (`sim/`, MVP work in progress)
TypeScript + Vite + Three.js. The sim core has no DOM access and runs headless in tests; `render3d/` (styled after the 3D prototype) only reads state.
```
cd sim
npm install
npm run dev     # open the printed localhost URL
npm test
```
Needs Node 20+. Vite is pinned to 6 / Vitest to 3 because newer releases need a newer Node.

Open `http://localhost:5173/?start=8` to open at 08:00 with the morning peak already loaded.

Done so far: zones with density, a production-constrained gravity OD matrix per time-of-day period, Poisson trip
generation with AM/PM peaks, IDM car-following, junction right-of-way, A* route assignment using live mean link speeds,
and a 3D view (buildings follow zone density, roads tint by congestion, OD arcs and heatmap). The latest assigned route
is highlighted in yellow and the sidebar compares its live expected travel time with the free-flow shortest baseline.
Work split: `docs/MVP_WORK_SPLIT.md`.
