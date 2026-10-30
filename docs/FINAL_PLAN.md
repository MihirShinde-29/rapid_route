# Plan to the final submission

Group Rapid Route: Mihir Shinde, Ananya Das Hullumane Neelameghashyam

Status (Oct 29): A4 (MVP 2.0) is built, mid-crit slides are done. This plan covers Nov 2 to the final. Dates assume the final is due around Dec 10; fix them once confirmed. Semester weeks count from Aug 31. Assets: procedural (built in code) plus CC0 low-poly models from Kenney for vehicles and buildings; no AI-generated assets, no runtime LLMs.

## Goals for the final

1. **A deeper game:** calls that need more than one unit, severity, ambulances that take patients to hospital, and help from further away when local units are busy.
2. **Smarter traffic:** cars reroute mid-trip on live costs, cars queued at a closure find another way, units turn round sensibly.
3. **Evidence for both pillars:** measured experiments over many city trips, not single test routes, with figures for the final report.
4. **A finished product:** tutorial, icons, sound mix, night lighting, performance at 1000 cars, no known crashes.
5. **A livelier, more realistic city:** detailed vehicle and building models with animation (wheels, body motion, doors, lights), animated incidents and on-scene work, weather that changes driving, buses, pedestrians and parked cars.

## Weekly schedule

| Week | Engineering | Assets / polish | Milestone | Owner |
|---|---|---|---|---|
| W10 (Nov 2 – 8) | Mid-crit feedback. Mutual aid. Smarter turn-round for re-sent units. Cars queued at a closure reroute. | Anything left from A4; incident animations (smoke, hazard lights, flares) | A4 submitted Nov 2; play-test with 3+ outside players | Ananya: mutual aid, play-test. Mihir: turn-round, closure rerouting |
| W11 (Nov 9 – 15) | Multi-unit calls. Severity priority. Ambulances take patients to hospital before returning. | Call and unit icons; sound mix and volume settings; on-scene animations (fire, hose spray, units parked with lights); model pipeline (Kenney Car Kit and City Kits) | Merge end of week | Ananya: multi-unit, severity. Mihir: hospital trips, sound, icons |
| W12 (Nov 16 – 22) | Cars reroute mid-trip on live costs. Yielding tuned at junctions and on arterials. First-shift tutorial. | Kenney vehicles with animation (wheels, steering, body roll, doors on scene); Kenney buildings on lots (start); night lighting; rain and fog (slower driving); buses with stops | Feature-complete build | Mihir: rerouting, yielding, vehicles. Ananya: tutorial, buildings, polish |
| W13 (Nov 23 – 29) | Thanksgiving, light week. Performance pass (1000 cars plus units). Difficulty tuning from play-tests. Experiments for the report. | Kenney buildings finished (night windows, fire damage); final UI pass; end-screen map of calls coloured by response; pedestrians, parked cars, ambient sound; graphics quality setting | Feature freeze Nov 29 | Mihir: performance, experiments. Ananya: tuning, buildings, end-screen map |
| W14 (Nov 30 – Dec 6) | Could-have only if ahead: adaptive signals, two-lane arterials, snow | Video, report figures, final presentation slides | Release candidate Dec 6 | Both |
| **W15 (Dec 7 – 13): buffer** | **No new features.** Bug fixes, docs, README, final report and video | | Final submission | Both |

## Work items

Each item is done when it works in the live build, has a test where it touches the sim, and is in the release notes.

### W10
- **Mutual aid (Ananya).** When no unit of the right kind is free near a call, offer busy-returning units and units from further stations, marked "mutual aid" with their ETA. Done: a call in a district with every local unit busy still gets a candidate.
- **Turn-round (Mihir).** A re-sent unit plans from its actual position and may U-turn at the next safe spot (driveway or junction) instead of driving on to the next junction. Done: no re-sent unit drives more than one block the wrong way in a test sweep.
- **Closure rerouting (Mihir).** Cars queued behind a lane or road closure re-plan if another route is faster. Done: a closure on an arterial at the peak keeps its queue shorter than today's.
- **Play-test (Ananya).** Three or more people outside the group play one shift each; write down where they got stuck. Feeds W12 tutorial and W13 tuning.

### W11
- **Multi-unit calls (Ananya).** A crash needs police and an ambulance; a fire needs an engine and an ambulance. The call resolves when all have arrived; score from the last arrival.
- **Severity (Ananya).** Each call is low, medium or critical. Critical calls expire sooner and score more; the list sorts by severity, then time left.
- **Hospital trips (Mihir).** After a medical call, the ambulance drives to the nearest hospital with its siren on, then returns. Unit is busy until then, so ambulance cover matters.
- **Icons and sound (Mihir).** Procedural icons for call kinds and units in the list, pins and alerts. Volume slider, separate siren and UI levels.

### W12
- **Mid-trip rerouting (Mihir).** Ordinary cars check their route every few junctions and switch only if the new one saves more than a set margin (to stop flipping). Done: no gridlock at the peak, mean trip time not worse.
- **Yielding tuning (Mihir).** Cars waiting at a red light or inside a junction make way where they can; units slow through junctions they cannot hold.
- **Tutorial (Ananya).** An optional first shift that walks through one call: select it, pick a unit, watch it arrive.
- **Night lighting (Ananya).** Unit headlights and beacons lit at night; call pins glow.

### W13
- **Performance (Mihir).** 1000 cars plus 24 units at 60× without dropped sim time on a mid-range laptop.
- **Experiments (Mihir, figures with Ananya).** Each over many trips across the four shifts:
  - yielding on vs off: unit travel time on real city routes;
  - unit ETA accuracy: predicted vs actual, per shift;
  - dispatch policy: nearest by distance vs lowest ETA, on mean response time over a shift;
  - coverage: share of the city reachable within the target time, before and after a station move.
