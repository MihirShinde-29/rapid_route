# Credits

## Assets

- **Vehicle models:** [Car Kit](https://kenney.nl/assets/car-kit) by Kenney (www.kenney.nl), version 3.1, CC0 1.0 (public domain). Credit is not required; we give it anyway.
  - **Files:** `sim/public/models/kenney-car-kit/`, with the kit's `License.txt`.
  - **Models used:** sedan, taxi, hatchback-sports, suv, truck (as our pickup), van, delivery (as our box truck), police, ambulance, firetruck.
  - **Checks:** every model passes the Khronos glTF validator with no errors or warnings.
  - **How we use them:** the models are fitted to our vehicle sizes at load time. Wheels are drawn separately so they can spin and steer. Paint is recoloured per car.

Everything else is drawn in code: buildings, roads, terrain, sky, incidents and the classic vehicles. Sounds are synthesised in the browser. We use no AI-generated assets.

## Libraries

- [three.js](https://threejs.org) (MIT): rendering, glTF loading.
- [Vite](https://vitejs.dev) (MIT) and [Vitest](https://vitest.dev) (MIT): build and tests.
