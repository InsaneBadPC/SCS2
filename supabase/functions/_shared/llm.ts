// =============================================================================
// _shared/llm.ts — provider-neutral LLM vrstva pro SongCraft Studio
// =============================================================================
//
// PROČ TENTO SOUBOR EXISTUJE
// ---------------------------
// Před swapem byla Gemini HTTP volání ZDUPLIKOVANÁ na 5 místech ve 4 edge
// funkcích (viz llm-map.md §2). Každá kopie měla vlastní Gemini-only tělo
// (`systemInstruction`, `contents[].parts[]`, `role:"model"`,
// `thinkingConfig.thinkingLevel`) a žádná z nich neměla timeout. Tento modul
// sbírá to na jedno místo a mluví jedním interním tvarem.
//
// CO TENTO MODUL NEDĚLÁ (a proč)
// ------------------------------
// 1) NEZNÁ VENDORA. Interní tvar je OpenAI (`{role, content}`), protože je to
//    jediný tvar, kterému rozumí OpenRouter i NVIDIA i (případně) Gemini.
// 2) NEŘEŠÍ TOOL CALLING / VISION. Agent-orchestrator má vlastní `PROVIDERS`
//    řetězec a Gemini-native function calling; to je mimo tento soubor.
// 3) NELEPÍ ŠPATNÝ JSON. `llmComplete` vrátí surový text. Volající si ponechá
//    vlastní fence-strip + `/\{[\s\S]*\}/` + `JSON.parse` řetězec, protože
//    bezplatné modely JSON lámejí a regex je jediná pojistka.
//
// GEMINI-ONLY FEATURE Z MAPY §3 — CO S NIMI JE
// ---------------------------------------------
//   systemInstruction        → {role:"system"} zpráva (přes `opts.system`)
//   contents[].parts[]       → flatten na `content` string (normaliZACE níže)
//   role:"model"             → {role:"assistant"} (normaliZace + refaktor volající)
//   thinkingConfig.level     → SMAZÁNO. Nemá ekvivalent; posílá se jako
//                             `reasoning` parametr poskytovateli, ne jako
//                             průchod původního Gemini pole.
//   responseMimeType:json    → response_format, s fallbackem na regex řetězec
//   inlineData (obrázky)     → MIMO SCOPE. Viz `LLM_VISION_MODEL` níže.
//
// DVA POZOROVÁNÍ Z TESTOVÁNÍ, KTERÁ TENTO KÓD OBDĚLÁ OBOU SLUŽEB
// --------------------------------------------------------------
// A) `content: null` JE NENÍ NĚJAKÝ ZMRZLOVÝ SERVER. Reasoning modely
//    (gpt-oss-20b, nemotron, ling) si z `max_tokens` STRŽÍ reasoning tokeny.
//    Když reasoning sežere celý rozpočet, provider vrátí 200 +
//    `finish_reason:"length"` + `message.content === null`. Bez guardu by to
//    vypadalo jako "AI nevrátila platný výsledek" po 45 s čekání. Proto:
//    (1) reasoning dostává vlastní podíl rozpočtu (`reasoningBudgetTokens`),
//    (2) `null` content je POVAŽOVÁN ZA SELHÁNÍ POKUSU, ne za výsledek.
//
// B) BEZPLATNÉ MODELY VRACEJÍ PSEUDOSLOVA. Viz `llmConfigSummary()` a report:
//    "kloc", "přemoc", "trok" jsou vymyšlené, ne česká slova. To NELZE opravit
//    na klientovi; proto `hasCzechPhonologyRisk` v `llmConfigSummary()`.
//
// CO JE ZMĚNĚNO OPROTI PŮVODNÍMU CHOVÁNÍ (aby to nikdo nepřehlédl)
// ---------------------------------------------------------------
// Původní 3 funkce NEMĚLY timeout (`AbortSignal.timeout`). To je visící
// požadavek, ne kosmetika — proto je tady `timeoutMs` s rozumným defaultem.
// =============================================================================

export type LlmMessage = { role: "system" | "user" | "assistant"; content: string };
export type LlmResult = { text: string; provider: string; model: string };

