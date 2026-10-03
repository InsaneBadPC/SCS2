import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isAllowedPrivateUser, privateAccessMessage } from "../_shared/access.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const clean = (value: unknown) => typeof value === "string" ? value.trim().slice(0, 60) : "";
const uniq = (list: string[], limit: number) => [...new Set(list.filter(Boolean).map((entry) => entry.toLowerCase()))].slice(0, limit);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "Použij POST požadavek." }, 405);
  const authorization = request.headers.get("Authorization");
  const geminiKey = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
  if (!authorization) return json({ error: "Chybí přihlášení." }, 401);
  if (!geminiKey) return json({ error: "Hledač rýmů není správně nakonfigurován." }, 503);

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

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: instruction }] },
      contents: [{ role: "user", parts: [{ text: `Rýmy ke slovu: ${word}` }] }],
      generationConfig: { temperature: 0.8, maxOutputTokens: 4000, thinkingConfig: { thinkingLevel: "low" } },
    }),
  });
  if (!response.ok) return json({ error: "AI teď odmítla požadavek. Zkus to za chvíli." }, response.status === 429 ? 429 : 502);
  const generated = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
  let raw = generated.candidates?.[0]?.content?.parts?.map((part) => typeof part.text === "string" ? part.text : "").join("\n").trim() ?? "";
  raw = raw.replace(/^```(?:json)?\n?/i, "").replace(/```$/g, "").trim();
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return json({ error: "AI nevrátila platný výsledek." }, 502);
  try {
    const parsed = JSON.parse(match[0]) as { exact?: unknown; multiword?: unknown; assonance?: unknown };
    const toArray = (value: unknown) => Array.isArray(value) ? value.map(clean) : [];
    return json({
      exact: uniq(toArray(parsed.exact), 12),
      multiword: uniq(toArray(parsed.multiword), 12),
      assonance: uniq(toArray(parsed.assonance), 8),
    });
  } catch {
    return json({ error: "AI nevrátila platný výsledek." }, 502);
  }
});
