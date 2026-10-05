// Temney Agent v4.0 — server-only orchestrator, multi-provider / multi-model.
// The model can choose tools, but every tool is dispatched here with verified user ownership.
// LLM layer is provider-agnostic: providers+models are tried in order, falling back on failure.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  isAllowedPrivateUser,
  privateAccessMessage,
} from "../_shared/access.ts";
import { llmComplete } from "../_shared/llm.ts";
import { describeRecipe, planMotion, visionProvider } from "./motion-recipe.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });
const clip = (value: unknown, max: number) =>
  typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : "";
const CHARACTER_BIBLE =
  "mysterious solitary figure who grew up on the streets of the ghetto and is deeply broken by pain; worn street hoodie or beat-up jacket, worn by years of struggle; urban decay, alley, rooftop, graffiti or chain-link fence; night or dusk; muted desaturated palette with one harsh orange streetlight or cold-blue neon accent; gritty cinematic realism; face never clearly visible, always hood, silhouette, back turned, deep shadow or partial crop, pain shown through hunched posture, tattered clothing and worn environment, never a clear facial expression; clean negative space in top or bottom third for the text overlay; text overlay IS REQUIRED and must clearly read the artist name TEMNEY, the album name and the song title in readable typography; no other readable text, logo or watermark";
const CONFIRM_REQUIRED = new Set([
  "publish_to_youtube",
  "update_existing_video",
  "send_comment_reply",
  "set_thumbnail",
]);

type Input = {
  message?: unknown;
  history?: unknown;
  conversationId?: unknown;
  autoPublish?: unknown;
};
type LlmCall = {
  id?: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * Volitelné. Gemini ho posílá zpátky u `functionCall` a pro vícetakové
   * přemýšlení ho chce — ale OpenAI cizí pole v `messages` odmítá (llm-map §8.5),
   * proto se NIKDY neposílá do zprávy. Kdyby ho někdo přidal do `LlmPart`,
   * `toOpenAIMessages` by ho zahodil; drží se tu jen proto, aby se nerozbil
   * pars, když ho nějaký provider vrátí.
   */
  thoughtSignature?: string;
};
// Vnitřní tvar zprávy. `thoughtSignature` je VŽDY volitelné a nikdy se
// nepřenáší dál — `toOpenAIMessages` ho nezná a OpenAI by ho odmítl (llm-map §8.5).
type LlmPart = { type: "text"; text: string } | {
  type: "functionCall";
  name: string;
  args: Record<string, unknown>;
  id?: string;
  thoughtSignature?: string;
} | {
  type: "functionResponse";
  name: string;
  response: unknown;
  id?: string;
  thoughtSignature?: string;
};
type LlmMessage = { role: "user" | "model" | "function"; parts: LlmPart[] };
type LlmResult = {
  text: string;
  calls: LlmCall[];
  provider: string;
  model: string;
};
type ProviderCfg = {
  id: string;
  keyEnvs: string[];
  base: string;
  models: string[];
  /** Doplňkové tělo požadavku (`reasoning_effort` na NVIDIA, `reasoning` na OpenRouter). */
  extraBody?: Record<string, unknown>;
  /**
   * Kolik tokenů potřebuje reasoning VEDLE odpovědi. Bez rezervy reasoning
   * vytlačí odpověď a provider vrátí `content: null` + `finish_reason:"length"`
   * (naměřeno živě, viz `openaiCompatibleChat`).
   */
  reasoningCost: number;
  /**
   * Modely, co umí `image_url`. Prázdné = tato větev neumí vidět a nesmí
   * se použít pro plán pohybu. Změřeno, ne odhadnuto — viz `motion-recipe.ts`.
   */
  visionModels?: string[];
  chat: (
    key: string,
    base: string,
    model: string,
    system: string,
    msgs: LlmMessage[],
    toolDefs: unknown[],
    withTools: boolean,
    opts: { maxTokens: number; reasoningCost: number; extraBody?: Record<string, unknown> },
  ) => Promise<LlmResult>;
};

const toolDefs = [
  {
    name: "list_songs",
    description: "List the user's songs and their artwork/video readiness.",
    parameters: {
      type: "object",
      properties: { withoutArtwork: { type: "boolean" } },
    },
  },
  {
    name: "list_lyric_drafts",
    description:
      "List the user's in-progress lyric drafts (sc_lyrics status draft), e.g. rozpracované texty.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "check_video_status",
    description:
      "Check render status of the user's videos. Returns id, song, mode, status and error message. Use after make_music_video, make_short or render_video instead of guessing.",
    parameters: {
      type: "object",
      properties: { videoId: { type: "string" } },
    },
  },
  {
    name: "extract_lyric_themes",
    description: "Extract 3-6 visual motifs from a song lyric.",
    parameters: {
      type: "object",
      properties: { songId: { type: "string" } },
      required: ["songId"],
    },
  },
  {
    name: "generate_song_artwork",
    description:
      "Generate Temney artwork from a song lyric and save it to private storage.",
    parameters: {
      type: "object",
      properties: {
        songId: { type: "string" },
        aspectRatio: { type: "string", enum: ["1:1", "16:9"] },
        userNote: { type: "string" },
      },
      required: ["songId"],
    },
  },
  {
    name: "make_album_artwork",
    description: "Generate a square 1:1 album cover and save it privately.",
    parameters: {
      type: "object",
      properties: { albumId: { type: "string" }, userNote: { type: "string" } },
      required: ["albumId"],
    },
  },
  {
    name: "generate_metadata",
    description:
      "Draft YouTube title, description and tags for a song. Never publishes.",
    parameters: {
      type: "object",
      properties: { songId: { type: "string" } },
      required: ["songId"],
    },
  },
  {
    name: "render_video",
    description:
      "Queue a video render from the final song audio and artwork. Three 16:9 render modes: static_cover = 1280x720 static artwork over the final audio; image_animation = image-to-video animation of the artwork over the final audio; full_scenes = full scene-based video (storyboard scenes from audio lyrics + artwork as the character reference). Returns a videoId; the agent must report the render as pending and check status later.",
    parameters: {
      type: "object",
      properties: {
        songId: { type: "string" },
        type: {
          type: "string",
          enum: ["static_cover", "image_animation", "full_scenes"],
        },
        prompt: { type: "string" },
      },
      required: ["songId"],
    },
  },
  {
    name: "make_music_video",
    description:
      "Use this when the user says which song AND what should move in its picture, e.g. 'u Chtel bych rozhybej postavu' or 'roztoč to kolo'. Looks at the song's own artwork, decides exactly where that thing is in the picture, and queues a full-length music video where ONLY the requested thing moves. Never invents effects the user did not ask for. Returns a videoId and a plain description of what will move; report the render as pending.",
    parameters: {
      type: "object",
      properties: {
        songId: { type: "string" },
        motionPrompt: {
          type: "string",
          description:
            "What should move in the picture, in the user's own words",
        },
      },
      required: ["songId", "motionPrompt"],
    },
  },
  {
    name: "make_short",
    description:
      "Use this when the user asks for a short / vertical clip from a song. Picks the strongest part of the song, writes the same kind of motion plan for the song's artwork, and queues a 9:16 vertical video for YouTube Shorts. Returns a videoId; report as pending.",
    parameters: {
      type: "object",
      properties: {
        songId: { type: "string" },
        motionPrompt: { type: "string" },
        fromSecond: { type: "number" },
        seconds: { type: "number" },
      },
      required: ["songId"],
    },
  },
  {
    name: "make_long_video",
    description:
      "Queue a full-length 16:9 music video for the whole song. The loop engine cuts the song's own video (or its artwork) into passes of random length and joins them with transitions that are never visible, so nothing visibly repeats. This is the DEFAULT video tool: use it whenever the user wants a video for a song, and use it again for the same song whenever they ask for a new cut. No motion prompt is needed and do not invent effects.",
    parameters: {
      type: "object",
      properties: {
        songId: { type: "string" },
        note: {
          type: "string",
          description: "Volitelné: o čem má video být (jen pro hlediskový záznam)",
        },
      },
      required: ["songId"],
    },
  },
  {
    name: "make_short_video",
    description:
      "Queue a 9:16 vertical clip for YouTube Shorts from a song, using the same loop engine as make_long_video. Use it whenever the user says short, vertical, Shorts, reels, or 'udelej z toho kratke video'. Returns a videoId; report the render as pending.",
    parameters: {
      type: "object",
      properties: {
        songId: { type: "string" },
        note: { type: "string" },
      },
      required: ["songId"],
    },
  },
  {
    name: "run_vm_command",
    description:
      "Queue one shell command to run on the render VM. Use it for anything you cannot do from here: read logs, restart a service, check disk or a render, run the project's test gates. It is ALWAYS queued as pending and the USER MUST CONFIRM before anything runs, so tell the user exactly what will run and wait. Never use it to publish, never touch the database directly, never read secrets files.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Jeden příkaz pro bash na VM" },
        why: { type: "string", description: "Jedna věta pro uživatele, co tím chceš zjistit nebo udělat" },
      },
      required: ["command", "why"],
    },
  },
  {
    name: "check_op_status",
    description:
      "Read the result of a queued VM operation by its id. Returns status and the captured output.",
    parameters: {
      type: "object",
      properties: { operationId: { type: "string" } },
      required: ["operationId"],
    },
  },
  {
    name: "push_git_branch",
    description:
      "Queue a git push of the current work branch to the repository. ALWAYS needs the user's confirmation first. Use it after the user has seen the gates pass.",
    parameters: {
      type: "object",
      properties: {
        branch: { type: "string", description: "např. dev/ai-manager-studio nebo main" },
        why: { type: "string" },
      },
      required: ["branch", "why"],
    },
  },
  {
    name: "deploy_worker",
    description:
      "Queue deploying the video worker (worker.mjs + loop-engine.mjs) to the VM and restarting its service. ALWAYS needs the user's confirmation first.",
    parameters: {
      type: "object",
      properties: { why: { type: "string" } },
      required: ["why"],
    },
  },
  {
    name: "read_repo_file",
    description: "Read a file from the SongCraft Studio repository.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        ref: { type: "string", description: "větev, default main" },
      },
      required: ["path"],
    },
  },
  {
    name: "read_skills",
    description:
      "Read the SongCraft Studio skills document: architecture, ops, known breakages, verification commands. Read it before doing any repo or VM work.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "create_recommendation",
    description: "Save a strategic recommendation for the user.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [
            "seo",
            "thumbnail",
            "schedule",
            "content",
            "engagement",
            "strategy",
          ],
        },
        recommendation: { type: "string" },
        reasoning: { type: "string" },
      },
      required: ["category", "recommendation"],
    },
  },
  {
    name: "schedule_publication",
    description:
      "Create a private draft publication for a ready video with a suggested time; never publish.",
    parameters: {
      type: "object",
      properties: {
        songId: { type: "string" },
        videoId: { type: "string" },
        title: { type: "string" },
        scheduledAt: { type: "string" },
      },
      required: ["songId"],
    },
  },
  {
    name: "publish_to_youtube",
    description:
      "Publish an already prepared draft. This always becomes pending confirmation unless the server setting explicitly allows automation.",
    parameters: {
      type: "object",
      properties: { publicationId: { type: "string" } },
      required: ["publicationId"],
    },
  },
];

