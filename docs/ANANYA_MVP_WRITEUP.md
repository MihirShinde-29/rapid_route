# Ananya MVP Implementation Notes

## Completed routing and view work

- Replaced the placeholder free-flow Dijkstra router with A* over the directed road network.
- Kept the router cost function pluggable: the simulation uses `link.length / linkMeanSpeed(link.id)` at trip departure, while the baseline router uses free-flow speed limits.
- Added route decisions to simulation state, retaining the latest 20 decisions for inspection and rendering.
- Added a cost proof panel showing the selected route's live cost beside the shorter distance-based candidate's live cost, route-link counts, route distances, and a proof log.
- Added a yellow 3D route overlay that stays on the first longer-but-faster proof route once one is found, instead of changing every frame.
- Updated the README and footer so the current MVP status is accurate.

## Demo evidence to capture

1. Open `http://localhost:5173/?start=8` after `npm run dev`.
2. Set the simulation speed to `1x` or `10x` and let a departure occur.
3. Point out the yellow route overlay and the two live candidate costs in the right sidebar.
4. Increase the simulation to `60x` so the network loads. Continue until the panel says `PROOF` and shows more links but a lower selected cost.
5. Capture the sidebar and congested corridor for the Assignment 3 video/report.

## Known interpretation

The route cost is sampled at departure, as required by the work split. Cars already in the network keep their assigned route; new trips react to current congestion. The shorter candidate is evaluated with the same live cost function for an apples-to-apples longer-but-faster proof. This avoids unstable mid-trip rerouting while still demonstrating time-dependent assignment.
