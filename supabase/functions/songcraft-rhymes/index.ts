import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isAllowedPrivateUser, privateAccessMessage } from "../_shared/access.ts";
import { hasLlmKey, llmComplete, llmFailureMessage } from "../_shared/llm.ts";
import { guardRhymes, promoteExactFromMultiword, rhymeTail, shouldRetry, type GuardedRhymes } from "../_shared/rhyme-guard.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const clean = (value: unknown) => typeof value === "string" ? value.trim().slice(0, 60) : "";

// Model pro rýmy — vybrán živým měřením 2026-10-05 (viz report k výměně).
// Porovnání na slovech noc / srdce / sen, PLUS testy alternativ, když už
// jednou padaly rýmy:
//   nvidia/nemotron-3-super-120b-a12b → jediný použitelný kandidát. Ostatní
//                                    možnosti byly vyřazené živým měřením,
//                                    ne odhadem — viz níže.
//   nvidia/nemotron-3-ultra-550b    → 503 „temporarily overloaded“
//   google/gemma-4-31b-it           → bez odpovědi > 60 s (timeout)
//   google/gemma-4-26b-a4b-it       → HTTP 404, na tomhle účtu není
//   deepseek-ai/deepseek-v4.1-flash → bez odpovědi > 60 s (timeout)
//   qwen/gemma přes OpenRouter `:free` → celý `:free` povrch je 50 req/den
//     NA CELÝ ÚČET a je vyčerpaný (viz `_shared/llm.ts`), takže to není volba
//
// Proto se rozšíření modelového seznamu jako oprava NEPOUŽILO: na NVIDIA
// nezbývá žádný jiný text model, který by českou fonologii zvládal lépe. Místo
// toho je oprava v `_shared/rhyme-guard.ts` + jeden dotaz s přísnějším promptem.
const RHYME_MODEL = "nvidia/nemotron-3-super-120b-a12b";

/**
 * Rozpočet odpovědi v tokenech. `llm.ts` přičte `reasoningCost`, takže na
 * provider letí ~2968 tokenů. Naměřeno živě: pod ~2232 model vrací
 * `content: null` (2 běhy na `sen`, 2 na `srdce`), nad ~3000 odpovídá za 7–15 s.
 * Mezi těmito hodnotami je to dráha, ne přesná hranice, proto je 2200 s rezervou.
 */
const RHYME_MAX_TOKENS = 2_200;

/**
 * Rozpočet JEDNOHO pokusu. Naměřeno živě: 20–45 s na NVIDIA, bez tohoto knobu
 * (viz `providerExtraBody`), protože reasoning si bere většinu rozpočtu.
 */
const ATTEMPT_TIMEOUT_MS = 70_000;

/**
 * Rozpočet CELÉHO hledání — ne jednoho pokusu.
 *
 * Naměřený strop edge funkce je ~150 s (`HTTP 546 WORKER_RESOURCE_LIMIT`).
 * Dva pokusy po 70 s by byly 140 s, tedy bez rezervy, a na hranici se to
 * začne střáhat. Proto je to 135 s a druhý pokus se spouští jen když na něj
 * reálně zbývá čas — jinak by to byl visící požadavek, což je přesně ta věc,
 * kterou původní tři funkce měly chybně (neměly timeout vůbec).
 */