function historyFrom(input: Input): LlmMessage[] {
  if (!Array.isArray(input.history)) return [];
  return input.history.slice(-12).flatMap((entry) => {
    const item = entry as { role?: unknown; content?: unknown };
    const text = clip(item.content, 1500);
    return text
      ? [{
        role: item.role === "assistant" ? "model" : "user",
        parts: [{ type: "text", text }] as LlmPart[],
      }]
      : [];
  });
}

// ---- LLM layer: normalized neutral format, providers tried in order, fallback on any failure. ----
function stripFences(text: string) {
  return text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
}
async function ask(
  provider: ProviderCfg,
  key: string,
  model: string,
  system: string,
  msgs: LlmMessage[],
  toolDefs: unknown[],
  withTools: boolean,
): Promise<LlmResult> {
  return await provider.chat(
    key,
    provider.base,
    model,
    system,
    msgs,
    toolDefs,
    withTools,
    { maxTokens: AGENT_MAX_TOKENS, reasoningCost: provider.reasoningCost, extraBody: provider.extraBody },
  ).catch((error) => {
    throw new Error(
      `${provider.id}:${model} ${
        error instanceof Error ? error.message.slice(0, 160) : String(error)
      }`,
    );
  });
}
/**
 * MIME podle MAGICKÝCH BAJTŮ, ne podle přípony v cestě. Přípona lže —
 * viz `make_music_video`. `null` = neznámý/neobrázek.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47) return "image/png";
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: "GIF87a" / "GIF89a"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x38) return "image/gif";
  // WebP: "RIFF" .... "WEBP"
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 &&
    bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
/**
 * Všechny klíče, které čte řetěz. DŘÍV tady byly JEN dvě Gemini proměnné, takže
 * `visionProvider()` nemohla vidět `OPENROUTER_API_KEY` ani `NVIDIA_API_KEY` —
 * tvrdá zátka pro `make_music_video`/`make_short` (llm-map §4, §8.10).
 * Teď se to odvozuje z `PROVIDERS`, takže se to nemůže rozejít.
 */
function envKeys(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const provider of PROVIDERS) {
    for (const name of provider.keyEnvs) out[name] = Deno.env.get(name);
  }
  // Záchrana Gemini mimo tool řetězec drží sdílený klient (viz `llmText`).
  for (const name of ["GOOGLE_AI_STUDIO_KEY", "GEMINI_API_KEY"]) {
    out[name] = Deno.env.get(name);
  }
  return out;
}

/**
 * Rozpočet ODPOVĚDI na jeden krok agenta. Reasoning si bere navíc
 * (`reasoningCost`), jinak u reasoning modelů vytlačí odpověď — naměřeno
 * živě: `max_tokens: 24` → `finish_reason:"length"`, `content: null`,
 * `reasoning_tokens: 24`; totéž s `max_tokens: 900` → normální česká odpověď.
 */
const AGENT_MAX_TOKENS = 1400;

/**
 * Časový rozpočet CELÉHO LLM řetězce na jeden krok agenta.
 *
 * Edge funkce má wall-clock limit (naměřeno: `HTTP 546 WORKER_RESOURCE_LIMIT`
 * po ~150 s). Původně tady timeout 90 s byl NA POKUS a pokusů mohlo být
 * 3 modely × 3 poskytovatele = devět → v teoretickém horším případě 13 minut.
 * Rozpočet je teď společný: 45 s na celý řetěz. NVIDIA (první v pořadí,
 * žádný denní strop) odpovídá za 1–3 s, takže 45 s je velká rezerva, ne
 * zkrácení. A je to JEDEN krok — pořád je 6 kroků agenta.
 */
const CHAIN_TIMEOUT_MS = 45_000;

/** Mez base64 náplně pro vidění. 6 MB bajtů ≈ 8 MB base64 ≈ 8.4 MB JSON. */
const MAX_B64_VISION = 6 * 1024 * 1024;

