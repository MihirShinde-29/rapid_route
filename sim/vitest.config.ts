import { defineConfig } from 'vitest/config';

// The simulation tests are long and CPU-bound. With a worker per core they slow each other down
// until a single test runs for over a minute without a break, and Vitest then reports its own
// worker timeout ("Timeout calling onTaskUpdate") as an error even though every test passed.
// Three workers keep each test short, as in CI.
export default defineConfig({
  test: {
    maxWorkers: 3,
    minWorkers: 1,
  },
});
