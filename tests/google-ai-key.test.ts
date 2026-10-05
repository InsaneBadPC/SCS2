import { describe, expect, it } from "vitest";

const model = "gemini-3.1-flash-lite";

/**
 * Klíč se čte z proměnné prostředí, nikdy z repa. Bez něj se test přeskočí,
 * aby zelená barva nezastřela, že se vlastně nic neotestovalo — stejně jako
 * u `cover-function.integration.test.ts`. Bez této větve spadla kontrola
 * `expect(apiKey?.trim().length)` na `TypeError: actual value must be number`
 * a `pnpm test:live` končil chybou místo přeskočení.
 */
const apiKey = process.env.GOOGLE_AI_STUDIO_KEY?.trim();
if (!apiKey) {
  console.warn(
    "[přeskočeno] není nastavena proměnná GOOGLE_AI_STUDIO_KEY. " +
      "Klíč patří do prostředí, ne do repa — bez ní se test jen přeskočí.",
  );
}

describe("Google AI Studio key", () => {
  it.skipIf(!apiKey)("authenticates a minimal Gemini text request", async () => {
    // Google AI Studio supports current AQ… keys in addition to older AIza… keys.
    expect(apiKey!.length).toBeGreaterThan(20);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Odpověz pouze OK." }] }],
          generationConfig: { maxOutputTokens: 8 },
        }),
      },
    );

    expect(response.ok, await response.text()).toBe(true);
  }, 30_000);
});
