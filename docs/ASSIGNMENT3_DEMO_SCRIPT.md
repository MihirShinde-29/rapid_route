# Assignment 3 Demo Script and Evidence Plan

## Setup

From `sim/`:

```bash
npm test
npm run dev -- --host 0.0.0.0
```

Open the forwarded port with `?start=8` so the morning peak is already visible. Use the `60x` speed setting after the introduction. Keep the browser window large enough to show both the 3D view and the right sidebar.

## 2-3 minute recording

### 0:00-0:20 - What is being demonstrated

Say: “This is Dispatch, a browser-based traffic microsimulation. The MVP focuses on the traffic substrate: zone-based demand, OD flows, car-following, junction right-of-way, and congestion-aware route assignment.”

Point to the city, the dense commercial buildings, the OD matrix, and the demand cards.

### 0:20-0:50 - Zone demand and peak hour

Say: “The building density represents zone density. The OD matrix distributes trips between zones, and the AM period increases residential-to-commercial demand.”

Point to the `AM 06-10` label, `Target trips/h now`, generated trips, and the top OD pairs.

### 0:50-1:20 - Car-following and junction safety

Set the simulation to `60x`. Say: “Cars use IDM-style car-following. They maintain spacing, slow behind a lead vehicle, and wait at shared junctions instead of entering conflicting movements. Where arterials meet, and at every downtown junction, timed signals run green, yellow and all-red for each direction, and cars only enter on green, or on yellow when they are too close to stop; right turns on red are allowed after stopping. Suburban crossroads are all-way stops; at T-junctions only the street that ends has a stop sign.”

Point to the traffic count, mean trip time, and the evidence checklist. The safety line should say `no overlaps / no gridlock`; the gridlock counter should remain 0.

### 1:20-2:00 - Controlled longer-but-faster route proof

Click `Jam short route`, then click `Probe trip` and press Enter to send the probe on the default cross-town route (or click a start and a destination on the map). The camera follows the probe car. If the panel reaches `PROOF`, pause the simulation so the screen is readable. Say: “At departure, the router compares a shorter distance-based candidate with the current congestion-aware route. The jam button works like an incident on the shorter route: cars on it really slow to a crawl, so the selected route is longer but has a lower live travel time.”

If asked: the same longer-but-faster choice also happens on its own at the morning peak (hundreds of trips between 07:30 and 08:30 in testing); the button just makes it reproducible on camera.

Read the two costs and distances from the route panel. Point to the yellow route on the map and the `PROOF` message. This is the key acceptance screenshot.

### 2:00-2:45 - Stress test and limits

Point to the performance line at the top right of the 3D view (fps, sim ms, draw ms, cars). Say: "At the morning peak the city carries about 700 vehicles at once (cars, SUVs, vans and trucks) across a 26 by 22 block city, with no gridlock removals, at this frame rate."

Then open a second tab with `?start=8&demand=1.3` (30% more peak demand than the stable setting). Switch to 300x and say: "Past about 13,000 trips per hour the downtown junctions saturate. Queues spill back, the gridlock counter starts rising, and the simulation cost per frame grows." Point to the gridlock counter, the red roads and the fps / sim ms numbers.

Close with: "Emergency dispatch, multi-modal traffic, lane changing and adaptive signals are not in the MVP; dispatch is the next layer for the final."

## Screenshots to save

1. AM demand state: OD matrix, peak label, top OD pairs.
2. Stress state: 650+ vehicles, trips generated, zero gridlock removals, and the fps line.
3. Limit state: `?demand=1.3` with the gridlock counter above zero.
4. Route proof: `PROOF`, longer route distance/link count, lower selected live cost, and yellow overlay.
5. Test terminal: `22 passed` from `npm test` (includes junction right-of-way, signal and stop-sign tests).

## Important explanation

The yellow line is a persistent route overlay, not an animated vehicle. It stays visible so the selected proof route can be explained and recorded. The actual vehicles move on the roads. Routes are assigned at departure using current mean link speeds; vehicles already on the road keep their assigned route, while new trips can select a different path as congestion changes.
