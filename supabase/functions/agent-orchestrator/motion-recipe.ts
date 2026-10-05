// Plán pohybu z obrázku + promptu uživatele.
//
// Volá vidoucí (vision) model, dostane obrázek a text "co na obrázku rozpohybovat",
// a vrátí JSON recept, co přesně se má hýbat. Bez toho bychom měli jednu
// šablonu pro všechny fotky — a to je přesně to, co uživatel nechce.
//
// Nic se nevymýšlí navíc: pokud uživatel neřekne "kouř", recept neobsahuje
// kouř. Jediné, co se přidává automaticky, je pomalý celkový nájezd
// (background.push), protože jinak je to statický snímek.
//
// PŘEHODNUTO NA OpenAI TVAR (llm-map §3.6 a §3.7)
// ----------------------------------------------
// Původně to byla Gemini-only větev: `inlineData` + `responseMimeType:"application/json"`.
// Dnes je to `/v1/chat/completions` s `content:[{type:"image_url",...}]` a
// `response_format:{type:"json_object"}`. DVA Gemini-ismy zmizely a jsou nahrazené:
//
//   inlineData (base64 obrázek)  → image_url data URL   (`toDataUrl`)
//   responseMimeType json         → response_format + PONECHAVÝ regex řetězec
//
// `response_format` je prosba, ne záruka: bezplatné modely ho často neznají (400)
// nebo JSON stejně lámejí. Proto `safeJson()` (fence strip → první `{`…poslední `}` →
// JSON.parse) pořád existuje a je jediná pojistka. `sanitizeRecipe()` navíc
// fail-closed odhazuje všechno, co renderer neumí vykreslit.
//
// VISION BYLO ZMĚŘENO, NE ODHADNUTO (viz report, 2026-10-05)
// -------------------------------------------------------
// Volání modelu s `image_url` na textovém modelu není chyba kód, je to 400/415
// nebo (horší) tichý nesmysl. Změřeno přímo na obrázku 128×128 (levá půl červená,
// pravá modrá, uprostřed bílý kruh):
//   nvidia/meta/llama-3.2-90b-vision-instruct  → 200, správně "red/blue/circle"
//   nvidia/meta/llama-3.2-11b-vision-instruct  → 200, správně
//   nvidia/microsoft/phi-3-vision-128k-instruct → 404 (na tomhle účtu neexistuje)
// NVIDIA nemá denní strop, takže je to primární zdroj vidění.

const RECIPE_SYSTEM = `You write MOTION RECIPES for still images.

You get one image and one instruction from the user describing WHAT should move in
that image. You look at the image, find that thing, and return a JSON recipe.

RULES
- Move ONLY what the user asked for. If they did not mention smoke, there is no smoke.
- Never invent effects. No random flashes, no spinning random objects, no bokeh,
  no rain. The user decides.
- Find the thing the user means. If they say "the wheel", locate the wheel in THIS image.
- Use normalized coordinates 0..1: [x0, y0, x1, y1] = left, top, right, bottom.
- Keep the region tight around the object, with a small margin.
- anchor is the rotation centre. For a wheel, a fan, a clock hand: its pivot. For
  anything else, the region centre.
- If the user's instruction cannot be satisfied by anything visible in the image,
  return elements: [] and explain in "note". Do not substitute a different object.

MOTION TYPES
- rotate  : spinning/turning things. degrees 360 = exactly one full turn per cycle
            (this loops seamlessly). cycles = how many turns in the scene.
- blink   : lights, flames, glow, screens, reflections going on and off.
            sharpness 0.15 = slow glow, 0.6 = hard flicker.
- breathe : slow subtle scale pulse - a chest, a shoulder, a fabric.
            amplitude 0.01-0.03. Keep it small or it looks fake.
- sway    : gentle drifting side to side - hair, cards, a hanging chain, smoke-soft cloth.
- pulse   : scale AND brightness together - a glow building.
- i2v     : organic motion that only a video model can do (a blink of an eye,
            breathing of a face). Set motion.prompt to a short English description
            for an image-to-video model. Use sparingly.

CYCLES: a movement with N cycles per scene must complete a whole number of cycles
so the loop is seamless. Use 1-3.

OUTPUT: JSON only, no prose, no markdown fence. Exactly this shape:
{
  "version": 2,
  "shot_seconds": 6,
  "push": 0.05,
  "note": "why you chose this, one short sentence",
  "elements": [
    {
      "what": "short name of the thing, e.g. wheel at bottom centre",
      "region": [0.40, 0.78, 0.54, 0.99],
      "anchor": [0.47, 0.88],
      "mask": "auto",
      "motion": { "type": "rotate", "degrees": 360, "cycles": 1, "sharpness": 0.3, "amplitude": 0.02, "prompt": "" }
    }
  ]
}
"push" is 0.03-0.09: a very slow whole-image push so the frame is not frozen.`;

