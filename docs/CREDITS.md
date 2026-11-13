# Credits

## Assets

- **Vehicle models:** [Car Kit](https://kenney.nl/assets/car-kit) by Kenney (www.kenney.nl), version 3.1, CC0 1.0 (public domain). Credit is not required; we give it anyway.
  - **Files:** `sim/public/models/kenney-car-kit/`, with the kit's `License.txt`.
  - **Models used:** sedan, taxi, hatchback-sports, suv, truck (as our pickup), van, delivery (as our box truck), police, ambulance, firetruck; for incident scenes, cone, debris-bumper, debris-door, debris-tire, debris-plate-a and debris-spoiler-a.
  - **Checks:** every model passes the Khronos glTF validator with no errors or warnings.
  - **How we use them:** the models are fitted to our vehicle sizes at load time. Wheels are drawn separately so they can spin and steer. Paint is recoloured per car.

- **Building models:** [City Kit (Suburban)](https://kenney.nl/assets/city-kit-suburban), [City Kit (Commercial)](https://kenney.nl/assets/city-kit-commercial) and [City Kit (Industrial)](https://kenney.nl/assets/city-kit-industrial) by Kenney (www.kenney.nl), CC0 1.0 (public domain).
  - **Files:** `sim/public/models/kenney-city-suburban/`, `kenney-city-commercial/` and `kenney-city-industrial/`, each with the kit's `License.txt` and its texture.
  - **Models used:** suburban building-type-a to u (houses); commercial building-a to n and building-skyscraper-a to e (shops, apartment blocks, towers, the mall, hospitals and police stations); industrial building-a to t (warehouses and fire stations).
  - **How we use them:** every building lot gets the model closest to its footprint and height, turned to face its street; stations get a coloured plate on the roof. Beyond about 3.5 km from the camera a building is drawn as a plain box in the model's own colours. Graphics low keeps the drawn-in-code buildings.

Everything else is drawn in code: roads, terrain, sky, the rest of the incident scenes and the classic vehicles. Sounds are synthesised in the browser. We use no AI-generated assets.

## Libraries

- [three.js](https://threejs.org) (MIT): rendering, glTF loading.
- [Vite](https://vitejs.dev) (MIT) and [Vitest](https://vitest.dev) (MIT): build and tests.
