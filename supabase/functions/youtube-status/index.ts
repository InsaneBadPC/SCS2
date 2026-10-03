import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isAllowedPrivateUser, privateAccessMessage } from "../_shared/access.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });

/**
 * Zda je kanál připojený. Záměrně NEVRACÍ tokeny.
 *
 * Tabulka youtube_credentials má záměrně žádnou policy pro client role, aby
 * aplikace nikdy nemohla přečíst refresh token. Tato funkce běží se service
 * role a vrací jen příznak, titul kanálu a datum připojení — nic citlivého.
 *
 * Proč to potřebujeme: tlačítko „Připojit YouTube OAuth“ v Nastavení hází
 * redirect_uri_mismatch, pokud u Google klíče chybí adresa funkce. Aplikace
 * tak musí umět říct „je to připojené“ i bez stisknutí tlačítka.
 */
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  // supabase.functions.invoke() posílá POST, i když funkce nic nepřijímá.
  // Když se povolí jen GET, klient dostane 405 „Použijte GET“ a appka to
  // vyloží jako „nepodařilo se ověřit“. Proto bereme obojí.
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: `Nepovolená metoda ${request.method}, použij GET.` }, 405);
  }
  const authorization = request.headers.get("Authorization");
  const url = Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SONGCRAFT_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return json({ error: "Chybí konfigurace serveru." }, 503);
  if (!authorization) return json({ error: "Chybí přihlášení." }, 401);

  const auth = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await auth.auth.getUser();
  if (authError || !user) return json({ error: "Neplatné přihlášení." }, 401);
  if (!isAllowedPrivateUser(user, { allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined, allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined })) return json({ error: privateAccessMessage() }, 403);

  const admin = createClient(url, serviceKey);
  const { data, error } = await admin
    .from("youtube_credentials")
    .select("channel_id,updated_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return json({ error: "Stav kanálu se nepodařilo načíst." }, 502);

  if (!data?.channel_id) {
    return json({
      connected: false,
      message: "Kanál není připojený.",
    });
  }

  // Titul kanálu si vezmeme z API, uložený je jen číselný ID. Access token po
  // hodině vyprchá, takže nejdřív zkusíme obnovit ho z refresh tokenu. Bez toho
  // by UI ukázalo „YouTube kanál" místo skutečného názvu, i když je vše v pořádku.
  let channelTitle = "YouTube kanál";
  try {
    const { data: credential } = await admin
      .from("youtube_credentials")
      .select("access_token,refresh_token,expires_at")
      .eq("user_id", user.id)
      .maybeSingle();
    let access = credential?.access_token;
    const expired = !credential?.expires_at || new Date(credential.expires_at).getTime() < Date.now() + 60_000;
    if (expired && credential?.refresh_token) {
      const clientId = Deno.env.get("YOUTUBE_CLIENT_ID");
      const clientSecret = Deno.env.get("YOUTUBE_CLIENT_SECRET");
      if (clientId && clientSecret) {
        const refreshed = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: credential.refresh_token,
            grant_type: "refresh_token",
          }),
        });
        if (refreshed.ok) {
          const payload = await refreshed.json();
          access = payload.access_token;
          await admin
            .from("youtube_credentials")
            .update({
              access_token: payload.access_token,
              expires_at: new Date(Date.now() + Number(payload.expires_in ?? 3600) * 1000).toISOString(),
            })
            .eq("user_id", user.id);
        }
      }
    }
    if (access) {
      const response = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
        headers: { Authorization: `Bearer ${access}` },
      });
      if (response.ok) {
        const payload = await response.json();
        channelTitle = payload?.items?.[0]?.snippet?.title ?? channelTitle;
      }
    }
  } catch {
    // titul je kosmetika, stav připojení je podstatný
  }

  return json({
    connected: true,
    channelId: data.channel_id,
    channelTitle,
    connectedAt: data.updated_at,
  });
});