// Chyba, která nese HTTP status posledního skutečného pokusu. Volající na ní
// dál staví mapování 429 → 429, jinak 502, které už v repu je (llm-map §8.2).
export class LlmError extends Error {
  readonly status: number;
  readonly failures: string[];
  constructor(message: string, status: number, failures: string[]) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.failures = failures;
  }
}

// `message.content` může být i pole (multimodal) — tady se to NENÍ potřebuje,
// ale abychom nehrozili `TypeError` na cizím kódu, bereme to bezpečně.
type RawMessage = { role?: unknown; content?: unknown; parts?: unknown };

type ProviderCfg = {
  id: string;
  base: string;
  models: string[];
  /** Staré i nové názvy proměnných; první neprázdná vyhrává. */
  keyEnvs: string[];
  /** Doplňkové tělo požadavku specifické pro poskytovatele. */
  extraBody?: Record<string, unknown>;
  /** Kolik tokenů potřebuje reasoning vedle odpovědi (0 = neřešíme to). */
  reasoningCost: number;
  /** Modely, co umí `image_url` — viz `LLM_VISION_MODEL`. */
  visionModels?: string[];
};

// PŘÍKAZ ŘETĚZU NENÍ ĽIBOVOLNÝ A JE ZMĚNĚN Oproti plánu. Změřeno na živém
// účtu 2026-10-05 (`x-ratelimit-*` hlavičky, viz report):
//
//   OpenRouter, 0 kreditů  → `x-ratelimit-limit=50` REQUESTS/NA DEN, napříč
//                             VŠEMI `:free` modely dohromady. Ne "limit na
//                             model", ale celý účet. Po 50 požadavcích je
//                             celý `:free` povrch 429 do půlnoci UTC.
//   NVIDIA NIM              → funguje bez denního stropu, ale drží `reasoning`.
//
// Proto je NVIDIA PRVNÍ a OpenRouter až druhý. Původní plán (OpenRouter první)
// byl postaven na jednom 200 v okamžiku testu; to není udržitelný stav.
//
// `SONGCRAFT_LLM_PROVIDERS` umožňuje pořadí přepsat.
const PROVIDERS: ProviderCfg[] = [
  {
    id: "nvidia",
    base: "https://integrate.api.nvidia.com/v1",
    keyEnvs: ["NVIDIA_API_KEY", "NVAPI_API_KEY"],
    models: [
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "openai/gpt-oss-20b",
    ],
    // NVIDIA `reasoning: {max_tokens}` IGNORUJE (testováno — reasoning sežere
    // celý `max_tokens` a vrátí se `content: null`). Její vlastní knoflík je
    // `reasoning_effort`, který reasoning tokeny opravdu zkracuje (530 → 19).
    extraBody: { reasoning_effort: "low" },
    // `reasoning_effort: "low"` reasoning zkracuje, ne odstraňuje. Bez rezervy
    // sežere odpověď — naměřeno živě: popisek skončil uprostřed slova
    // („…sprcha z lou“) a odpověď asistenta na „Pokud chceš upravit dé“.
    reasoningCost: 768,
    visionModels: [
      "meta/llama-3.2-90b-vision-instruct",
      "microsoft/phi-3-vision-128k-instruct",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    ],
  },
  {
    id: "openrouter",
    base: "https://openrouter.ai/api/v1",
    keyEnvs: ["OPENROUTER_API_KEY", "SONGCRAFT_OPENROUTER_API_KEY"],
    models: [
      "nvidia/nemotron-3-super-120b-a12b:free",
      "google/gemma-4-31b-it:free",
      "google/gemma-4-26b-a4b-it:free",
      "qwen/qwen3.8-27b:free",
      "liquid/lfm-2.5-2.6b:free",
    ],
    // Tady `reasoning: {max_tokens}` funguje a je to JEDINÝ způsob, jak se
    // vyhnout `content: null` — bez stropu většina bezplatných modelů vrátí
    // 200 + `finish_reason:"length"` + prázdný text.
    extraBody: { reasoning: { max_tokens: 1024 } },
    reasoningCost: 1024,
  },
  {
    // Druhý klíč = poslední záchrana. Je 429-throttled jinak (chyba je
    // „temporarily rate-limited upstream“, ne `free-models-per-day`), takže
    // obvykle ještě něco vrátí, když hlavní klíč spadl.
    id: "openrouter-backup",
    base: "https://openrouter.ai/api/v1",
    keyEnvs: ["OPENROUTER_API_KEY_BACKUP", "SONGCRAFT_OPENROUTER_API_KEY_BACKUP"],
    models: ["nvidia/nemotron-3-super-120b-a12b:free", "google/gemma-4-31b-it:free"],
    extraBody: { reasoning: { max_tokens: 1024 } },
    reasoningCost: 1024,
  },
  {
    // Záchrana, ne plán. Klíč je v produkci blokovaný (`API_KEY_SERVICE_BLOCKED`)
    // a majitel to uzavřel; tento záznam existuje jen, aby se řetěz nerozbil,
    // kdyby klíč někdy byl. V `providerOrder()` je až poslední.
    id: "gemini",
    base: "https://generativelanguage.googleapis.com/v1beta",
    keyEnvs: ["GOOGLE_AI_STUDIO_KEY", "GEMINI_API_KEY"],
    models: ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-flash-lite-latest"],
    reasoningCost: 0,
  },
];

