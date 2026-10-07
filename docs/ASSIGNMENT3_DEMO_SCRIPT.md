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

Set the simulation to `60x`. Say: “Cars use IDM-style car-following. They maintain spacing, slow behind a lead vehicle, and wait at shared junctions instead of entering conflicting movements.”

Point to the traffic count, mean trip time, and the evidence checklist. The safety line should say `no overlaps / no gridlock`; the gridlock counter should remain 0.

### 1:20-2:00 - Controlled longer-but-faster route proof

Click `Jam short route`, then click `Probe trip`. If the panel reaches `PROOF`, pause the simulation so the screen is readable. Say: “At departure, the router compares a shorter distance-based candidate with the current congestion-aware route. The controlled jam makes the shorter route slower, so the selected route has more links but a lower live travel time.”

Read the two costs and distances from the route panel. Point to the yellow route on the map and the `PROOF` message. This is the key acceptance screenshot.

### 2:00-2:30 - Stress test and limits

Resume briefly or leave the stress-test state visible. Say: “The stress test reaches more than 150 concurrent cars. The current MVP intentionally excludes emergency dispatch, multi-modal traffic, calibrated lane-changing, adaptive signals, and 3D polish; those are final-roadmap items.”

End with a screenshot showing the traffic count, zero gridlock removals, the proof route, and the completed evidence checklist.

## Screenshots to save

1. AM demand state: OD matrix, peak label, top OD pairs.
2. Stress state: 150+ cars, trips generated, zero gridlock removals.
3. Route proof: `PROOF`, longer route distance/link count, lower selected live cost, and yellow overlay.
4. Test terminal: `14 passed` from `npm test`.

## Important explanation

The yellow line is a persistent route overlay, not an animated vehicle. It stays visible so the selected proof route can be explained and recorded. The actual vehicles move on the roads. Routes are assigned at departure using current mean link speeds; vehicles already on the road keep their assigned route, while new trips can select a different path as congestion changes.