- **Difficulty tuning (Ananya).** From the play-test notes; each level should be winnable but not trivial.
- **End-screen map (Ananya).** A small city map with each call coloured by response time.

### Visuals and world (across W10–W13)

Already in the build: day and night sky with sun, moon and stars; terrain, water and forest; car headlights, brake lights and indicators; static wrecks, cones and barriers at incidents. Everything below is instanced (or merged, for static buildings) and switched off or simplified by a graphics quality setting on slow machines.

- **Incident animations (Mihir, W10).** Accidents: smoke from the wreck, hazard lights flashing, flares on the road, debris. Lane and road closures: blinking barrier lights and an arrow board. Incidents fade in when placed and out when cleared.
- **On-scene animations (Ananya, W11).** Fire calls: flames and a smoke column on the building, the engine's hose spraying while on scene, both dying down as the call resolves. Medical and crime calls: the unit parks at the entrance with lights flashing and a pulsing marker; police tape for crime calls. A short "resolved" effect when a call ends.
- **Weather (Mihir, W12).** Rain and fog as particles and darker light, wet road shading. It is not only visual: the sim lowers speeds and lengthens headways in rain, so ETAs, coverage and response times change. A shift option picks clear, rain or fog.
- **Buses (Mihir, W12).** A few bus lines on arterials with stops; a stopped bus blocks its lane like a short accident, so cars queue or pass.
- **Pedestrians and parked cars (Ananya, W13).** Instanced walkers on pavements downtown and near parks (visual only, no crossings in the sim); parked cars filling car parks and some kerbs by time of day.
- **Ambient sound (Ananya, W13).** Traffic hum that follows the number of cars near the camera, rain sound, distant sirens.
- **Graphics quality (Mihir, W13).** Low / medium / high: particles, pedestrians, shadows and fill on or off. The performance target (1000 cars plus units) is checked on medium.

### Models: Kenney Car Kit and City Kits (W11–W13)

Kenney's packs are CC0 (public domain, credit optional) and low-poly, which matches our style. Car Kit: 45+ vehicles in glTF, including sedan, van, ambulance, firetruck and police car, separate wheels and crash debris. City Kits: Commercial, Suburban, Industrial and Roads. We credit Kenney in the README and final report anyway.

- **Pipeline (Mihir, W11).** Download the packs into `sim/public/models/` with their licence files. Check every model we use with the glTF validator (some Car Kit `.glb` files have been reported with export errors) and fix or skip those. Load once, scale to our sizes, and build one instanced mesh per model (vehicles) or merged geometry per block (buildings). Add `docs/CREDITS.md`.
- **Vehicles (Mihir, W12).** Cars, vans, trucks, buses and the three unit types use Car Kit bodies with a few colour variants. Head, tail, brake and indicator lights and siren lamps are refitted to each model. Animation: wheels spin with speed, front wheels steer through turns, the body pitches when braking and rolls in turns, units' doors open on scene. Crash debris from the kit at accidents.
- **Buildings (Ananya, W12–W13).** City Kit buildings replace the procedural ones by site kind: houses (Suburban), shops, offices and towers (Commercial), warehouses (Industrial). Each model is scaled and rotated to its lot so its door faces the site's entrance; lots no model fits keep the procedural building. Stations keep their own buildings with the kit's props added. Night: lit window variants switched by the sky's night value, as now. Fire calls: the building darkens (charred tint) while it burns and after.
- **Look and fallback (both, W13).** Retune road, pavement and terrain colours to match the kit palette. The graphics setting keeps a "classic" option with the current procedural models, so a broken model never blocks a demo.

### W14 and W15
- **Video** (3–5 min): one full Dispatcher shift cut down, plus the boids and coverage views.
- **Final report:** design, the two pillars with the experiment figures, what changed since A4, known issues.
- **Final presentation slides**, if there is a final crit.
- **README:** how to run, controls, test command, live link.

## Cut order if late

Two-lane arterials, adaptive signals and snow (already could-have), pedestrians and ambient sound, buses, Kenney buildings (the procedural city stays), vehicle animation beyond wheels, end-screen map, tutorial, on-scene animations, night lighting, severity, hospital trips. Incident animations and weather go last among the visuals: weather also changes the sim. Mutual aid, multi-unit calls, rerouting and the experiments stay: they are the depth for the two pillars.

## Risks

- **Mid-trip rerouting destabilises the peak.** Keep the margin rule and the peak test; if it fails, limit rerouting to cars near a closure.
- **Hospital trips and multi-unit calls tie up units.** Retune unit counts and call rates in W13; the difficulty table may need another column.
- **Performance at 1000 cars.** Profile first; the step is about 0.5 ms now, so rendering is the likelier limit, and particles, pedestrians and weather add to it. Everything new is instanced and behind the quality setting.
- **Kenney models don't fit our layout or cost too much.** Buildings must fit lots and face entrances; vehicles add triangles per instance. Measure frame time with 1000 cars before switching; keep the classic option as the fallback.
- **Visuals crowd out the core.** Visual items never block a sim or game item in the same week; they move to the next week instead.
- **Experiments take longer than expected.** Run them headless in Vitest-style scripts so they can run overnight.

## Open questions

1. Confirm the final due date and what the final submission must include (report length, video length, presentation).
2. Who records and edits the video?
3. Any changes from the mid-crit feedback.
