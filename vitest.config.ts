import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Live credentials and provider calls are opt-in, never part of the
    // hermetic pull-request gate.
    exclude: [
      "node_modules/**",
      "supabase/functions/node_modules/**",
      "tests/assistant-edge-function.test.ts",
      "tests/cover-function.integration.test.ts",
      "tests/google-ai-key.test.ts",
      "tests/private-accounts.test.ts",
      "tests/supabase-service-role.test.ts",
    ],
  },
});