export const MOTION_TYPES = new Set([
  "rotate",
  "blink",
  "breathe",
  "sway",
  "pulse",
  "i2v",
]);

type Raw = Record<string, unknown>;

function num(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function region(v: unknown): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const r = v.map((x) => num(x, -0.2, 1.2, NaN));
  if (r.some((x) => !Number.isFinite(x))) return null;
  const [x0, y0, x1, y1] = r as number[];
  if (!(x0 < x1) || !(y0 < y1)) return null;
  return [x0, y0, x1, y1];
}

/** Vyčistí to, co model vrátil, na tvar, kterému renderer rozumí.
 *  fail-closed: prázdný prvek nebo neznámý pohyb = vyhozený, ne házený dál. */
export function sanitizeRecipe(
  raw: unknown,
): { recipe: Record<string, unknown> | null; reason?: string } {
  const obj = (typeof raw === "string" ? safeJson(raw) : raw) as Raw | null;
  if (!obj || typeof obj !== "object") {
    return { recipe: null, reason: "model nevrátil objekt" };
  }
  const list = Array.isArray(obj.elements) ? obj.elements : [];
  const elements: Record<string, unknown>[] = [];
  const rejected: string[] = [];
  for (const e of list) {
    if (!e || typeof e !== "object") {
      rejected.push("prvek není objekt");
      continue;
    }
    const el = e as Raw;
    const reg = region(el.region);
    if (!reg) {
      rejected.push(`chybí region: ${String(el.what ?? "?")}`);
      continue;
    }
    const m = (el.motion ?? {}) as Raw;
    const type = String(m.type ?? "");
    if (!MOTION_TYPES.has(type)) {
      rejected.push(`neznámý pohyb ${type}`);
      continue;
    }
    const anchorRaw = Array.isArray(el.anchor) ? el.anchor : null;
    const anchor: [number, number] = anchorRaw && anchorRaw.length === 2
      ? [
        num(anchorRaw[0], 0, 1, (reg[0] + reg[2]) / 2),
        num(anchorRaw[1], 0, 1, (reg[1] + reg[3]) / 2),
      ]
      : [(reg[0] + reg[2]) / 2, (reg[1] + reg[3]) / 2];
    elements.push({
      what: String(el.what ?? "prvek").slice(0, 120),
      region: reg,
      anchor,
      mask: el.mask === "rect" ? "rect" : "auto",
      motion: {
        type,
        degrees: num(m.degrees, -720, 720, 360),
        cycles: Math.round(num(m.cycles, 1, 6, 2)),
        sharpness: num(m.sharpness, 0.05, 1, 0.3),
        amplitude: num(m.amplitude, 0.002, 0.2, 0.02),
        prompt: String(m.prompt ?? "").slice(0, 300),
        seed: Math.round(num(m.seed, 1, 9999, 7)),
      },
    });
  }
  if (!elements.length) {
    return {
      recipe: null,
      reason: rejected.length
        ? `všechny prvky odmítnuty: ${rejected.slice(0, 3).join("; ")}`
        : "model nenašel nic, co by se dalo rozpohybovat",
    };
  }
  return {
    recipe: {
      version: 2,
      shot_seconds: num(obj.shot_seconds, 3, 12, 6),
      push: num(obj.push, 0.01, 0.2, 0.05),
      note: String(obj.note ?? "").slice(0, 400),
      elements,
    },
  };
}

