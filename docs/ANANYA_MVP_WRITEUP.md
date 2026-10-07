# Ananya MVP Implementation Notes

## Completed routing and view work

- Replaced the placeholder free-flow Dijkstra router with A* over the directed road network.
- Kept the router cost function pluggable: the simulation uses `link.length / linkMeanSpeed(link.id)` at trip departure, while the baseline router uses free-flow speed limits.
- Added route decisions to simulation state, retaining the latest 20 decisions for inspection and rendering.
- Added a cost proof panel showing the chosen live route cost, the free-flow shortest baseline, route-link counts, and the latest trip log.
- Added a yellow 3D route overlay for the latest chosen route.
- Updated the README and footer so the current MVP status is accurate.

## Demo evidence to capture

1. Open `http://localhost:5173/?start=8` after `npm run dev`.
2. Set the simulation speed to `1x` or `10x` and let a departure occur.
3. Point out the yellow latest-route overlay and the two route costs in the right sidebar.
4. Increase the simulation to `60x` so the network loads. The live-cost route can change as link mean speeds fall.
5. Capture the sidebar and a congested corridor for the Assignment 3 video/report.

## Known interpretation

The route cost is sampled at departure, as required by the work split. Cars already in the network keep their assigned route; new trips react to the current congestion. This avoids unstable mid-trip rerouting while still demonstrating time-dependent assignment.
