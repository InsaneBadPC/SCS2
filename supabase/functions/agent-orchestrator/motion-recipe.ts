// Plán pohybu z obrázku + promptu uživatele.
//
// Volá Gemini s vision, dostane obrázek a text "co na obrázku rozpohybovat",
// a vrátí JSON recept, co přesně se má hýbat. Bez toho bychom měli jednu
// šablonu pro všechny fotky — a to je přesně to, co uživatel nechce.
//
// Nic se nevymýšlí navíc: pokud uživatel neřekne "kouř", recept neobsahuje
// kouř. Jediné, co se přidává automaticky, je pomalý celkový nájezd
// (background.push), protože jinak je to statický snímek.

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

/** Zeptá se Gemini na plán pohybu. Vrátí null, když to nedá smysl. */
export async function planMotion(opts: {
  key: string;
  base: string;
  model: string;
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

  const response = await fetch(
    `${opts.base}/models/${opts.model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": opts.key,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: RECIPE_SYSTEM }] },
        contents: [{
          role: "user",
          parts: [
            { text: header ? `${header}\n\n${body}` : body },
            { inlineData: { mimeType: opts.mimeType, data: opts.imageBase64 } },
          ],
        }],
        generationConfig: {
          temperature: 0.25,
          responseMimeType: "application/json",
        },
      }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Gemini vision selhal (${response.status}): ${body.slice(0, 300)}`,
    );
  }
  const payload = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const raw =
    payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join(
      "",
    ) ?? "";
  const out = sanitizeRecipe(safeJson(raw));
  return { ...out, model: opts.model, raw: raw.slice(0, 1500) };
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

/** Provider, u kterého umíme plán pohybu. Stačí jen ID, klíče a modely. */
type VisionCandidate = {
  id: string;
  keyEnvs: string[];
  base: string;
  models: string[];
};

/** Vyhledá Gemini vision provider + klíč. Bez vision recept nenapíšeme. */
export function visionProvider(
  cfg: VisionCandidate[],
  env: Record<string, string | undefined>,
) {
  const gemini = cfg.find((p) => p.id === "gemini");
  if (!gemini) return null;
  for (const envName of gemini.keyEnvs) {
    const key = env[envName];
    if (key) {
      return {
        base: gemini.base,
        key,
        model: gemini.models[gemini.models.length - 1],
      };
    }
  }
  return null;
}