// Provideri jsou na uroven modulu, protoze je potrebuje i planMotion (vision).
//
// POŘADÍ NENÍ LIBOVOLNÉ. Změřeno 2026-10-05 na živých klíčích:
//
//   OpenRouter `:free`  → `x-ratelimit-limit: 50`, a to 50 POŽADAVKŮ NA DEN
//                         NAPŘIČ VŠEMI `:free` MODELY DOHROMADY, reset 00:00 UTC.
//                         Ne „limit na model“. Živě: `remaining: 0`.
//   NVIDIA NIM          → žádný denní strop, drží `reasoning` přes `reasoning_effort`.
//                         Tool calling ověřen živě (viz report): `finish_reason:
//                         "tool_calls"` + `tool_calls[].function.arguments`.
//
// Proto NVIDIA první. OpenRouter zůstává druhý (je to levná pojistka pro případ,
// že NVIDIA spadne), ale v době vyčerpaných 50/50 je to jen rychlý 429, který
// se přeskočí. `SONGCRAFT_LLM_PROVIDERS` přepíše pořadí i v tomto souboru.
//
// `gemini` v tool řetězci NENÍ a to je záměr: `geminiChat()` (Gemini-native
// `functionDeclarations`) je pryč a nahrazuje ho sdílený klient, který neumí
// nástroje. Pro text Gemini zůstává dostupný — `llmText()` ho volá přes
// `_shared/llm.ts`, kde je poslední v záchranném řetězci a jen když existuje klíč.
const PROVIDERS: ProviderCfg[] = [
  {
    id: "nvidia",
    keyEnvs: ["NVIDIA_API_KEY", "NVAPI_API_KEY"],
    base: "https://integrate.api.nvidia.com/v1",
    models: [
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "openai/gpt-oss-20b",
    ],
    // NVIDIA `reasoning: {max_tokens}` IGNORUJE (naměřeno — reasoning sežere
    // celý `max_tokens` a vrátí se `content: null`). Její vlastní knoflík je
    // `reasoning_effort`, který reasoning tokeny opravdu zkracuje.
    extraBody: { reasoning_effort: "low" },
    reasoningCost: 640,
    // ZMĚŘENO na obrázku 128×128 a na 160×160 „noční ulička" (viz
    // `motion-recipe.ts`): všechny tři vrátily 200 + použitelný recept.
    // `microsoft/phi-3-vision-128k-instruct` je vyškrtnut — na tomhle účtě 404.
    // Pořadí od nejlepšího: nano-omni je ~3x rychlejší a dává těsnější region
    // než 90b, který občas vrátí region přes celý snímek.
    visionModels: [
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      "meta/llama-3.2-90b-vision-instruct",
      "meta/llama-3.2-11b-vision-instruct",
    ],
    chat: openaiCompatibleChat,
  },
  {
    id: "openrouter",
    keyEnvs: ["OPENROUTER_API_KEY", "SONGCRAFT_OPENROUTER_API_KEY"],
    base: "https://openrouter.ai/api/v1",
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
    visionModels: ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"],
    chat: openaiCompatibleChat,
  },
  {
    // Druhý klíč = poslední záchrana. Je 429-throttled jinak, takže obvykle
    // ještě něco vrátí, když hlavní klíč spadl.
    id: "openrouter-backup",
    keyEnvs: ["OPENROUTER_API_KEY_BACKUP", "SONGCRAFT_OPENROUTER_API_KEY_BACKUP"],
    base: "https://openrouter.ai/api/v1",
    models: [
      "nvidia/nemotron-3-super-120b-a12b:free",
      "google/gemma-4-31b-it:free",
    ],
    extraBody: { reasoning: { max_tokens: 1024 } },
    reasoningCost: 1024,
    chat: openaiCompatibleChat,
  },
];

/**
 * Text bez nástrojů jde přes SDÍLENÝ klient (`_shared/llm.ts`), ne přes
 * lokální `PROVIDERS`. Důvod: jen sdílený klient umí Gemini, a to jako poslední
 * záchradu, když existuje klíč. Duplikovat Gemini tělo sem znovu by vrátilo
 * přesně to, co `_shared/llm.ts` vznikl zrušit.
 */
async function llmText(system: string, msgs: LlmMessage[]): Promise<LlmResult> {
  const messages = msgs.flatMap((msg) =>
    msg.role === "function" ? [] : toOpenAIMessages(msg)
  ).filter((entry) => typeof entry.content === "string" && entry.content);
  const out = await llmComplete({
    system,
    messages: messages as Array<{ role: "user"; content: string }>,
    temperature: 0.55,
    maxTokens: AGENT_MAX_TOKENS,
  });
  return { text: out.text, calls: [], provider: out.provider, model: out.model };
}

