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
  /** Krátský český přehled: kdo selhal a s jakým kódem. Bez klíčů a těla odpovědi. */
  readonly providerSummary: string;
  constructor(message: string, status: number, failures: string[], providerSummary = "") {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.failures = failures;
    this.providerSummary = providerSummary;
  }
}

/**
 * Vyčerpaný poskytovatel AŽ DO ČASU. Klíč k `x-ratelimit-reset`.
 *
 * Edge funkce běží v izolátu, takže přežije víc než jeden požadavek. Když
 * OpenRouter vrátí denní strop 0/50, je zbytečné zkoušet ho znovu do půlnoci
 * UTC u každého dalšího požadavku — a je to vlastní riziko: 5 modelů × 429
 * na každý pokus znamená pět zbytečných round-tripů, než řetěz dojde k záchrannému
 * klíči. Tady se to přeskočí rovnou.
 */
const exhaustedUntil = new Map<string, number>();

/** Po kolika milisekundách je 429 „reset na půlnoc“, ne „chybí mě“? */
const DAILY_CAP_HORIZON_MS = 5 * 60_000;

/**
 * Je to strop na ÚČET (denní limit `:free`), nebo přechodný limit na minutu?
 *
 * Rozlišení je zásadní a opačné než u obou poskytovatelů:
 *   OpenRouter `:free` → `429 free-models-per-day`, `x-ratelimit-reset` v
 *                         hodinách/dnech. Zkusit jiný model stejného klíče je
 *                         plýtvání, reset se nejde přečkat.
 *   NVIDIA               → obvykle krátký limit na minutu. Zkusit jiný model
 *                         JE smysluplné (jiná backendová kapacita), takže se
 *                         tady poskytovatel NEpřeskakuje.
 *
 * Bez tohoto rozlišení by buď zaplatili 5 zbytečných 429 na každý požadavek
 * (přeskakovat všechno), nebo by ztratili záchranný backend NVIDIA (nikdy).
 *
 * Exportované, protože `agent-orchestrator` má vlastní tool řetězec a musí se
 * chovat stejně — jinak by nástrojový požadavek zůstal na starém chování.
 */
export function classifyRateLimit(
  providerId: string,
  status: number,
  resetHeader: string | null,
  bodySnippet: string,
): "daily-cap" | "transient" | null {
  if (status !== 429) return null;
  const code = /"code"\s*:\s*"?([a-z0-9_-]+)/i.exec(bodySnippet)?.[1] ?? "";
  const daily = /per[-_]?day|daily|free[-_]?tier|insufficient[_-]?credits/i.test(`${code} ${bodySnippet}`);
  const reset = Number(resetHeader);
  const resetMs = Number.isFinite(reset) && reset > 1e11 ? reset : NaN;
  const farReset = Number.isFinite(resetMs) && resetMs - Date.now() > DAILY_CAP_HORIZON_MS;
  if (daily || farReset) {
    // `x-ratelimit-reset` bývá v ms. Rezerva 30 s, aby se na hranici nezkusilo
    // znovu a nebylo to zbytečné 429 navíc.
    const until = Number.isFinite(resetMs) ? resetMs + 30_000 : Date.now() + 10 * 60_000;
    exhaustedUntil.set(providerId, until);
    return "daily-cap";
  }
  return "transient";
}

/** Je tento poskytovatel právě vyčerpaný? (reset v minulosti = zkusit znovu.) */
export function isExhausted(providerId: string): boolean {
  const until = exhaustedUntil.get(providerId);
  if (!until) return false;
  if (until <= Date.now()) {
    exhaustedUntil.delete(providerId);
    return false;
  }
  return true;
}

/** Kdy je poskytovatel vyčerpaný a do kdy — pro hlášení, ne pro logování. */
export function exhaustedProviders(): { id: string; untilIso: string }[] {
  const now = Date.now();
  return [...exhaustedUntil.entries()]
    .filter(([, until]) => until > now)
    .map(([id, until]) => ({ id, untilIso: new Date(until).toISOString() }));
}

/**
 * Uživatelská hláška, která JMENUJE poskytovatele a stavové kódy.
 *
 * Proč to není kosmetika: klient dřív dostal „zkus to za chvíli“ u čtyř
 * různých selhání. Když je vyčerpaný denní limit `:free` na OpenRouteru,
 * „za chvíli“ lhát — reset je o půlnoci UTC, ne za třicet sekund. Bez názvu
 * poskytovatele se to taky nedá poznat.
 *
 * `base` je text specifický pro funkci (hledač rýmů, copywriter, asistent).
 * Vracejí se obě položky, protože stav musí být 502 ve všech případech kromě
 * `LlmError` se skutečným 429.
 */
