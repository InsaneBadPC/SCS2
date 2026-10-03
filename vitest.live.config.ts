import { defineConfig } from "vitest/config";

// Živé testy (produkční Gemini/Supabase) jsou opt-in a nikdy součástí hermetic
// brány. Tento config je jediným způsobem, jak je spustit: `pnpm test:live`
// (viz package.json) — načte credentials z prostředí, ne ze souborů v repozitáři.
export default defineConfig({
  test: {
    include: [
      "tests/assistant-edge-function.test.ts",
      "tests/cover-function.integration.test.ts",
      "tests/google-ai-key.test.ts",
      "tests/private-accounts.test.ts",
      "tests/supabase-service-role.test.ts",
    ],
    exclude: ["node_modules/**", "supabase/functions/node_modules/**"],
    // Produkční provider odpovídá pomalu (Gemini + render), proto delší limit.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Jeden soubor po druhém: provider kvóty i přihlášení se neproudí paralelně.
    fileParallelism: false,
  },
});