async function llm(
  system: string,
  msgs: LlmMessage[],
  toolDefs: unknown[],
  withTools = true,
): Promise<LlmResult> {
  // Bez nástrojů jde odpověď přes sdílený klient — ten má v řetězci i Gemini.
  if (!withTools) return await llmText(system, msgs);

  const failures: string[] = [];
  // Rozpočet je pro CELÝ řetěz, ne pro jeden pokus. Bez toho je to devět pokusů
  // po 90 s = 13 minut visící požadavek, což je přesně to, co ty tři funkce
  // bez timeoutu dělaly (a dělaly špatně).
  const deadline = Date.now() + CHAIN_TIMEOUT_MS;
  for (const provider of PROVIDERS) {
    const key = provider.keyEnvs.map((entry) => Deno.env.get(entry)).find(
      Boolean,
    );
    if (!key) {
      failures.push(`${provider.id}:no-key`);
      continue;
    }
    for (const model of provider.models) {
      if (deadline - Date.now() <= 2_000) {
        failures.push(`${provider.id}:${model}: vypršel společný časový limit`);
        break;
      }
      try {
        const result = await ask(
          provider,
          key,
          model,
          system,
          msgs,
          toolDefs,
          withTools,
        );
        return { ...result, provider: provider.id, model };
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  throw new Error(`Všichni LLM poskytovatelé selhali. ${failures.join(" | ")}`);
}

async function openaiCompatibleChat(
  key: string,
  base: string,
  model: string,
  system: string,
  msgs: LlmMessage[],
  toolDefs: unknown[],
  withTools: boolean,
  opts: { maxTokens: number; reasoningCost: number; extraBody?: Record<string, unknown> },
): Promise<LlmResult> {
  const messages: Array<Record<string, unknown>> = [{
    role: "system",
    content: system,
  }];
  for (const msg of msgs) messages.push(...toOpenAIMessages(msg));
  const tools = withTools
    ? (toolDefs as Array<
      { name: string; description: string; parameters: unknown }
    >).map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))
    : undefined;

  // `maxTokens` je rozpočet ODPOVĚDI. Reasoning si bere navíc, jinak u
  // reasoning modelů vytlačí odpověď a vrátí se `content: null`.
  const budget = Math.max(256, opts.maxTokens + opts.reasoningCost);
  let parsed = await postChat(base, key, model, messages, tools, budget, opts.extraBody);
  let finish = parsed.finish;
  let message = parsed.message;

  // `content: null` + `finish_reason:"length"` = reasoning sežral rozpočet.
  // Naměřeno živě: `max_tokens: 24` → `reasoning_tokens: 24`, `content: null`.
  // Bez tohoto by uživatel dostal po 90 s „AI manažer selhal". Bereme to jako
  // selhání POKUSU (ne jako prázdnou odpověď) a zkusíme to s dvojnásobným
  // rozpočtem. JEDEN retry — ne smyčka, která by jen žrala čas.
  if (
    !message.content && !message.tool_calls?.length && finish === "length" &&
    budget < 4_000
  ) {
    parsed = await postChat(base, key, model, messages, tools, budget * 2, opts.extraBody);
    finish = parsed.finish;
    message = parsed.message;
  }

  const text = (message.content ?? "").trim();
  const calls = (message.tool_calls ?? []).map((call) => {
    try {
      return {
        id: call.id,
        name: call.function?.name ?? "",
        args: JSON.parse(call.function?.arguments ?? "{}") as Record<
          string,
          unknown
        >,
      };
    } catch {
      return { id: call.id, name: call.function?.name ?? "", args: {} };
    }
  });
  // Ani text, ani nástroj = prázdný pokus. Musí to být CHYBA, jinak by řetěz
  // skončil na prázdném výsledku a uživatel by dostal „zpracoval jsem úkol"
  // bez odpovědi. `content: null` + `finish_reason:"tool_calls"` NENÍ chyba —
  // to je běžný tvar volajícího nástroj (naměřeno živě na NVIDIA).
  if (!text && !calls.length) {
    throw new Error(
      `bez odpovědi (finish=${finish}${
        text === "" ? ", prázdný content" : ""
      })`,
    );
  }
  return { text, calls, provider: "openai-compatible", model };
}

type OpenAiMessage = {
  content?: string | null;
  tool_calls?: Array<
    { id?: string; function?: { name?: string; arguments?: string } }
  >;
};

/** Jeden HTTP pokus na `/chat/completions` s timeoutem a bez házení na text. */
async function postChat(
  base: string,
  key: string,
  model: string,
  messages: Array<Record<string, unknown>>,
  tools: unknown,
  maxTokens: number,
  extraBody?: Record<string, unknown>,
): Promise<{ message: OpenAiMessage; finish: string }> {
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      temperature: 0.55,
      max_tokens: maxTokens,
      ...(extraBody ?? {}),
    }),
    signal: AbortSignal.timeout(CHAIN_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${(await response.text()).slice(0, 160)}`,
    );
  }
  const data = await response.json() as {
    choices?: Array<
      { finish_reason?: unknown; message?: OpenAiMessage }
    >;
  };
  const choice = data.choices?.[0];
  return {
    message: choice?.message ?? {},
    finish: typeof choice?.finish_reason === "string"
      ? choice.finish_reason
      : "neznámé",
  };
}

/**
 * Gemini-native `contents[].parts[]` + `functionDeclarations`/`functionResponse`
 * je pryč: `geminiChat()` a `jsonifyGemini()` měly dvě Gemini-only těla
 * duplikovaná přes čtyři edge funkce a `_shared/llm.ts` existuje právě proto,
 * aby je nebylo potřeba. Kdo potřebuje Gemini, jde přes `llmText()`.
 *
 * `thoughtSignature` se odtud posílat NESMÍ — OpenAI cizí pole v `messages`
 * odmítá (llm-map §8.5) a Gemini ho vyžaduje jen pro vícetakové přemýšlení,
 * které v tomhle řetězci není. Zůstává proto nepovinný jen v `LlmCall`.
 */
function toOpenAIMessages(msg: LlmMessage): Array<Record<string, unknown>> {
  if (msg.role === "user") return [{ role: "user", content: textOf(msg) }];
  if (msg.role === "function") {
    return msg.parts.filter((
      part,
    ): part is Extract<LlmPart, { type: "functionResponse" }> =>
      part.type === "functionResponse"
    ).map((part) => ({
      role: "tool",
      tool_call_id: part.id ?? part.name,
      name: part.name,
      content: JSON.stringify(part.response),
    }));
  }
  const toolCalls = msg.parts.filter((
    part,
  ): part is Extract<LlmPart, { type: "functionCall" }> =>
    part.type === "functionCall"
  ).map((part, index) => ({
    id: part.id ?? `call_${index}`,
    type: "function",
    function: { name: part.name, arguments: JSON.stringify(part.args) },
  }));
  return [{
    role: "assistant",
    content: textOf(msg) || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  }];
}
function textOf(msg: LlmMessage) {
  return msg.parts.filter((part): part is Extract<LlmPart, { type: "text" }> =>
    part.type === "text"
  ).map((part) => part.text).join("\n");
}

async function row(
  admin: any,
  table: string,
  id: string,
  userId: string,
  select = "*",
) {
  const { data, error } = await admin.from(table).select(select).eq("id", id)
    .eq("user_id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    throw new Error("Položka nebyla nalezena nebo k ní nemáš přístup.");
  }
  return data;
}
async function log(
  admin: any,
  userId: string,
  action: string,
  result: "success" | "error" | "pending",
  payload: unknown,
  targetId?: string,
  errorMessage?: string,
) {
  await admin.from("agent_action_log").insert({
    user_id: userId,
    action_type: action,
    target_id: targetId ?? null,
    payload,
    result,
    error_message: errorMessage ?? null,
  });
}
const conversationUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function ensureConversation(
  admin: any,
  userId: string,
  requestedId: unknown,
  firstMessage: string,
) {
  if (typeof requestedId === "string" && requestedId.trim()) {
    const id = requestedId.trim();
    if (!conversationUuid.test(id)) throw new Error("Neplatné conversationId.");
    const { data, error } = await admin.from("agent_conversations").select("id")
      .eq("id", id).eq("user_id", userId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("Konverzace nepatří přihlášenému uživateli.");
    return id;
  }
  const { data, error } = await admin.from("agent_conversations").insert({
    user_id: userId,
    title: clip(firstMessage, 120),
  }).select("id").single();
  if (error || !data) {
    throw new Error(error?.message || "Konverzaci se nepodařilo vytvořit.");
  }
  return data.id as string;
}
async function appendConversationMessage(
  admin: any,
  userId: string,
  conversationId: string,
  role: "user" | "model",
  content: string,
) {
  const { error } = await admin.from("agent_messages").insert({
    user_id: userId,
    conversation_id: conversationId,
    role,
    content: { text: clip(content, 20_000) },
  });
  if (error) throw new Error(error.message);
}
async function hashConfirmationToken(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
async function createPendingConfirmation(
  admin: any,
  userId: string,
  action: string,
  args: Record<string, unknown>,
) {
  const publicationId = clip(args.publicationId, 80);
  let targetId = publicationId || null;
  let payload: Record<string, unknown> = {
    publicationId: publicationId || null,
    youtubeVideoId: clip(args.youtubeVideoId, 120) || null,
    comment: clip(args.comment, 2_000) || null,
    thumbnailPath: clip(args.thumbnailPath, 500) || null,
  };

  // Bind a publish confirmation to the exact draft metadata that the user is
  // about to make public. The confirm endpoint rejects any later drift.
  if (action === "publish_to_youtube") {
    if (!publicationId) throw new Error("Chybí publicationId pro publikaci.");
    const publication = await row(
      admin,
      "youtube_publications",
      publicationId,
      userId,
      "id,title,description,tags,privacy_status,video_id,status",
    );
    payload = {
      publicationId,
      title: clip(publication.title, 100),
      description: clip(publication.description, 5_000),
      tags: Array.isArray(publication.tags)
        ? publication.tags.slice(0, 15)
        : [],
      privacyStatus: clip(publication.privacy_status, 20) || "private",
    };
  }

  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(
    /-/g,
    "",
  );
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { data, error } = await admin.from("agent_confirmations").insert({
    user_id: userId,
    action,
    target_id: targetId,
    nonce_hash: await hashConfirmationToken(token),
    payload,
    status: "pending",
    idempotency_key: crypto.randomUUID(),
    expires_at: expiresAt,
  }).select("id,expires_at").single();
  if (error || !data) {
    throw new Error(error?.message || "Potvrzení se nepodařilo připravit.");
  }
  return {
    status: "pending_confirmation",
    confirmationId: data.id,
    confirmationToken: token,
    expiresAt: data.expires_at,
    message:
      "Akce čeká na explicitní potvrzení uživatele. Nic veřejného nebylo provedeno.",
  };
}
async function dispatch(
  admin: any,
  userId: string,
  name: string,
  args: Record<string, unknown>,
) {
  if (CONFIRM_REQUIRED.has(name)) {
    const confirmation = await createPendingConfirmation(
      admin,
      userId,
      name,
      args,
    );
    await log(admin, userId, name, "pending", {
      confirmationId: confirmation.confirmationId,
      expiresAt: confirmation.expiresAt,
    }, args.publicationId ? String(args.publicationId) : undefined);
    return confirmation;
  }
  if (name === "list_songs") {
    let query = admin.from("sc_songs").select(
      "id,title,cover_path,album_id,created_at,updated_at",
    ).eq("user_id", userId).order("updated_at", { ascending: false }).limit(50);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const songs = (data ?? []).filter((song: any) =>
      !args.withoutArtwork || !song.cover_path
    );
    await log(admin, userId, name, "success", { count: songs.length });
    return { status: "success", count: songs.length, songs };
  }
  if (name === "check_video_status") {
    const videoId = typeof args.videoId === "string" ? args.videoId.trim() : "";
    let query = admin.from("agent_videos").select(
      "id,song_id,mode,type,aspect,render_status,error_message,output_path,updated_at",
    ).eq("user_id", userId).order("updated_at", { ascending: false }).limit(10);
    if (videoId) query = query.eq("id", videoId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const videos = data ?? [];
    const finished = videos.filter((video: any) => video.render_status === "ready" || video.render_status === "failed");
    await log(admin, userId, name, "success", { count: videos.length, filtered: Boolean(videoId) });
    return {
      status: "success",
      count: videos.length,
      allDone: finished.length === videos.length,
      videos,
    };
  }
  if (name === "list_lyric_drafts") {
    let query = admin.from("sc_lyrics").select(
      "id,title,status,updated_at,lyrics",
    ).eq("user_id", userId).eq("status", "draft").order("updated_at", {
      ascending: false,
    }).limit(20);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const drafts = data ?? [];
    await log(admin, userId, name, "success", { count: drafts.length });
    return { status: "success", count: drafts.length, drafts };
  }
  if (name === "extract_lyric_themes") {
    const song = await row(
      admin,
      "sc_songs",
      String(args.songId),
      userId,
      "id,title,lyrics,style_prompt",
    );
    const answer = await llm(
      `Extract exactly 3-6 concise visual motifs for Temney from the lyric. Return only a JSON array of strings. Character bible: ${CHARACTER_BIBLE}`,
      [{
        role: "user",
        parts: [{
          type: "text",
          text: JSON.stringify({
            title: song.title,
            style: song.style_prompt,
            lyrics: clip(song.lyrics, 5000),
          }),
        }],
      }],
      [],
      false,
    );
    const text = answer.text || "[]";
    try {
      return { themes: JSON.parse(stripFences(text)) };
    } catch {
      return { themes: [text.slice(0, 240)] };
    }
  }
  if (name === "generate_song_artwork") {
    const song = await row(
      admin,
      "sc_songs",
      String(args.songId),
      userId,
      "id,title,lyrics,style_prompt,album_id",
    );
    let albumTitle = clip(args.albumTitle, 140) || "Temney Album";
    if (song.album_id) {
      const { data: alb } = await admin.from("sc_albums").select("name").eq(
        "id",
        song.album_id,
      ).eq("user_id", userId).maybeSingle();
      if (alb?.name) albumTitle = clip(alb.name, 140);
    }
    const ratio = args.aspectRatio === "1:1" ? "1:1" : "16:9";
    const prompt =
      `Temney music artwork, ${ratio} composition. ${CHARACTER_BIBLE}. Artist: TEMNEY. Album: ${
        clip(albumTitle, 140)
      }. Song title: ${clip(song.title, 140)}.  ${
        clip(song.style_prompt, 500)
      } ${clip(song.lyrics, 2400)}. Creative note: ${
        clip(args.userNote, 400)
      }.`;
    const asset = {
      user_id: userId,
      song_id: song.id,
      asset_type: "song_artwork",
      aspect_ratio: ratio,
      prompt_used: prompt,
      status: "generating",
    };
    const { data: created, error: createError } = await admin.from(
      "agent_image_assets",
    ).insert(asset).select("id").single();
    if (createError) throw new Error(createError.message);
    const seed = crypto.randomUUID();
    const sourceUrl = `https://image.pollinations.ai/prompt/${
      encodeURIComponent(prompt)
    }?width=${ratio === "16:9" ? 1280 : 1024}&height=${
      ratio === "16:9" ? 720 : 1024
    }&seed=${encodeURIComponent(seed)}&nologo=true`;
    const image = await fetch(sourceUrl, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!image.ok) {
      throw new Error(
        `Pollinations artwork generation failed (${image.status}).`,
      );
    }
    const bytes = new Uint8Array(await image.arrayBuffer());
    if (bytes.byteLength <= 0 || bytes.byteLength > 10 * 1024 * 1024) {
      throw new Error("Vygenerovaný obal je neplatný nebo příliš velký.");
    }
    const path = `${userId}/agent-artwork/${song.id}-${seed}.jpg`;
    const { error: uploadError } = await admin.storage.from("songcraft").upload(
      path,
      bytes,
      { contentType: "image/jpeg", upsert: false },
    );
    if (uploadError) throw new Error(uploadError.message);
    await admin.from("agent_image_assets").update({
      base_image_path: path,
      final_image_path: path,
      status: "ready",
      seed,
    }).eq("id", created.id);
    await admin.from("sc_songs").update({ cover_path: path }).eq("id", song.id)
      .eq("user_id", userId);
    await log(admin, userId, name, "success", { path, ratio }, song.id);
    return { status: "ready", assetId: created.id, storagePath: path, prompt };
  }
  if (name === "make_album_artwork") {
    const album = await row(
      admin,
      "sc_albums",
      String(args.albumId),
      userId,
      "id,name,description",
    );
    const prompt =
      `Temney album cover, 1:1 composition. ${CHARACTER_BIBLE}. Album: ${
        clip(album.name, 140)
      }. Description: ${clip(album.description, 600)}. Creative note: ${
        clip(args.userNote, 400)
      }. No other readable text, logo or watermark.`;
    const asset = {
      user_id: userId,
      album_id: album.id,
      asset_type: "album_cover",
      for_album: true,
      aspect_ratio: "1:1",
      prompt_used: prompt,
      status: "generating",
    };
    const { data: created, error: createError } = await admin.from(
      "agent_image_assets",
    ).insert(asset).select("id").single();
    if (createError || !created) {
      throw new Error(
        createError?.message || "Album artwork se nepodařilo založit.",
      );
    }
    const seed = crypto.randomUUID();
    const sourceUrl = `https://image.pollinations.ai/prompt/${
      encodeURIComponent(prompt)
    }?width=1024&height=1024&seed=${encodeURIComponent(seed)}&nologo=true`;
    const image = await fetch(sourceUrl, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!image.ok) {
      throw new Error(`Album artwork generation failed (${image.status}).`);
    }
    const bytes = new Uint8Array(await image.arrayBuffer());
    if (bytes.byteLength <= 0 || bytes.byteLength > 10 * 1024 * 1024) {
      throw new Error("Vygenerovaný obal je neplatný nebo příliš velký.");
    }
    const path = `${userId}/agent-artwork/album-${album.id}-${seed}.jpg`;
    const { error: uploadError } = await admin.storage.from("songcraft").upload(
      path,
      bytes,
      { contentType: "image/jpeg", upsert: false },
    );
    if (uploadError) throw new Error(uploadError.message);
    const { error: updateAssetError } = await admin.from("agent_image_assets")
      .update({
        base_image_path: path,
        final_image_path: path,
        status: "ready",
        seed,
      }).eq("id", created.id).eq("user_id", userId);
    if (updateAssetError) throw new Error(updateAssetError.message);
    const { error: updateAlbumError } = await admin.from("sc_albums").update({
      cover_path: path,
    }).eq("id", album.id).eq("user_id", userId);
    if (updateAlbumError) throw new Error(updateAlbumError.message);
    await log(admin, userId, name, "success", { path, ratio: "1:1" }, album.id);
    return { status: "ready", assetId: created.id, storagePath: path, prompt };
  }
  if (name === "generate_metadata") {
    const song = await row(
      admin,
      "sc_songs",
      String(args.songId),
      userId,
      "id,title,lyrics,style_prompt",
    );
    const answer = await llm(
      "Create YouTube metadata in Czech for Temney. Return JSON with title (max 100 chars), description (max 4500 chars), tags (array of max 15 short strings). No claims not supported by the input.",
      [{
        role: "user",
        parts: [{
          type: "text",
          text: JSON.stringify({
            title: song.title,
            style: song.style_prompt,
            lyrics: clip(song.lyrics, 2600),
          }),
        }],
      }],
      [],
      false,
    );
    return { draft: stripFences(answer.text || "{}") };
  }
  if (name === "render_video") {
    const song = await row(
      admin,
      "sc_songs",
      String(args.songId),
      userId,
      "id,title,lyrics,style_prompt",
    );
    const mode = ["static_cover", "image_animation", "full_scenes"].includes(
        String(args.type),
      )
      ? String(args.type)
      : "static_cover";
    const { data: versions, error: versionError } = await admin.from(
      "sc_audio_versions",
    ).select("id,tagged_storage_path,original_storage_path,storage_path").eq(
      "song_id",
      song.id,
    ).eq("user_id", userId).eq("is_final", true).order("is_primary", {
      ascending: false,
    }).order("rating", { ascending: false }).limit(1);
    if (versionError || !versions?.[0]) {
      throw new Error("Pro render musí být vybraná finální MP3 verze.");
    }
    const version = versions[0] as {
      tagged_storage_path?: string | null;
      original_storage_path?: string | null;
      storage_path?: string | null;
    };
    const audioPath = version.tagged_storage_path ||
      version.original_storage_path || version.storage_path;
    if (
      typeof audioPath !== "string" || !audioPath.startsWith(`${userId}/`) ||
      audioPath.includes("..")
    ) throw new Error("Finální MP3 nemá platnou cestu vlastníka.");
    const backend = mode === "static_cover"
      ? "ffmpeg"
      : mode === "image_animation"
      ? "vm_image_animation"
      : "vm_full_scenes";
    const renderPrompt = clip(args.prompt, 2_000) ||
      `SongCraft video mode: ${mode}. Song: ${clip(song.title, 140)}. Style: ${
        clip(song.style_prompt, 600)
      }. Lyrics/context: ${clip(song.lyrics, 1_800)}.`;
    const { data, error } = await admin.from("agent_videos").insert({
      user_id: userId,
      song_id: song.id,
      type: mode,
      mode,
      backend,
      audio_storage_path: audioPath,
      prompt_used: renderPrompt,
      render_status: "queued",
    }).select("id,render_status,mode,backend").single();
    if (error || !data) {
      throw new Error(error?.message || "Render se nepodařilo založit.");
    }
    await log(admin, userId, name, "success", { mode, backend }, data.id);
    return {
      status: "queued",
      videoId: data.id,
      mode: data.mode,
      backend: data.backend,
    };
  }
  if (name === "make_music_video" || name === "make_short") {
    const isShort = name === "make_short";
    const song = await row(
      admin,
      "sc_songs",
      String(args.songId),
      userId,
      "id,title,lyrics,style_prompt,cover_path,source_video_path",
    );
    if (!song.cover_path) {
      throw new Error(
        "Tato píseň nemá obal. Nejdřív vygeneruj obal, nebo nahraj vlastní.",
      );
    }
    const motionPrompt = clip(args.motionPrompt, 500);
    if (!isShort && !motionPrompt) {
      throw new Error(
        "Napiš, co se má na obrázku rozpohybovat, například 'rozhybej postavu'.",
      );
    }

    // finální audio - celé video bere délku zvuku
    const { data: versions, error: versionError } = await admin.from(
      "sc_audio_versions",
    )
      .select("id,tagged_storage_path,original_storage_path,storage_path")
      .eq("song_id", song.id).eq("user_id", userId).eq("is_final", true)
      .order("is_primary", { ascending: false }).order("rating", {
        ascending: false,
      }).limit(1);
    if (versionError || !versions?.[0]) {
      throw new Error("Pro render musí být vybraná finální MP3 verze.");
    }
    const v = versions[0] as {
      tagged_storage_path?: string | null;
      original_storage_path?: string | null;
      storage_path?: string | null;
    };
    const audioPath = v.tagged_storage_path || v.original_storage_path ||
      v.storage_path;
    if (
      typeof audioPath !== "string" || !audioPath.startsWith(`${userId}/`) ||
      audioPath.includes("..")
    ) throw new Error("Finální MP3 nemá platnou cestu vlastníka.");

    // Nahrane video: nepotrebujeme plan pohybu, sam se smycka.
    const hasSourceVideo = typeof song.source_video_path === "string" &&
      song.source_video_path.startsWith(`${userId}/`) &&
      !song.source_video_path.includes("..");
    if (hasSourceVideo) {
      const { data: looped, error: loopErr } = await admin.from("agent_videos")
        .insert({
          user_id: userId,
          song_id: song.id,
          type: "video_loop",
          mode: "video_loop",
          backend: "ffmpeg",
          aspect: isShort ? "9:16" : "16:9",
          audio_storage_path: audioPath,
          prompt_used: "smyčka z nahraného videa",
          motion_prompt: null,
          source_video_path: song.source_video_path,
          recipe_source: "uploaded_video",
          render_status: "queued",
        }).select("id,render_status,mode,backend,aspect").single();
      if (loopErr || !looped) {
        throw new Error(loopErr?.message || "Render se nepodařilo založit.");
      }
      await log(admin, userId, name, "success", {
        videoId: looped.id,
        from: "uploaded_video",
      }, looped.id);
      return {
        status: "queued",
        videoId: looped.id,
        aspect: looped.aspect,
        mode: looped.mode,
        hybe_se: "nahrané video v smyčce přes celou skladbu",
      };
    }

    // obal -> base64 pro vision
    const art = await admin.storage.from("songcraft").download(song.cover_path);
    if (art.error) {
      throw new Error(`Obal se nepodařilo načíst: ${art.error.message}`);
    }
    const bytes = new Uint8Array(await art.data.arrayBuffer());
    if (!bytes.byteLength) throw new Error("Obal je prázdný.");
    // MIME SE ČTE Z HLAVIČEK, NE Z PŘÍPONY. Změřeno živě na datech Temneyho:
    // `…/covers/1790710855990-12338.png` má 476 KB a magic hlavičku
    // `FF D8 FF E0` = JPEG. Dřív se podle `.png` posílalo `image/png` s JPEG
    // bajty, což je lež, kterou vision endpoint nemusí odpustit.
    const mime = sniffImageMime(bytes);
    if (!mime) {
      throw new Error(
        "Obal není obrázek, který se dá poslat do vision analýzy (PNG, JPEG, WebP nebo GIF).",
      );
    }
    const b64 = toBase64(bytes);
    // Data URL jde do JSON těla, takže se počítá base64 délka, ne bajty:
    // base64 je 4/3 větší a JSON tělo posíláme v jednom kusu.
    if (b64.length > MAX_B64_VISION) {
      throw new Error(
        "Obal je moc velký pro vision analýzu (max 6 MB).",
      );
    }

    const vp = visionProvider(PROVIDERS, envKeys());
    if (!vp) {
      // PŘESNOST ZPRÁVY: dřív tady bylo „Bez GOOGLE_AI_STUDIO_KEY nelze…", což
      // bylo věcně špatně — klíč mohl být a stejně to nepomohlo, protože
      // `envKeys()` četl JEN dvě Gemini proměnné (llm-map §4, §8.10). Tady už
      // hledáme libovolného poskytovatele s VIDĚCÍM modelem, takže zpráva musí
      // říct pravdu: žádný vidoucí model není nakonfigurovaný.
      throw new Error(
        "Plán pohybu teď nejde napsat: v AI řetězci není žádný vidoucí model, "
          + "který by uměl vidět tenhle obal. Je potřeba klíč k poskytovateli "
          + "s vision modelem (NVIDIA / OpenRouter). Bez něj radši nehádám, co "
          + "se má hýbat — použij make_long_video nebo make_short_video, ty "
          + "vidění nepotřebují.",
      );
    }
    const planned = await planMotion({
      key: vp.key,
      base: vp.base,
      models: vp.models,
      imageBase64: b64,
      mimeType: mime,
      prompt: motionPrompt ||
        (isShort ? "vyber nejvýraznější věc v obrázku a nech ji žít" : ""),
      songTitle: clip(song.title, 140),
      style: clip(song.style_prompt, 400),
    });
    if (!planned.recipe) {
      await log(
        admin,
        userId,
        name,
        "error",
        { motionPrompt, reason: planned.reason, model: planned.model },
        song.id,
        planned.reason,
      );
      throw new Error(
        `Plán pohybu se nepodařilo vytvořit: ${
          planned.reason ?? "neznámý důvod"
        }. Napiš to prosím jinak, třeba konkrétněji, co na obrázku je.`,
      );
    }

    const { data: recipeRow, error: recipeError } = await admin.from(
      "motion_recipes",
    ).insert({
      user_id: userId,
      song_id: song.id,
      source_storage_path: song.cover_path,
      prompt: motionPrompt,
      recipe: planned.recipe,
      source: "agent_vision",
    }).select("id").single();
    if (recipeError) throw new Error(recipeError.message);

    const aspect = isShort ? "9:16" : "16:9";
    // Kanonický render type musí být jeden ze čtyř, které worker umí a které
    // povoluje agent_videos_type_check. Pohyb z vize se renderuje přes
    // image_animation (dashboard I2V z obalu + prompt); původní
    // short/lyric_video/living_motion/vm_living porušovalo CHECK a job skončil
    // v failed bez toho, aby se na něj vůbec dostal worker.
    const { data, error } = await admin.from("agent_videos").insert({
      user_id: userId,
      song_id: song.id,
      type: "image_animation",
      mode: "image_animation",
      backend: "vm_image_animation",
      aspect,
      audio_storage_path: audioPath,
      prompt_used: motionPrompt,
      motion_prompt: motionPrompt,
      motion_recipe: planned.recipe,
      recipe_source: "agent_vision",
      render_status: "queued",
    }).select("id,render_status,mode,backend,aspect").single();
    if (error || !data) {
      throw new Error(error?.message || "Render se nepodařilo založit.");
    }
    await log(admin, userId, name, "success", {
      videoId: data.id,
      aspect,
      recipeId: recipeRow?.id,
      model: planned.model,
    }, data.id);
    return {
      status: "queued",
      videoId: data.id,
      aspect,
      mode: data.mode,
      hybe_se: describeRecipe(planned.recipe),
      note: clip(planned.recipe.note, 300),
    };
  }
  if (name === "make_long_video" || name === "make_short_video") {
    const isShort = name === "make_short_video";
    const song = await row(
      admin,
      "sc_songs",
      String(args.songId),
      userId,
      "id,title,cover_path,album_id,source_video_path",
    );
    if (!song.cover_path && !song.source_video_path) {
      throw new Error(
        "Tato píseň nemá obal ani nahráté video. Nejdřív nahraj obraz, nebo video.",
      );
    }
    // Finální audio určuje délku videa. Bez finální verze nemá smysl render.
    const { data: versions, error: versionError } = await admin.from(
      "sc_audio_versions",
    )
      .select("id,tagged_storage_path,original_storage_path,storage_path")
      .eq("song_id", song.id).eq("user_id", userId).eq("is_final", true)
      .order("is_primary", { ascending: false }).order("rating", {
        ascending: false,
      }).limit(1);
    if (versionError || !versions?.[0]) {
      throw new Error("Pro render musí být vybraná finální MP3 verze.");
    }
    const v = versions[0] as {
      tagged_storage_path?: string | null;
      original_storage_path?: string | null;
      storage_path?: string | null;
    };
    const audioPath = v.tagged_storage_path || v.original_storage_path ||
      v.storage_path;
    if (
      typeof audioPath !== "string" || !audioPath.startsWith(`${userId}/`) ||
      audioPath.includes("..")
    ) throw new Error("Finální MP3 nemá platnou cestu vlastníka.");

    const hasSourceVideo = typeof song.source_video_path === "string" &&
      song.source_video_path.startsWith(`${userId}/`) &&
      !song.source_video_path.includes("..");
    const aspect = isShort ? "9:16" : "16:9";
    const { data, error } = await admin.from("agent_videos").insert({
      user_id: userId,
      song_id: song.id,
      type: "source_loop",
      mode: "source_loop",
      backend: "ffmpeg",
      aspect,
      audio_storage_path: audioPath,
      prompt_used: clip(args.note, 2_000) ||
        (isShort ? "krátké svislé video" : "celé video na skladbu"),
      motion_prompt: null,
      source_video_path: hasSourceVideo ? song.source_video_path : null,
      recipe_source: hasSourceVideo ? "uploaded_video" : "cover_artwork",
      render_status: "queued",
    }).select("id,render_status,mode,backend,aspect").single();
    if (error || !data) {
      throw new Error(error?.message || "Render se nepodařilo založit.");
    }
    await log(admin, userId, name, "success", {
      videoId: data.id, aspect, source: hasSourceVideo ? "video" : "obal",
    }, data.id);
    return {
      status: "queued",
      videoId: data.id,
      aspect: data.aspect,
      zdroj: hasSourceVideo ? "nahráté video skladby" : "obal skladby",
      hybe_se:
        `Rozjelo se to. Video vznikne ze ${hasSourceVideo ? "nahrátého videa skladby" : "obalu skladby"}, dlouhé je jako skladba, průchody různě dlouhé a přechody nejsou vidět. Slíbeno, jak bude hotovo.`,
    };
  }
/** Druhy operací, které jdou do fronty agent_ops na VM. */
const OPS_ACTIONS = new Set([
  "run_vm_command",
  "push_git_branch",
  "deploy_worker",
  "read_repo_file",
  "read_skills",
]);

/**
 * Založí operaci ve stavu pending_confirmation..ops-runner na VM bere VYHRADNĚ
 * řádky ve stavu approved, takže bez potvrzení se nic nespustí.
 */
async function queueOp(
  admin: any,
  userId: string,
  kind: string,
  args: Record<string, unknown>,
  summary: string,
  command?: string,
) {
  // Token se vygeneruje tady, uloží se jen jeho hash a uživateli se vrátí
  // samotný token. Bez shody tokenu a hashe agent-confirm operaci neschválí,
  // takže samotné ID řádku nestačí.
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  const nonceHash = await hashConfirmationToken(token);
  // Sloupec command je povinný pro kind shell (CHECK agent_ops_command_present),
  // args nese parametry ostatních druhů. Bez command by insert spadl.
  const { data, error } = await admin.from("agent_ops").insert({
    user_id: userId,
    kind,
    command: command ?? null,
    args,
    summary: clip(summary, 300),
    status: "pending_confirmation",
    nonce_hash: nonceHash,
    requires_confirmation: true,
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  }).select("id,kind,summary,status").single();
  if (error || !data) throw new Error(error?.message || "Operaci se nepodařilo založit.");
  return { ...data, token };
}

function pendingOp(op: { id: string; kind: string; summary: string; token: string }) {
  return {
    status: "pending_confirmation",
    confirmationId: op.id,
    confirmationToken: op.token,
    action: op.kind,
    kind: op.kind,
    summary: op.summary,
  };
}

  if (OPS_ACTIONS.has(name)) {
    const why = clip(args.why ?? "", 300);
    if (name === "run_vm_command") {
      const command = String(args.command ?? "");
      if (!command.trim()) throw new Error("Chybí command.");
      if (command.length > 4_000) throw new Error("Příkaz je příliš dlouhý.");
      if (/sudo|rm\s+-rf|\bDROP\b|\bTRUNCATE\b|\bDELETE\b\s+FROM/i.test(command)) {
        throw new Error("Tento příkaz je zablokovaný. Bezpečnostní pravidlo: agent nesmí mazat, mazat tabulky ani používat sudo.");
      }
      const op = await queueOp(admin, userId, "shell", { command }, `příkaz na VM: ${command.slice(0, 120)}`, command);
      await log(admin, userId, name, "pending", { opId: op.id, why });
      return pendingOp({ ...op, summary: `${why} — ${command.slice(0, 120)}` });
    }
    if (name === "check_op_status") {
      const { data, error } = await admin.from("agent_ops")
        .select("id,kind,status,summary,output,exit_code,error_message,created_at,finished_at")
        .eq("user_id", userId)
        .eq("id", String(args.operationId ?? ""))
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error("Operace nenalezena.");
      return { status: "success", operation: data };
    }
    if (name === "push_git_branch") {
      const branch = String(args.branch ?? "");
      if (!/^[\w./-]+$/.test(branch)) throw new Error("Neplatný název větve.");
      const op = await queueOp(admin, userId, "git_push", { branch }, `push větve ${branch}: ${why}`);
      await log(admin, userId, name, "pending", { opId: op.id, branch, why });
      return pendingOp(op);
    }
    if (name === "deploy_worker") {
      const op = await queueOp(admin, userId, "deploy_worker", {}, `nasadit workera na VM: ${why}`);
      await log(admin, userId, name, "pending", { opId: op.id, why });
      return pendingOp(op);
    }
    if (name === "read_repo_file") {
      const op = await queueOp(admin, userId, "read_file", { path: String(args.path ?? ""), ref: String(args.ref ?? "main") }, `čtení ${args.path} z repa`);
      await log(admin, userId, name, "pending", { opId: op.id });
      return pendingOp(op);
    }
    const op = await queueOp(admin, userId, "read_skills", {}, "čtení skills dokumentace");
    await log(admin, userId, name, "pending", { opId: op.id });
    return pendingOp(op);
  }
  if (name === "create_recommendation") {
    const { data, error } = await admin.from("agent_recommendations").insert({
      user_id: userId,
      category: args.category ?? "strategy",
      recommendation: clip(args.recommendation, 2000),
      reasoning: clip(args.reasoning, 3000),
    }).select("id,status").single();
    if (error) throw new Error(error.message);
    await log(admin, userId, name, "success", args, data.id);
    return data;
  }
  if (name === "schedule_publication") {
    const song = await row(
      admin,
      "sc_songs",
      String(args.songId),
      userId,
      "id,title,cover_path",
    );
    const requestedVideoId = clip(args.videoId, 80);
    let videoId = requestedVideoId;
    if (videoId) {
      await row(
        admin,
        "agent_videos",
        videoId,
        userId,
        "id,song_id,render_status",
      );
    } else {
      const { data: readyVideo, error: readyError } = await admin.from(
        "agent_videos",
      ).select("id").eq("song_id", song.id).eq("user_id", userId).eq(
        "render_status",
        "ready",
      ).order("created_at", { ascending: false }).limit(1);
      if (readyError) throw new Error(readyError.message);
      videoId = readyVideo?.[0]?.id ?? "";
    }
    if (!videoId) {
      throw new Error("Před publikací je potřeba hotové video ve stavu ready.");
    }
    const { data: video, error: videoError } = await admin.from("agent_videos")
      .select("id,render_status,storage_path").eq("id", videoId).eq(
        "song_id",
        song.id,
      ).eq("user_id", userId).maybeSingle();
    if (
      videoError || !video || video.render_status !== "ready" ||
      !video.storage_path
    ) throw new Error("Video není připravené k vytvoření publikace.");
    const suggested = typeof args.scheduledAt === "string" && args.scheduledAt
      ? args.scheduledAt
      : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await admin.from("youtube_publications").insert({
      user_id: userId,
      song_id: song.id,
      video_id: video.id,
      title: clip(args.title, 100) || `Temney – ${song.title}`,
      thumbnail_path: song.cover_path,
      scheduled_at: suggested,
      status: "draft",
      privacy_status: "private",
    }).select("id,status,scheduled_at,video_id").single();
    if (error || !data) {
      throw new Error(error?.message || "Publikace se nepodařilo vytvořit.");
    }
    await log(admin, userId, name, "success", {
      scheduledAt: suggested,
      videoId: video.id,
    }, data.id);
    return data;
  }
  throw new Error(`Neznámý nástroj: ${name}`);
}

Deno.serve(async (request) => {
  try {
    return await handle(request);
  } catch (error) {
    console.error(
      "agent-orchestrator request failed",
      error instanceof Error ? error.message : String(error),
    );
    return json({
      error: "AI manažer selhal při zpracování požadavku. Zkus to znovu.",
    }, 500);
  }
});

async function handle(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (request.method !== "POST") return json({ error: "Použij POST." }, 405);
  const authorization = request.headers.get("Authorization");
  if (!authorization) return json({ error: "Neplatné přihlášení." }, 401);
  const url = Deno.env.get("SUPABASE_URL") ||
    Deno.env.get("SONGCRAFT_SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ||
    Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SONGCRAFT_SERVICE_ROLE_KEY");
  if (!url || !anon || !service) {
    return json({
      error:
        "Agent není nakonfigurovaný. Nastav Supabase secrets (SUPABASE_URL, klíče a service role klíč).",
    }, 503);
  }
  const auth = createClient(url, anon, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: { user }, error: authError } = await auth.auth.getUser();
  if (authError || !user) return json({ error: "Neplatné přihlášení." }, 401);
  if (
    !isAllowedPrivateUser(user, {
      allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined,
      allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined,
    })
  ) return json({ error: privateAccessMessage() }, 403);
  const admin = createClient(url, service);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 64 * 1024) {
    return json({ error: "Požadavek agenta je příliš velký." }, 413);
  }
  const input = await request.json().catch(() => null) as Input | null;
  const message = clip(input?.message, 2000);
  if (!message) return json({ error: "Napiš zprávu pro agenta." }, 400);
  let conversationId: string;
  try {
    conversationId = await ensureConversation(
      admin,
      user.id,
      input?.conversationId,
      message,
    );
    await appendConversationMessage(
      admin,
      user.id,
      conversationId,
      "user",
      message,
    );
  } catch (error) {
    return json({
      error: error instanceof Error
        ? error.message
        : "Konverzaci se nepodařilo připravit.",
    }, 400);
  }
  const system =
    `Jsi Temney Agent v SongCraft Studio. Odpovídej česky. Používej nástroje, když můžeš provést konkrétní bezpečný krok. Nikdy netvrď, že se akce stala, pokud nástroj nevrátil úspěch. Veřejné akce jsou vždy pending_confirmation. Character bible: ${CHARACTER_BIBLE}. Soukromá data patří pouze ověřenému user_id ${user.id}.;

