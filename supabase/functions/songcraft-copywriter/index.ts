import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isAllowedPrivateUser, privateAccessMessage } from "../_shared/access.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const clip = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "Použij POST požadavek." }, 405);
  const authorization = request.headers.get("Authorization");
  const url = Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY");
  const geminiKey = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
  if (!authorization || !url || !anonKey) return json({ error: "Chybí bezpečné připojení." }, 401);
  if (!geminiKey) return json({ error: "AI copywriter není správně nakonfigurován." }, 503);

  const supabase = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return json({ error: "Neplatné přihlášení." }, 401);
  if (!isAllowedPrivateUser(user, { allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined, allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined })) return json({ error: privateAccessMessage() }, 403);

  const input = await request.json().catch(() => null) as { action?: string; songId?: string } | null;
  if (!input?.action || !input.songId) return json({ error: "Chybí skladba nebo akce." }, 400);
  if (!["description", "tags"].includes(input.action)) return json({ error: "Neznámá akce." }, 400);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SONGCRAFT_SERVICE_ROLE_KEY") || anonKey);
  const { data: song, error: songError } = await admin.from("sc_songs").select("id,user_id,title,style_prompt,style_prompts,lyrics,album_id").eq("id", input.songId).single();
  if (songError || !song || song.user_id !== user.id) return json({ error: "Skladba nebyla nalezena." }, 404);

  let albumName = "";
  if (song.album_id) {
    const { data: album } = await admin.from("sc_albums").select("name").eq("id", song.album_id).eq("user_id", user.id).maybeSingle();
    albumName = clip(album?.name, 120);
  }
  const stylePrompts = Array.isArray(song.style_prompts) ? song.style_prompts.filter((entry: unknown): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry: string) => clip(entry, 400)) : [];
  if (song.style_prompt && !stylePrompts.includes(clip(song.style_prompt, 400))) stylePrompts.unshift(clip(song.style_prompt, 400));

  const contextLines = [
    `Interpret: Temney`,
    `Název skladby: ${clip(song.title, 150)}`,
    albumName ? `Album: ${albumName}` : "",
    stylePrompts.length ? `Styl/žánr: ${stylePrompts.join(" | ")}` : "",
    `Text písně:\n${clip(song.lyrics, 2500) || "(text není k dispozici)"}`,
  ].filter(Boolean).join("\n");

  const instruction = input.action === "description"
    ? [
        "Jsi Temney a píšeš popisek ke své vlastní skladbě na YouTube.",
        "Podle názvu, stylu a hlavně podle textu písně napiš lidské, osobní shrnutí o čem skladba je (80–120 slov, česky).",
        "Piš v první osobě, klidně a upřímně, bez marketingových frází, bez teleshoppingu a bez výzev typu 'dejte odběr/like/sdílejte/komentujte'.",
        "Zaměř se na téma, příběh a pocit písně; zmíň náladu/zvuk jen stručně pokud vyplývá z materiálu.",
        "Na konec přidej pouze jeden řádek s hashtagy ve tvaru „#Temney #<názevBezDiakritiky> #ceskahudba“.",
        "Nevymýšlej si fakta (datum vydání, spolupracovníky, odkazy, statistiky). Piš pouze výsledný popis, bez úvodu a bez komentářů.",
      ].join("\n")
    : [
        "Jsi specialista na YouTube tagy pro interpreta Temney.",
        "Navrhni 14–18 tagů půl na půl: 50 % podle OBSAHU textu (téma, příběh, klíčová slova a emoce z lyriky) a 50 % podle STYLU hudby (žánr, nálada, zvuk, produkce ze style_prompt).",
        "Obsahová půlka: konkrétní motivy z textu (např. iluze, samota, vymyšlený svět apod.). Stylová půlka: žánr, subžánr, nálada, instrumentace/produkce.",
        "Na konec vždy přidej Temney a název skladby. Každý tag unikátní – neopakuj stejné slovo (ne 20x rap). Smíchej češtinu a angličtinu.",
        "Vrať POUZE tagy oddělené čárkou, bez číslování, bez mřížek, bez dalšího textu.",
      ].join("\n");

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: `${instruction}\n\nMATERIÁL SKLADBY:\n${contextLines}` }] },
      contents: [{ role: "user", parts: [{ text: input.action === "description" ? "Napiš popis videa na YouTube." : "Navrhni tagy." }] }],
      generationConfig: { temperature: 0.8, maxOutputTokens: 900 },
    }),
  });
  if (!response.ok) return json({ error: "Google AI teď odmítla požadavek. Zkus to za chvíli." }, response.status === 429 ? 429 : 502);
  const generated = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
  let text = clip(generated.candidates?.[0]?.content?.parts?.map((part) => typeof part.text === "string" ? part.text : "").join("\n"), 5000)
    .replace(/^```[a-z]*\n?|```$/g, "").trim();
  if (!text) return json({ error: "AI nevrátila text. Zkus to znovu." }, 502);
  if (input.action === "tags") {
    text = text.split(/[,\n]/).map((tag) => tag.replace(/^[-#\d.\s]+/, "").trim()).filter(Boolean).slice(0, 18).join(", ");
  }
  return json({ text });
});
