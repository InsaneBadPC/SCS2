import { describe, expect, it } from "vitest";

/**
 * Živý test LLM poskytovatele. Provider-neutral: neprovokuje se na konkrétním
 * dodavateli, ale na TOM, co reálně čte `supabase/functions/_shared/llm.ts`.
 *
 * Dřív tu byl test na `gemini-3.1-flash-lite` + `GOOGLE_AI_STUDIO_KEY` +
 * `generativelanguage.googleapis.com`. Po výměně poskytovatele je z toho
 * mrtvý kód: klíč je v produkci blokovaný (`API_KEY_SERVICE_BLOCKED`) a řetěz
 * v `_shared/llm.ts` Google používá až jako poslední záchrany. Test se proto
 * přejmenoval a přepsal na `OPENROUTER_API_KEY` / `NVIDIA_API_KEY` — stejný
 * základ, jiný provider, jiný base URL.
 *
 * Klíč se čte z proměnné prostředí, nikdy z repa. Bez něj se test přeskočí,
 * aby zelená barva nezastřela, že se vlastně nic neotestovalo.
 */

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY?.trim();
const NVIDIA_KEY = process.env.NVIDIA_API_KEY?.trim();
if (!OPENROUTER_KEY && !NVIDIA_KEY) {
  console.warn(
    "[přeskočeno] není nastavena OPENROUTER_API_KEY ani NVIDIA_API_KEY. " +
      "Klíče patří do prostředí, ne do repa — bez nich se test jen přeskočí.",
  );
}

// Pořadí musí odpovídat `PROVIDERS` v `_shared/llm.ts`. NVIDIA je první, protože
// bezplatný OpenRouter `:free` povrch je 50 požadavků denně na celý účet.
//
// Pozor: oba případy se MUSÍ registrovat i bez klíče (`it.skipIf`), jinak
// vitest skončí na „No test found in suite“ a neřekne, že se přeskočilo.
const targets = [
  { name: "NVIDIA NIM", base: "https://integrate.api.nvidia.com/v1", key: NVIDIA_KEY, model: "nvidia/nemotron-3-super-120b-a12b" },
  { name: "OpenRouter", base: "https://openrouter.ai/api/v1", key: OPENROUTER_KEY, model: "qwen/qwen3.8-27b:free" },
];

describe("LLM provider key", () => {
  for (const target of targets) {
    it.skipIf(!target.key)(`${target.name} authenticates a minimal text request`, async () => {
      const key = target.key!.trim();
      expect(key.length).toBeGreaterThan(20);

      const response = await fetch(`${target.base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "HTTP-Referer": "https://github.com/InsaneBadPC/songcraft-studio",
          "X-Title": "SongCraft Studio",
        },
        body: JSON.stringify({
          model: target.model,
          messages: [{ role: "user", content: "Odpověz pouze OK." }],
          max_tokens: 2000,
          ...(target.base.includes("nvidia") ? { reasoning_effort: "low" } : { reasoning: { max_tokens: 256 } }),
        }),
      });

      // 429 NENÍ chyba konfigurace klíče — bezplatná úroveň je denně omezená
      // (`x-ratelimit-limit=50` na celý účet). Klíč je v pořádku, jen vyčerpal
      // se kvóta, takže to nesmí shazovat test.
      if (response.status === 429) return;

      expect(response.ok, await response.text()).toBe(true);
    }, 120_000);
  }
});