VIDEO — pravidla, která nesmíš porušit:
- Video je default make_long_video. Když uživatel řekne "udělej k téhle písně video", použij ho. Engine si sám vybere délky průchodů i přechody, takže NEPIŠ motionPrompt a NIC nevymýšlej: žádný kouř, blesky, déšť ani blikání, o co uživatel nežádal.
- Když uživatel řekne "short" / "vertical" / "Shorts" / "reels" / "kratke video", použij make_short_video (9:16).
- Když řekne "udělej to znovu" nebo "chci jinou verzi", klidně použij make_long_video znovu: pokaždé vyjde jiné, protože engine skládá průchody náhodně.
- make_music_video a make_short jsou jen starší cesta se zadaným motionPrompt. Použij je, jen když uživatel VÝSLOVNĚ řekne, co se má rozpohybovat, a chce přesně to. V takovém případě PŘEDEJ jeho vlastní slova a nic si nepřidávej.
- Když má píseň nahrané vlastní video, make_music_video i make_short místo plánu pohybu udělají plynulou smyčku z toho videa přes celou skladbu. Není třeba psát motionPrompt a nesmíš tvrdit, že jsi vymyslel vlastní pohyb.
- make_music_video vrací co se bude hýbat. To uživateli řekni slovy, ne jsonem.
- Render je asynchronní. Neříkej "hotovo", ale "rozjelo se, hlásím se po dokončení", a pak zkontroluj stav (check_video_status).
- OPERACE NA VM: run_vm_command, push_git_branch, deploy_worker, read_repo_file a read_skills VŽDY vracejí stav pending_confirmation. To znamená, že se NIC NESPUSTÍ, dokud uživatel neřekne ano. Uživateli vždy napiš slovy, CO přesně se má spustit (příkaz, větev, soubory) a počkej na jeho odpověď. Výsledek operace zjistíš přes check_op_status.
- Nikdy si nevymýšlej, že operace proběhla, dokud check_op_status nevrátí done. Pokud vrátí failed, přečti error_message a řekni uživateli, co se pokazalo.
- Publikování: nikdy nepublikuj bez výslovného "ok" uživatele. Nejdřív připrav koncept (generate_metadata + schedule_publication jako draft), ukaž uživateli náhled a titulky, a publikuj až když řekne ano. publish_to_youtube vždy vyžaduje potvrzení.`;
  const contents: LlmMessage[] = [...historyFrom(input ?? {}), {
    role: "user",
    parts: [{ type: "text", text: message }],
  }];
  let finalText = "";
  const pending: unknown[] = [];
  for (let step = 0; step < 6; step += 1) {
    const response = await llm(system, contents, toolDefs, true);
    const calls = response.calls.map((call) => ({
      ...call,
      id: call.id ?? crypto.randomUUID(),
    }));
    if (response.text) finalText = response.text;
    if (!calls.length) break;
    contents.push({
      role: "model",
      parts: calls.map((call) => ({
        type: "functionCall",
        name: call.name,
        args: call.args,
        id: call.id,
      })),
    });
    for (const call of calls) {
      const name = call.name ?? "";
      try {
        const result = await dispatch(admin, user.id, name, call.args ?? {});
        if ((result as any)?.status === "pending_confirmation") {
          pending.push({ tool: name, ...result });
        }
        const modelResult = result && typeof result === "object"
          ? {
            ...(result as Record<string, unknown>),
            confirmationToken: "[withheld]",
          }
          : result;
        contents.push({
          role: "function",
          parts: [{
            type: "functionResponse",
            name,
            response: modelResult,
            id: call.id,
          }],
        });
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : "Nástroj selhal.";
        await log(
          admin,
          user.id,
          name,
          "error",
          call.args ?? {},
          undefined,
          message,
        );
        contents.push({
          role: "function",
          parts: [{
            type: "functionResponse",
            name,
            response: { error: message },
            id: call.id,
          }],
        });
      }
    }
  }
  if (!finalText) {
    finalText = "Úkol jsem zpracoval, ale agent nevrátil textové shrnutí.";
  }
  if (pending.length) {
    finalText += `\n\nČeká na potvrzení:\n${
      pending.map((item: any) => `• ${item.tool}`).join("\n")
    }`;
  }
  try {
    await appendConversationMessage(
      admin,
      user.id,
      conversationId,
      "model",
      finalText,
    );
    await admin.from("agent_conversations").update({
      title: clip(message, 120),
      updated_at: new Date().toISOString(),
    }).eq("id", conversationId).eq("user_id", user.id);
  } catch (error) {
    await log(
      admin,
      user.id,
      "conversation_persist",
      "error",
      {},
      conversationId,
      error instanceof Error
        ? error.message
        : "Persistence konverzace selhala.",
    );
  }
  return json({ answer: finalText, pending, conversationId });
}