function safeJson(text: string): unknown {
  const fenced = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Absolutní mez velikosti obrázku. 6 MB je limit zhruba i pro NVIDIA. */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/**
 * Rozpočet ČASU celé vision větve.
 *
 * Edge funkce má wall-clock limit (naměřeno: `HTTP 546
 * WORKER_RESOURCE_LIMIT` po ~150 s). Jeden vidoucí model na SKUTEČNÉM obalu
 * Temneyho (476 KB JPEG, 2308 prompt tokenů) zabere ~27 s. Tři modely po 90 s
 * by daly 270 s, tedy spolehlivý 546 a uživatel by čekal dvě a půl minuty na nic.
 *
 * Proto: jeden časový limit na POKUS a JEDEN společný na celý řetězec. Když
 * rozpočet dojde, `planMotion` vrátí `recipe: null` s `reason` a volající
 * odmítne — fail-closed, ne tichá polovina práce.
 *
 * Rozdělení je schválně drsné: reálný náklad je JEDEN vidoucí model. Naměřeno
 * živě na produkci — `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` na
 * skutečném obalu vrátil recept za 27 s a celý `make_music_video` do 37 s.
 * Když nano-omni spadne, je na řadě 90b, ale většinou už není čas — a to je
 * v pořádku. Radí selhat s jasnou českou zprávou než 546 po dvou minutách.
 */
const VISION_ATTEMPT_MS = 40_000;
const VISION_TOTAL_MS = 55_000;

/** `data:<mime>;base64,<data>` — tvar, kterému rozumí OpenAI vision. */
export function toDataUrl(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Zeptá se vidoucího modelu na plán pohybu. Vrátí `recipe: null` s `reason`,
 * když to nedá smysl. NEHAZUJE — volající dostane `{recipe: null}` a sám
 * rozhodne, jestli to je chyba, která má jít do `agent_tool_logs`.
 */
export async function planMotion(opts: {
  key: string;
  base: string;
  models: string[];
  imageBase64: string;
  mimeType: string;
  prompt: string;
  songTitle?: string;
  style?: string;
}): Promise<
  {
    recipe: Record<string, unknown> | null;
    reason?: string;
    model: string;
    raw: string;
  }
> {
  const header = [
    opts.songTitle ? `Song title: ${opts.songTitle}` : "",
    opts.style ? `Visual style: ${opts.style}` : "",
  ].filter(Boolean).join("\n");
  const body = `INSTRUCTION FROM THE USER (what should move in this image):
"""
${opts.prompt}
"""

Write the motion recipe. JSON only.`;

  const messages = [
    { role: "system", content: RECIPE_SYSTEM },
    {
      role: "user",
      content: [
        { type: "text", text: header ? `${header}\n\n${body}` : body },
        { type: "image_url", image_url: { url: toDataUrl(opts.mimeType, opts.imageBase64) } },
      ],
    },
  ];

  const failures: string[] = [];
  const deadline = Date.now() + VISION_TOTAL_MS;
  for (const model of opts.models) {
    const left = deadline - Date.now();
    if (left <= 3_000) {
      failures.push("vypršel společný časový limit vision analýzy");
      break;
    }
    const sent = await visionPost(
      opts.base,
      opts.key,
      model,
      messages,
      true,
      undefined,
      Math.min(VISION_ATTEMPT_MS, left),
    );
    if (!sent.ok) {
      failures.push(`${model}: ${sent.note}`);
      // Bez klíče se to opakovat nemá; 401/403 je chyba konfigurace, ne modelu.
      if (sent.status === 401 || sent.status === 403) break;
      continue;
    }
    if (sent.content) {
      const out = sanitizeRecipe(safeJson(sent.content));
      if (out.recipe) return { ...out, model, raw: sent.content.slice(0, 1500) };
      // Model odpověděl, ale recept je nepoužitelný. Další model může být lepší.
      failures.push(`${model}: ${out.reason ?? "recept nevyšel"}`);
      continue;
    }
    // `content: null` + `finish_reason:"length"` = reasoning sežral rozpočet.
    // Bereme to jako selhání POKUSU a zkusíme to s větším rozpočtem, ne jako
    // prázdný recept (viz llm.ts poznámka A — tentýž bug, jiná větev).
    if (sent.finish === "length") {
      const retryLeft = deadline - Date.now();
      if (retryLeft > 3_000) {
        const retry = await visionPost(
          opts.base,
          opts.key,
          model,
          messages,
          false,
          3000,
          Math.min(VISION_ATTEMPT_MS, retryLeft),
        );
        if (retry.ok && retry.content) {
          const out = sanitizeRecipe(safeJson(retry.content));
          if (out.recipe) {
            return { ...out, model, raw: retry.content.slice(0, 1500) };
          }
        }
      }
      failures.push(`${model}: reasoning sežral rozpočet, odpověď vyprázdněná`);
      continue;
    }
    failures.push(`${model}: prázdná odpověď`);
  }
  return {
    recipe: null,
    reason: failures.join(" | ") || "žádný vidoucí model neodpověděl",
    model: opts.models[0] ?? "",
    raw: "",
  };
}

type VisionSent =
  | { ok: true; content: string; finish: string }
  | { ok: false; status: number; note: string };

/** Jeden pokus na `/chat/completions`. Timeout je povinný — visící požadavek není recept. */
async function visionPost(
  base: string,
  key: string,
  model: string,
  messages: unknown[],
  json: boolean,
  maxTokens = 1400,
  timeoutMs = VISION_ATTEMPT_MS,
): Promise<VisionSent> {
  const send = async () => {
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.25,
          max_tokens: maxTokens,
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        return { ok: false as const, status: response.status, note: `HTTP ${response.status}` };
      }
      return { ok: true as const, response };
    } catch (error) {
      const aborted = error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      return { ok: false as const, status: 0, note: aborted ? "vypršel časový limit" : "síťová chyba" };
    }
  };

  let sent = await send();
  // Některé vidoucí modely `response_format` neznají (400). Regex řetězec
  // u volajícího je záloha, takže to není ztráta funkčnosti — jen 400 navíc.
  if (!sent.ok && sent.status === 400 && json) {
    sent = await send();
  }
  if (!sent.ok) return sent;

  let payload: {
    choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }>;
  };
  try {
    payload = await sent.response.json() as typeof payload;
  } catch {
    return { ok: false, status: 0, note: "nečitelná odpověď" };
  }
  const choice = payload.choices?.[0];
  const content = typeof choice?.message?.content === "string"
    ? choice.message.content.trim()
    : "";
  const finish = typeof choice?.finish_reason === "string" ? choice.finish_reason : "neznámé";
  return { ok: true, content, finish };
}