// Žádný model v tomto řetězu neumí přijmout `image_url` data URL. Viz níže.
export const LLM_VISION_MODEL: string | null = null;

export const LLM_VISION_NOTE =
  "Modely v tomto řetězu jsou textové a `image_url` nevezmou. " +
  "Plán pohybu z obrázku potřebuje vidoucí model (např. NVIDIA " +
  "meta/llama-3.2-90b-vision-instruct) a musí se zkontrolovat přes " +
  "`llmConfigSummary()`, ne předpokládat.";

const DEFAULT_TIMEOUT_MS = 90_000;
// Volající `maxTokens` je rozpočet pro ODPOVĚŎ. Reasoning si bere navíc, jinak
// u reasoning modelů vytlačí odpověď (viz poznámka A nahoře). Na OpenRouter je
// to `reasoning.max_tokens` (viz `reasoningCost`), NVIDIA si to řídí sama přes
// `reasoning_effort` a `reasoningCost` je tam 0.

function env(name: string): string | undefined {
  const value = Deno.env.get(name);
  return value && value.trim() ? value.trim() : undefined;
}

function providerKey(provider: ProviderCfg): string | undefined {
  for (const name of provider.keyEnvs) {
    const value = env(name);
    if (value) return value;
  }
  return undefined;
}

/**
 * Pořadí poskytovatelů. `SONGCRAFT_LLM_PROVIDERS` přepíše výchozí pořadí;
 * neznámé id se tiše přeskočí, nezlomí řetěz.
 */
function providerOrder(): ProviderCfg[] {
  const override = env("SONGCRAFT_LLM_PROVIDERS");
  if (!override) return PROVIDERS;
  const wanted = override.split(",").map((id) => id.trim()).filter(Boolean);
  if (!wanted.length) return PROVIDERS;
  const picked = wanted
    .map((id) => PROVIDERS.find((provider) => provider.id === id))
    .filter((provider): provider is ProviderCfg => Boolean(provider));
  return picked.length ? picked : PROVIDERS;
}

/**
 * Normalizuje cizí (i Gemini-tvarované) zprávy na OpenAI tvar.
 *
 * - `role:"model"` → `"assistant"` (llm-map §8.3 — bez toho se minulé odpovědi
 *   asistenta v historii rozsypou).
 * - `parts:[{text}]` (Gemini `contents[].parts[]`) se flattenne na string.
 * - prázdný obsah se zahazuje, aby to nebyl prázdný turn.
 */
