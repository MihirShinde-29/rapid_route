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
