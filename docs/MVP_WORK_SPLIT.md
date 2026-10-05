# MVP Work Split (due Oct 13)

Group Rapid Route: Mihir Shinde (mk1353), Ananya Das Hullumane Neelameghashyam (ah1895)

## MVP must show
1. Trips generated from zone density and an OD matrix, with a visible peak hour.
2. A few hundred cars keeping a safe following distance (IDM-style).
3. Junction right-of-way: no overlapping cars, no ghost cars, no gridlock.
4. Cost-based routing: at least one trip takes a longer, less congested route over a shorter, jammed one, with both costs logged.

Already done (Oct 5):
- Project setup in `sim/`, zones and density, gravity OD matrix per time period, peak-hour trip generation.
- 3D view (styled after the prototype) with OD arcs and an OD heatmap.
- First version of traffic: IDM car-following, junction right-of-way (compatible movements share the junction, "don't block the box", arterial priority with an anti-starvation rule), gridlock guard, congestion-tinted roads.
- Placeholder router (free-flow Dijkstra) in `sim/src/routing/router.ts`.
- 13x9 grid, 100 m blocks, 4500 trips/h peak: about 225 cars at peak in a headless test, no overlaps, junction rules hold.

## Scope cuts for the MVP
- One lane per direction, no lane changing. Arterials differ only by speed limit.
- Unsignalized junctions only.
- No emergency vehicles (planned for weeks 9-10).

## Split

| Dates | Mihir: `sim/src/traffic/` | Ananya: `sim/src/routing/` and view |
|---|---|---|
| Oct 6-8 | Review and tune traffic: junction throughput, gridlock removals, edge cases. Add tests for junction priority. | A* over the network with a pluggable cost function (adapt from prototype), replacing the placeholder router. Unit tests. |
| Oct 9-10 | Build the demo scenario: a corridor where the short route jams at peak. Performance check at a few hundred cars. | Travel-time link costs from `linkMeanSpeed`. Route chosen at departure. Log chosen vs. shortest route cost. |
| Oct 11 | Integration: swap the placeholder router for the A* router. Final demand tuning. | In the 3D view (`render3d/`), highlight the logged route. Sidebar panel with chosen vs. shortest cost. |
| Oct 12 | Demo script and rehearsal (Mihir presents). | MVP write-up (plain, concise), screenshots, list of what is not done yet. |
| Oct 13 | Buffer, submit. | Buffer, submit. |

## Interface between the two halves
Agree on these on Oct 6 so neither side is blocked.

- Traffic provides `sim.traffic.linkMeanSpeed(linkId): number` (m/s, free-flow speed if the link is empty). Already exists.
- Routing provides `route(fromNode, toNode): number[]` (list of link ids). Traffic follows that list. The placeholder in `routing/router.ts` already has this signature.

## Process
- Each person works on their own branch off `traffic-core` and merges back daily.
- 10-minute check-in each day.
- Full merge on Oct 11 at the latest.
- Run `npm test` before every merge.