/** Převede plán pohybu na stručný český popis pro odpověď uživateli. */
export function describeRecipe(recipe: Record<string, unknown> | null): string {
  if (!recipe) return "Plán pohybu se nepodařilo vytvořit.";
  const els = (recipe.elements ?? []) as Array<Record<string, unknown>>;
  const mots: Record<string, string> = {
    rotate: "otáčí se",
    blink: "bliká",
    breathe: "dýchá",
    sway: "kolébá se",
    pulse: "pulzuje",
    i2v: "hýbe se (video model)",
  };
  const parts = els.map((e) => {
    const m = (e.motion ?? {}) as Record<string, unknown>;
    return `${e.what} (${mots[String(m.type)] ?? String(m.type)})`;
  });
  return parts.join(", ");
}

/** Provider, u kterého umíme plán pohybu. `visionModels` je zároveň seznam
 *  VIDĚCÍCH modelů — textový model v `models[]` sem nesmí. */
export type VisionCandidate = {
  id: string;
  keyEnvs: string[];
  base: string;
  visionModels?: string[];
};

/**
 * Vyhledá poskytovatele, který UMÍ vidět. Bez toho recept nenapíšeme.
 *
 * Dřív tady bylo `cfg.find(p => p.id === "gemini")` a `envKeys()` vracelo
 * JEN `GOOGLE_AI_STUDIO_KEY`/`GEMINI_API_KEY`. To byla tvrdá zátka: `make_music_video`
 * a `make_short` nemohly napsat plán pohybu, i když šlo do řetězce jiného
 * poskytovatele. Dnes to hledá KAŽDÝ provider s `visionModels` a s klíčem.
 */
export function visionProvider(
  cfg: VisionCandidate[],
  env: Record<string, string | undefined>,
) {
  for (const provider of cfg) {
    const models = provider.visionModels ?? [];
    if (!models.length) continue;
    for (const envName of provider.keyEnvs) {
      const key = env[envName];
      if (key) return { id: provider.id, base: provider.base, key, models };
    }
  }
  return null;
}