const TOTAL_BUDGET_MS = 135_000;

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
  // Rýmová koncovka pro kontrolu v `rhyme-guard.ts`. Není to poslední
  // samohláska — je to všechno od poslední samohlásky do konce, protože jinak
  // by kontrola považovala „kde“ za rýmu ke „srdce“ (oba končí na „e“).
  const tail = rhymeTail(word) || ending;

  // Základní prompt. Kromě pravidel o cizích jazycích a o nalešovaných frázích
  // je ZÁMĚRNĚ KRÁTKÝ — původně 2367 znaků. Důvod je naměřený, ne estetický:
  // s dlouhým promptem reasoning model vypálí celý `max_tokens` na přemýšlení a
  // vrátí `content: null` + `finish_reason:"length"` (viz `_shared/llm.ts`,
  // poznámka A). Naměřeno na „srdce“: původní prompt 38 s a prázdný výstup,
  // zkrácený 9 s. Chybějící odpověď je horší než pomalejší odpověď.
  const buildInstruction = (skip: string[]) => [
    "Jsi český textař. Hledej rýmy ke slovu „" + word + "“, které končí zvukem „" + tail + "“ (poslední samohláska „" + lastVowel + "“).",
    "",
    "Pravidla, která nesmíš porušit:",
    "1. Přesná rýma zní stejně jako konec slova OD POSLEDNÍ SAMOHLÁSKY. Slovo končící jen stejnou samohláskou NENÍ přesná rýma.",
    "2. Jen SKUTEČNÁ ČESKÁ SLOVA. ZAKÁZÁNO vymýšlet si slova a měnit koncovku kvůli rýmu. ZAKÁZÁNO anglická, německá i jiná cizí slova.",
    "3. Krátká a dlouhá verze téže samohlásky (u/ů/ú, i/í, e/é) jsou shodné.",
    "4. Radši MENĚ než vymyšlenina. Pokud české rýmy neznáš, vrať prázdné pole.",
    "5. V multiword nesmí poslední slovo být „" + word + "“. Skupina má 2–3 slova, ne celou větu.",
    "6. Tato už byla vidět a MUSÍŠ JE VYNECHAT, hledej jen JINÉ: " + (skip.length ? skip.join(", ") : "(první kolo)") + ".",
    "",
    "Skupiny:",
    "exact — jedno české slovo končící přesně na „" + tail + "“. Př. „smůlu“ → nulu, školu, dolu, polu.",
    "multiword — spojení o 2–3 slovech, jehož POSLEDNÍ slovo končí na „" + tail + "“. Př. „smůlu“ → do důlu, u stolu, na půlu.",
    "assonance — téměř rýma: shodná koncová samohláska „" + lastVowel + "“. Př. „smůlu“ → bulu, muru.",
    "",
    "JSON, nic jiného: {\"exact\":[…max 12…],\"multiword\":[…max 12…],\"assonance\":[…max 8…]}",
  ].join("\n");
  // Zpřesnění pro jediný opakovaný dotaz, když první pokus neprošel kontrolou.
  // Ne smyčka: dva pokusy po ~60 s jsou ~120 s a naměřený strop edge funkce je
  // ~150 s, takže třetí už by visel.
  const strictSuffix = (rejected: string[]) => [
    "PRUHÝ POKUS. Předchozí odpověď neprošla kontrolou. Vyřazeno jako nepravdivé: " + (rejected.join(", ") || "(přesné rýmy nevyšly)") + ".",
    "NEOPAKUJ je ani podobné vymyšleniny, hledej jinou koncovku. Pokud ke „" + tail + "“ česká slova skoro neznáš, vrať prázdné pole — prázdno je lepší než vymyšlenina.",
  ].join("\n");

  let guarded: GuardedRhymes = { exact: [], multiword: [], assonance: [], rejected: [] };
  let lastError: unknown = null;
  let skip = [...exclude];
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  // Výsledky se SLUČUJÍ, ale ne naslepo. Druhý pokus VÍ, které tvary byly
  // vyhozené, takže je informovanější — jen nesmí přepsat lepší první pokus.
  //
  // Naměřeno 2026-10-05: `merge` ve starší podobě (když druhý pokus vrátil
  // cokoli, vyhrál on) při živém testu ke „srdce“ vrátil deset vymyšlenin
  // `ace, ece, ice, oce, uce…` místo funkčních `konce, svíce, prince`. Prostý
  // „ber druhý, pokud něco má“ je tedy špatné.
  //
  // Pořadí se rozhoduje SKÓREM, ne přítomností:
  //   1. `exact` je to, na co se uživatel ptal — nejvíc položek vyhrává,
  //   2. při shodě multiword (skupinová rýma),
  //   3. při shodě assonance (volný rým, nejdřívější přijde),
  //   4. při úplné shodě vyhrává druhý pokus — je informovanější.
  const score = (value: GuardedRhymes) =>
    value.exact.length * 100 + value.multiword.length * 10 + value.assonance.length;
  const merge = (next: GuardedRhymes): GuardedRhymes =>
    score(next) >= score(guarded) ? next : guarded;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Druhý pokus musí mít reálný čas, jinak by to byl visící požadavek.
    // `llmComplete` si navíc sám nechává 2 s rezervu, takže tady stačí hrubá
    // kontrola „zbývá víc než jeden krátký pokus“.
    const left = deadline - Date.now();
    if (attempt > 0 && left < 25_000) {
      if (!guarded.exact.length && !guarded.multiword.length && !guarded.assonance.length) {
        lastError = lastError ?? new Error("vypršel časový limit hledání");
      }
      break;
    }
    let raw = "";
    try {
      // `thinkingConfig.thinkingLevel` z původního Gemini těla je ZAMAZÁN — nemá
      // ekvivalent. Místo toho dostává reasoning model vlastní rozpočet uvnitř
      // `llm.ts`, jinak sežere `max_tokens` a vrátí `content: null`.
      const result = await llmComplete({
        system: buildInstruction(skip) + (attempt === 0 ? "" : strictSuffix(guarded.rejected)),
        messages: [{ role: "user", content: `Rýmy ke slovu: ${word}` }],
        temperature: attempt === 0 ? 0.8 : 0.4,
        maxTokens: RHYME_MAX_TOKENS,
        json: true,
        timeoutMs: Math.min(ATTEMPT_TIMEOUT_MS, left),
        prefer: [{ provider: "nvidia", model: RHYME_MODEL }],
        // Rozpočet ODPOVĚDI je 2200 a reasoning dostane svůj strop navíc. Je to
        // výslovně jiný poměr než výchozí nastavení poskytovatele, a je to
        // změřené, ne odhadnuté — viz `providerExtraBody` v `_shared/llm.ts`.
        // Bez stropu reasoning model přemýšlí, dokud mu neshoří rozpočet, a pak
        // nevrátí NIC (naměřeno: 7 běhů z 8 → `content: null`, 17–69 s).
        providerExtraBody: { reasoning: { max_tokens: 1024 }, reasoning_effort: "low" },
      });
      raw = result.text;
    } catch (error) {
      // První pokus už má výsledek — to je použitelná odpověď a nesmí se zahodit
      // kvůli selhání druhého. Naměřeno 2026-10-05: jinak „srdce“ skončilo
      // 502, i když první pokus správně vrátil „řece“.
      if (guarded.exact.length || guarded.multiword.length || guarded.assonance.length) break;
      // Bez výsledku z prvního pokusu se zkusí druhý, pokud je v rozpočtu.
      lastError = error;
      continue;
    }
    raw = raw.replace(/^```(?:json)?\n?/i, "").replace(/```$/g, "").trim();
    const match = /\{[\s\S]*\}/.exec(raw);
    if (!match) {
      if (guarded.exact.length || guarded.multiword.length || guarded.assonance.length) break;
      lastError = new Error("AI nevrátila JSON");
      continue;
    }
    let parsed: { exact?: unknown; multiword?: unknown; assonance?: unknown };
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      if (guarded.exact.length || guarded.multiword.length || guarded.assonance.length) break;
      lastError = new Error("AI nevrátila JSON");
      continue;
    }
    const attemptResult = promoteExactFromMultiword(
      guardRhymes(parsed, { queryWord: word, queryTail: tail, exclude: skip }),
      { queryWord: word, queryTail: tail },
    );
    guarded = merge(attemptResult);
    // Selhání PRVNIHO pokusu se tím druhým úspěchem přepíše — jinak by se
    // vrátila chyba pokusu, který už byl nahrazen lepším výsledkem.
    lastError = null;
    // Když po tomto pokusu není co zlepšovat, nezbývá co zkoušet dál.
    if (!shouldRetry(attemptResult)) break;
    // Druhý pokus nesmí opakovat to, co první vrátil, co bylo vyhozeno, ani to,
    // co uživatel viděl předtím.
    skip = [...new Set([
      ...skip,
      ...attemptResult.exact,
      ...attemptResult.multiword,
      ...attemptResult.assonance,
      ...attemptResult.rejected,
    ])];
  }

  if (lastError) {
    const failure = llmFailureMessage(lastError, {
      unavailable: "Hledač rýmů teď neodpovídá. Zkus to za chvíli.",
      throttled: "AI poskytovatele teď odmítají požadavek. Zkus to později.",
    });
    return json({ error: failure.message }, failure.status);
  }

  if (!guarded.exact.length && !guarded.multiword.length && !guarded.assonance.length) {
    return json({
      error: `K slovu „${word}“ se nepodařilo najít žádnou ověřitelnou českou rýmu.`,
    }, 502);
  }

  return json({
    exact: guarded.exact,
    multiword: guarded.multiword,
    assonance: guarded.assonance,
  });
});