export function toLlmMessages(input: Array<LlmMessage | RawMessage>): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const item of input) {
    const raw = item as RawMessage;
    let role: LlmMessage["role"] = raw.role === "assistant" || raw.role === "model" ? "assistant" : raw.role === "system" ? "system" : "user";
    let content = typeof raw.content === "string" ? raw.content : "";
    if (!content && Array.isArray(raw.parts)) {
      content = (raw.parts as Array<{ text?: unknown }>)
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("")
        .trim();
    }
    if (!content) continue;
    // `system` smí být jen jako úvodní zpráva; pořadí v OpenAI je přísné.
    if (role === "system") {
      if (out.length) role = "user";
      else out.push({ role: "system", content });
      continue;
    }
    out.push({ role, content });
  }
  if (out.length && out[0].role !== "system") return out;
  return out;
}

type Attempt = { provider: string; model: string };

async function callProvider(
  provider: ProviderCfg,
  model: string,
  messages: LlmMessage[],
  opts: { temperature?: number; maxTokens?: number; json: boolean; timeoutMs: number },
): Promise<{ ok: true; text: string } | { ok: false; status: number; note: string }> {
  const key = providerKey(provider);
  if (!key) return { ok: false, status: 0, note: "bez klíče" };

  const isGemini = provider.id === "gemini";
  const maxTokens = Math.max(64, (opts.maxTokens ?? 1024) + provider.reasoningCost);
  const body: Record<string, unknown> = isGemini
    ? {
        systemInstruction: { parts: [{ text: messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n") }] },
        contents: messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        generationConfig: { temperature: opts.temperature ?? 0.7, maxOutputTokens: opts.maxTokens ?? 1024 },
      }
    : {
        model,
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: maxTokens,
        ...(provider.extraBody ?? {}),
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (isGemini) headers["x-goog-api-key"] = key;
  else {
    headers.Authorization = `Bearer ${key}`;
    // OpenRouter je doporučuje pro atribuci; NVIDIA je ignoruje (a `HTTP-Referer`
    // je navíc legitimní hlavička, takže to není CORS/proxy problém).
    headers["HTTP-Referer"] = "https://github.com/InsaneBadPC/songcraft-studio";
    headers["X-Title"] = "SongCraft Studio";
  }

  const send = async () => {
    try {
      const response = await fetch(`${provider.base}/${isGemini ? `models/${encodeURIComponent(model)}:generateContent` : "chat/completions"}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (!response.ok) return { ok: false as const, status: response.status, note: `HTTP ${response.status}` };
      return { ok: true as const, response };
    } catch (error) {
      // Timeout je visící požadavek, ne výsledek — vždy zkus další poskytovatele.
      const aborted = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return { ok: false as const, status: 0, note: aborted ? "vypršel časový limit" : "síťová chyba" };
    }
  };

  let sent = await send();
  // Některé bezplatné modely `response_format` vůbec neznají (400). Regex řetězec
  // u volajícího je záloha, takže to není ztráta funkčnosti — jen 400 navíc.
  if (!sent.ok && sent.status === 400 && opts.json && !isGemini) {
    delete body.response_format;
    sent = await send();
  }
  if (!sent.ok) return { ok: false, status: sent.status, note: sent.note };

  let payload: Record<string, unknown>;
  try {
    payload = await sent.response.json() as Record<string, unknown>;
  } catch {
    return { ok: false, status: 0, note: "nečitelná odpověď" };
  }

  if (isGemini) {
    const candidates = (payload.candidates ?? []) as Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
    const text = candidates[0]?.content?.parts
      ?.map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("\n")
      .trim() ?? "";
    return text ? { ok: true, text } : { ok: false, status: 0, note: "prázdná odpověď" };
  }

  const choices = (payload.choices ?? []) as Array<{
    finish_reason?: unknown;
    message?: { content?: unknown; reasoning?: unknown };
  }>;
  const choice = choices[0];
  const message = choice?.message ?? {};
  const content = typeof message.content === "string" ? message.content.trim() : "";
  if (content) return { ok: true, text: content };

  // `content: null` + `finish_reason:"length"` = reasoning sežral rozpočet.
  // Bereme to jako selhání POKUSU, ne jako prázdný výsledek, a jdeme dál.
  const finish = typeof choice?.finish_reason === "string" ? choice.finish_reason : "neznámé";
  const reasoning = typeof message.reasoning === "string" && message.reasoning ? " (reasoning)" : "";
  return { ok: false, status: 0, note: `bez textu, finish=${finish}${reasoning}` };
}

/**
 * Zavolá LLM přes poskytovatelský řetěz a vrátí první neprázdný výsledek.
 *
 * Při selhání každého (poskytovatel, model) se shromažďuje důvod a nakonec
 * se vyhodí JEDNA chyba, která jmenuje poskytovatele a příčiny — žádné klíče.
 */
export async function llmComplete(opts: {
  system?: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  json?: boolean;
  /** Volitelné modely ZKOUŠENÉ PŘED výchozím řetězem (každá funkce má jiný). */
  prefer?: Attempt[];
}): Promise<LlmResult> {
  const json = opts.json === true;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const history = toLlmMessages(opts.messages ?? []);
  const messages: LlmMessage[] = opts.system && opts.system.trim() ? [{ role: "system", content: opts.system }, ...history] : history;

  if (!messages.length) throw new LlmError("Žádná zpráva pro AI.", 502, []);

  const deadline = Date.now() + timeoutMs;
  const failures: string[] = [];
  let sawRateLimit = false;

  const attempts: Attempt[] = [];
  for (const preferred of opts.prefer ?? []) attempts.push(preferred);

  const chain = providerOrder();
  for (const provider of chain) {
    if (!providerKey(provider)) {
      failures.push(`${provider.id}: bez klíče`);
      continue;
    }
    const preferred = attempts.filter((a) => a.provider === provider.id);
    const models = [...preferred.map((a) => a.model), ...provider.models.filter((m) => !preferred.some((p) => p.model === m))];
    for (const model of models) {
      // `timeoutMs` je rozpočet CELÉHO řetězu, ne jednoho pokusu. Bez toho
      // devět pokusů po 90 s = visící požadavek na 13 minut, což je přesně ta
      // věc, kterou původní tři funkce měly (a měly ji chybně — neměly timeout
      // vůbec). Když rozpočet dojde, jdeme dál, ne čekáme.
      const left = deadline - Date.now();
      if (left <= 2_000) {
        failures.push(`${provider.id}/${model}: vypršel společný časový limit`);
        break;
      }
      const result = await callProvider(provider, model, messages, {
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        json,
        // Na konci řetězu nesmí jediný pokus sníst celý rozpočet.
        timeoutMs: Math.min(timeoutMs, left),
      });
      if (result.ok) return { text: result.text, provider: provider.id, model };
      if (result.status === 429) sawRateLimit = true;
      failures.push(`${provider.id}/${model}: ${result.note}`);
    }
  }

  // 429 jen tehdy, když 429 přišlo z poskytovatele. Timeout a "bez klíče" jsou
  // naše chyby, ne vyčerpaný limit uživatele — jinak by klient dostal 429
  // za vlastní výpadek.
  const status = sawRateLimit ? 429 : 502;
  const summary = failures.join(" | ") || "žádný poskytovatel nebyl dostupný";
  throw new LlmError(`AI poskytovatelé selhali (${summary}).`, status, failures);
}

/** Má aspoň jeden poskytovatel klíč? Volající z toho dělá 503 „není nakonfigurován“. */
export function hasLlmKey(): boolean {
  return PROVIDERS.some((provider) => Boolean(providerKey(provider)));
}

/**
 * Přehled konfigurace pro orchestrátor a debug. `visionModels` je tu schválně:
 * plán pohybu z obrázku potřebuje vidoucí model a agent si to musí OVĚŘIT,
 * ne předpokládat (viz `LLM_VISION_MODEL`).
 */
export function llmConfigSummary(): {
  id: string;
  base: string;
  models: string[];
  hasKey: boolean;
  visionModels: string[];
}[] {
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    base: provider.base,
    models: provider.models,
    hasKey: Boolean(providerKey(provider)),
    visionModels: provider.visionModels ?? [],
  }));
}