export function llmFailureMessage(
  error: unknown,
  base: { unavailable: string; throttled: string },
): { message: string; status: number } {
  if (!(error instanceof LlmError)) return { message: base.unavailable, status: 502 };
  const status = error.status === 429 ? 429 : 502;
  const which = status === 429 ? base.throttled : base.unavailable;
  return {
    message: error.providerSummary ? `${which} Selhalo: ${error.providerSummary}.` : which,
    status,
  };
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
// účtu 2026-10-05 12:21 UTC (`x-ratelimit-*` hlavičky, viz report):
//
//   NVIDIA NIM              → HTTP 200, ŽÁDNÉ `x-ratelimit-*` hlavičky vůbec.
//                             Denní strop se neprojeví; jediné riziko je krátký
//                             limit na minutu, který je přechodný.
//   OpenRouter `:free`      → `x-ratelimit-limit: 50`, `remaining: 0`,
//                             `reset: 2026-10-06T00:00:00Z`. To je 50 POŽADAVKŮ
//                             NA DEN NAPŘIČ VŠEMI `:free` MODELY DOHROMADY —
//                             ne „limit na model". Chybová hláška to potvrzuje:
//                             `Rate limit exceeded: free-models-per-day`.
//                             Volání tedy vrací 429 s tělem a hlavičkou resetu.
//   OpenRouter záložní klíč → HTTP 200, žádné hlavičky limitu, tedy VLASTNÍ
//                             kvóta. Živě prokázáno, že funguje, i když je
//                             hlavní klíč na 0/50.
//
// Proto je NVIDIA PRVNÍ a OpenRouter až druhý. Původní plán (OpenRouter první)
// byl postaven na jednom 200 v okamžiku testu; to není udržitelný stav.
//
// `SONGCRAFT_LLM_PROVIDERS` umožňuje pořadí přepsat.
//
// PROČ V ŘETĚZU NENÍ ŽÁDNÝ BACKOFF
// -------------------------------
// Záměrně. Původní návrh počítal s „pauzou a zopakovat". U denního stropu
// `:free` je to bezpředmětné — reset je o půlnoci UTC, čekat před uživatelem
// hodinu kvůli 50 requestům na den neprojde. Retry by jen prodloužil odpověď
// z 1 s na 60 s a výsledek by byl stejný. Místo čekání je tu RYCHLÝ PRŮCHOD na
// dalšího poskytovatele (`classifyRateLimit` + `exhaustedUntil`):
//   denní strop   → přeskočit celý poskytovatel až do resetu, hned,
//   limit na minutu → zkusit další model téhož poskytovatele (jiná kapacita).
// Jediné čekání, které v kódu zůstalo, je zdvojnásobení rozpočtu na
// `content: null` v `agent-orchestrator`, což je chyba našeho požadavku, ne
// odmítnutí poskytovatelem.
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

/**
 * Nejmenší čas, který smí jeden poskytovatel v řetězu dostat, i když je
 * poskytovatelů víc a rozpočet by vyšel pod tohle. Bez podlahy by pět
 * poskytovatelů dostalo po 18 s a rozpočet 90 s by se rozdělil na směs
 * zbytečně krátkých pokusů. Naměřeno: záchranný OpenRouter klíč odpovídá
 * za ~9 s, takže podlaha musí být výrazně pod to.
 */
const MIN_PROVIDER_SLICE_MS = 12_000;
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
  opts: {
    temperature?: number;
    maxTokens?: number;
    json: boolean;
    timeoutMs: number;
    /** Přepíše `provider.extraBody` pro TENHLE pokus. `{}` = žádný knob. */
    providerExtraBody?: Record<string, unknown>;
  },
): Promise<{ ok: true; text: string } | { ok: false; status: number; note: string; rateLimit?: "daily-cap" | "transient" }> {
  const key = providerKey(provider);
  if (!key) return { ok: false, status: 0, note: "bez klíče" };

  const isGemini = provider.id === "gemini";
  const maxTokens = Math.max(64, (opts.maxTokens ?? 1024) + provider.reasoningCost);
  // `opts.providerExtraBody` je výslovný přepis, ne sloučení — volající chce
  // knob zrovna vypnout, ne přidat třetí.
  const knob = opts.providerExtraBody ?? provider.extraBody ?? {};
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
        ...knob,
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
      if (!response.ok) {
        // Tělo chyby čteme jen kvůli rozpoznání DENNÍHO stropu (`free-models-per-day`)
        // — nikoli proto, že by se vracelo uživateli. Klíče ani hlavičky s
        // limity se do hlášení nedostávají.
        let snippet = "";
        try {
          snippet = (await response.text()).slice(0, 300);
        } catch {
          snippet = "";
        }
        const rateLimit = classifyRateLimit(
          provider.id,
          response.status,
          response.headers.get("x-ratelimit-reset"),
          snippet,
        );
        const note = rateLimit === "daily-cap"
          ? `HTTP ${response.status} denní limit free modelů vyčerpán`
          : `HTTP ${response.status}`;
        return rateLimit
          ? { ok: false as const, status: response.status, note, rateLimit }
          : { ok: false as const, status: response.status, note };
      }
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
  // 400 je chyba JEDNOHO modelu (ostatní ho třeba znají) — proto se tady nekončí.
  if (!sent.ok && sent.status === 400 && opts.json && !isGemini) {
    delete body.response_format;
    sent = await send();
  }
  if (!sent.ok) {
    const failure = {
      ok: false as const,
      status: sent.status,
      note: sent.note,
      ...(sent.rateLimit ? { rateLimit: sent.rateLimit } : {}),
    };
    return failure;
  }

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
  /**
   * Přepíše tělo specifické pro poskytovatele na TENHLE POŽADAVEK.
   * `{}` = poslat žádný knob.
   *
   * Proč to existuje: `reasoning_effort: "low"` na NVIDIA je výhodné pro text
   * (naměřeno 530 → 19 reasoning tokenů), ale u `songcraft-rhymes` s jeho
   * dlouhým fonologickým zadáním škodí. Naměřeno živě 2026-10-05, stejný
   * prompt, jen jiný knob:
   *   `reasoning_effort:"low"` → 43 s, `finish_reason:"length"`, `content: null`
   *                              (model přemýšlel, dokud mu neshořel rozpočet)
   *   žádný knob              → 34 s, `finish_reason:"stop"`, reálný obsah
   *                            („staré klece“, „zlaté svíce“ — což ke „srdce“
   *                             skutečně rýmuje)
   * Tedy: knob, který zkracuje reasoning, může u konkrétního dotazu naopak
   * nechat model přemýšlet déle. Proto se to nesmí cpát do provider configu
   * natvrdo, ale řídí se to u volajícího.
   */
  providerExtraBody?: Record<string, unknown>;
}): Promise<LlmResult> {
  const json = opts.json === true;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const history = toLlmMessages(opts.messages ?? []);
  const messages: LlmMessage[] = opts.system && opts.system.trim() ? [{ role: "system", content: opts.system }, ...history] : history;

  if (!messages.length) throw new LlmError("Žádná zpráva pro AI.", 502, []);

  const deadline = Date.now() + timeoutMs;
  const failures: string[] = [];
  /** Poskytovatel → poslední relevantní HTTP kód. Pro české hlášení na 502/429. */
  const statusByProvider = new Map<string, number>();
  let keyedAttempts = 0;
  let rateLimitAttempts = 0;

  const attempts: Attempt[] = [];
  for (const preferred of opts.prefer ?? []) attempts.push(preferred);

  const chain = providerOrder();
  const keyless = chain.filter((provider) => !providerKey(provider));
  for (const provider of keyless) failures.push(`${provider.id}: bez klíče`);

  // Počet poskytovatelů, kteří se ještě pokusí. Společný rozpočet se mezi ně
  // dělí, aby visící poskytovatel nesežral celý čas a řetěz se nedostal k záchrannému.
  const usableChain = chain.filter((provider) => providerKey(provider));

  for (let providerIndex = 0; providerIndex < usableChain.length; providerIndex += 1) {
    const provider = usableChain[providerIndex];
    // DENNÍ strop z předchozího požadavku v tomto izolátu. Přeskočit je
    // správné — reset je vypočitatelný, ne něco, co by se dalo přečkat.
    if (isExhausted(provider.id)) {
      failures.push(`${provider.id}: denní limit vyčerpán (přeskočeno do resetu)`);
      continue;
    }
    const preferred = attempts.filter((a) => a.provider === provider.id);
    const models = [...preferred.map((a) => a.model), ...provider.models.filter((m) => !preferred.some((p) => p.model === m))];

    // ------------------------------------------------------------------------
    // ROZPOČET NA JEDEN POSKYTOVATELA, ne na celý řetěz.
    //
    // Naměřeno 2026-10-05 na `songcraft-rhymes`: NVIDIA vrátil na první model
    // 503 za 0,5 s a na DALŠÍ DVA visel. Když měl každý pokus svých 70 s, se
    // celých 135 s spotřebovalo na NVIDIA a řetěz se NEDOSTAL k záchrannému
    // OpenRouter klíči, který odpovídá za 8,6 s. Uživatel dostal 502, i když
    // byla dostupná funkční záloha.
    //
    // Proto se zbývající čas dělí mezi poskytovatele, kteří ještě zbývají, a
    // minimum je malý — jinak by jeden pomalý poskytovatel ořízl všechny
    // ostatní. Chyba se zapíše do hlášení, takže je v české chybě vidět.
    // ------------------------------------------------------------------------
    const providersLeft = usableChain.length - providerIndex;
    const sliceMs = Math.max(
      MIN_PROVIDER_SLICE_MS,
      Math.floor((deadline - Date.now()) / providersLeft),
    );
    const providerEnd = Math.min(deadline, Date.now() + sliceMs);

    for (const model of models) {
      const left = deadline - Date.now();
      if (left <= 2_000) {
        failures.push(`${provider.id}/${model}: vypršel společný časový limit`);
        break;
      }
      // Tento poskytovatel si vyčerpal podíl. Další modely už nejsou v jeho
      // ceně — jdeme na další poskytovatele, ne do jeho třetího modelu.
      if (Date.now() >= providerEnd) {
        failures.push(`${provider.id}: vypršel časový podíl poskytovatele (přeskočeno na dalšího)`);
        break;
      }
      const result = await callProvider(provider, model, messages, {
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        json,
        timeoutMs: Math.min(Math.min(timeoutMs, left), providerEnd - Date.now()),
        providerExtraBody: opts.providerExtraBody,
      });
      if (result.ok) return { text: result.text, provider: provider.id, model };
      keyedAttempts += 1;
      if (result.status === 429) rateLimitAttempts += 1;
      // Zapisuje se i stav 0 (timeout/síť), jinak by se poskytovatel, který
      // spadl časem, v české chybě vůbec neobjevil.
      statusByProvider.set(provider.id, result.status);
      failures.push(`${provider.id}/${model}: ${result.note}`);

      // Přechodný 429 (limit na minutu) se NEpřeskakuje — jiný model téhož
      // poskytovatele běží na jiné backendové kapacitě a často vrátí 200
      // (naměřeno: NVIDIA po krátkém tlaku na jednom modelu).
      if (result.rateLimit === "daily-cap") {
        failures.push(`${provider.id}: denní limit, další modely téhož klíče přeskočeny`);
        break;
      }
    }
  }

  // 429 KLIENTOVI jen když opravdu vyšla ruka všem poskytovatelům s klíčem a
  // všichni řekli 429. Dřív to bylo „někde někde byl 429" — takže jediná
  // síťová chyba na NVIDIA překryla 429 z vyčerpaného OpenRouteru a uživatel
  // dostal „zkus to za chvíli" kvůli cizímu dennímu stropu. Navíc čekání
  // nepomůže: reset je o půlnoci UTC, ne za třicet sekund.
  const status = keyedAttempts > 0 && rateLimitAttempts === keyedAttempts ? 429 : 502;
  const summary = failures.join(" | ") || "žádný poskytovatel nebyl dostupný";
  throw new LlmError(
    `AI poskytovatelé selhali (${summary}).`,
    status,
    failures,
    providerSummary(statusByProvider),
  );
}

/**
 * `nvidia: 503, openrouter-backup: vypršel čas` — jména a příčiny, žádné klíče
 * a žádné tělo odpovědi. Stav 0 znamená timeout nebo síťovou chybu, ne HTTP kód,
 * takže se píše slovy; bez toho by se poskytovatel, který spadl časem, v hlášení
 * vůbec neobjevil.
 */
function providerSummary(statusByProvider: Map<string, number>): string {
  if (!statusByProvider.size) return "";
  return [...statusByProvider.entries()]
    .map(([id, status]) => {
      if (status === 0) return `${id}: vypršel čas nebo síťová chyba`;
      if (status === 429 && isExhausted(id)) return `${id}: 429 denní limit`;
      return `${id}: ${status}`;
    })
    .join(", ");
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