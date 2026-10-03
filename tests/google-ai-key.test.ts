import { describe, expect, it } from "vitest";

const model = "gemini-3.1-flash-lite";

describe("Google AI Studio key", () => {
  it("authenticates a minimal Gemini text request", async () => {
    const apiKey = process.env.GOOGLE_AI_STUDIO_KEY;
    // Google AI Studio supports current AQ… keys in addition to older AIza… keys.
    expect(apiKey?.trim().length).toBeGreaterThan(20);

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
