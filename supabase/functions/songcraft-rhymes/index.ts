import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isAllowedPrivateUser, privateAccessMessage } from "../_shared/access.ts";
import { hasLlmKey, LlmError, llmComplete } from "../_shared/llm.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const clean = (value: unknown) => typeof value === "string" ? value.trim().slice(0, 60) : "";
const uniq = (list: string[], limit: number) => [...new Set(list.filter(Boolean).map((entry) => entry.toLowerCase()))].slice(0, limit);

// Model pro rýmy — vybrán živým měřením 2026-10-05 (viz report k výměně).
// Porovnání na slovech noc / srdce / sen:
//   nvidia/nemotron-3-super-120b-a12b → "moc", jen/pen/den/len/ven/zen/gen;
//                                    assonance SKOREC reálná slova (staré, těžké)
//   nvidia/nemotron-3-ultra-550b    → "moc", "bloc", "ploc"; "klen", "zelen",
//                                    "přítomen" = vymyšlené a oříznuté tvary
//   openai/gpt-oss-20b               → vrací ZPÁTKY hledané slovo ("noc" jako
//                                    rýmu k "noc") a 3+ minuty na odpověď
//   qwen/gwen3.8-27b:free / gemma    → celý `:free` povrch je 50 req/den
const RHYME_MODEL = "nvidia/nemotron-3-super-120b-a12b";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "Použij POST požadavek." }, 405);
  const authorization = request.headers.get("Authorization");
  if (!authorization) return json({ error: "Chybí přihlášení." }, 401);
  if (!hasLlmKey()) return json({ error: "Hledač rýmů není správně nakonfigurován." }, 503);

  const supabase = createClient(Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL") || "", Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY") || "", { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return json({ error: "Neplatné přihlášení." }, 401);
  if (!isAllowedPrivateUser(user, { allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined, allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined })) return json({ error: privateAccessMessage() }, 403);

  const input = await request.json().catch(() => null) as { word?: string; exclude?: unknown } | null;
  const word = clean(input?.word);
  if (!word || word.length < 2) return json({ error: "Zadej hledané slovo." }, 400);
  const excludeValues = input && Array.isArray(input.exclude) ? input.exclude : [];
  const exclude = excludeValues.map(clean).filter(Boolean).slice(0, 60);
  const endingMatch = /[aáeéěiíoóuúůyý][^aáeéěiíoóuúůyý]*$/i.exec(word);
  const ending = endingMatch ? endingMatch[0] : word.slice(-2);
  const lastVowelMatch = /[aáeéěiíoóuúůyý]/i.exec(ending);
  const lastVowel = lastVowelMatch ? lastVowelMatch[0].toLowerCase() : "";

  const instruction = [
    "Jsi mistr českého rytmování — textař s dokonalou znalostí české fonetiky a morfologie.",
    "Uživatel hledá rýmy ke slovu ve tvaru: „" + word + "“.",
    "KRITICKÉ PRAVIDLO: rýma se řídí zvukem od poslední přízvučné samohlásky do konce slova. Zadané slovo končí zvukem „" + ending + "“ (poslední samohláska je „" + lastVowel + "“).",
    "ABSOLUTNÍ ZÁKAZ: žádný návrh nesmí končit jinou samohláskou než „" + lastVowel + "“. Návrh s jinou koncovou hláskou než konec slova „" + word + "“ je NEPLATNÝ a musí být vypuštěn.",
    "Dlouhá a krátká verze téže samohlásky (u/ů/ú, i/í, e/é) se uznávají jako shodné.",
    "",
    "Vrať tři skupiny:",
    "exact — jednoslovná přesná rýma končící zvukově na „" + ending + "“. Vzor kvality: pro „smůlu“ jsou nejlepší rýmy nulu, školu, dolu, polu.",
    "multiword — SKUPINOVÉ rýmy: spojení (předložka/zájmeno + slovo), jehož poslední slovo končí zvukově na „" + ending + "“. Vzor: pro „smůlu“ → do důlu, u stolu, na půlu.",
    "assonance — téměř rýma: shodná koncová samohláska „" + lastVowel + "“, podobné souhlásky. Vzor: pro „smůlu“ → bulu, muru.",
    "",
    "MÁLO RÝMŮ? TO JE V POŘÁDKU: pro některé tvary existuje jen pár skutečných rýmů (např. ke „smůlu“ reálně patří hlavně nulu, školu, dolu). Vrať jen to, co opravdu existuje — kratší pravdivý seznam porazí dlouhý seznam s nesmysly.",
    "POUZE SKUTEČNÁ ČESKÁ SLOVA: každý návrh musí být reálné existující české slovo nebo běžná hovorová podoba. Přísně ZAKÁZÁNO vymýšlet si slova, zkracovat je uměle nebo měnit jejich koncovku jen kvůli rýmu.",
    "Tato rýmy už uživatel viděl a PŘESNĚ JE MUSÍŠ VYNECHAT, hledej pouze JINÉ: " + (exclude.length ? exclude.join(", ") : "(první kolo — nic nevynechávej)") + ".",
    "KONTROLA PŘED ODESLÁNÍM: 1) Je každý návrh skutečné české slovo? 2) Přečti si každý návrh nahlas po hláskách od konce. Nezní-li jeho konec stejně jako konec slova „" + word + "“, SMAŽ ho. Toto pravidlo má nejvyšší prioritu.",
    "Vrať POUZE JSON ve tvaru {\"exact\":[\"…\"],\"multiword\":[\"…\"],\"assonance\":[\"…\"]} — exact max 12, multiword max 12, assonance max 8 položek, bez vysvětlení.",
  ].join("\n");

  let raw = "";
  try {
    // `thinkingConfig.thinkingLevel` z původního Gemini těla je ZAMAZÁN — nemá
    // ekvivalent. Místo toho dostává reasoning model vlastní rozpočet uvnitř
    // `llm.ts`, jinak sežere `max_tokens` a vrátí `content: null`.
    const result = await llmComplete({
      system: instruction,
      messages: [{ role: "user", content: `Rýmy ke slovu: ${word}` }],
      temperature: 0.8,
      maxTokens: 4_000,
      json: true,
      timeoutMs: 75_000,
      prefer: [{ provider: "nvidia", model: RHYME_MODEL }],
    });
    raw = result.text;
  } catch (error) {
    const status = error instanceof LlmError ? error.status : 502;
    return json({ error: "AI teď odmítla požadavek. Zkus to za chvíli." }, status === 429 ? 429 : 502);
  }
  raw = raw.replace(/^```(?:json)?\n?/i, "").replace(/```$/g, "").trim();
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return json({ error: "AI nevrátila platný výsledek." }, 502);
  try {
    const parsed = JSON.parse(match[0]) as { exact?: unknown; multiword?: unknown; assonance?: unknown };
    const toArray = (value: unknown) => Array.isArray(value) ? value.map(clean) : [];
    // Bezplatný model občas vrátí HLEDANÉ SLOVO jako jeho vlastní rýmu
    // (naměřeno: `sen` → exact:["sen", …]). Není to rýma, je to chyba, a jde
    // to ověřit mechanicky — na rozdíl od fonologie, kterou tady ověřit nejde
    // (viz poznámka u RHYME_MODEL).
    const notItself = (list: string[]) => list.filter((entry) => entry.toLowerCase() !== word.toLowerCase());
    return json({
      exact: uniq(notItself(toArray(parsed.exact)), 12),
      multiword: uniq(notItself(toArray(parsed.multiword)), 12),
      assonance: uniq(toArray(parsed.assonance), 8),
    });
  } catch {
    return json({ error: "AI nevrátila platný výsledek." }, 502);
  }
});
