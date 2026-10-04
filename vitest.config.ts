import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Server tests start the mock `t3` and `git` as child processes, which takes seconds on a busy machine.
    testTimeout: 20_000,
  },
});
