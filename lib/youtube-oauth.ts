import { SUPABASE_URL, supabase } from "@/lib/supabase";

/**
 * Kam se má `openAuthSessionAsync` vrátit po schválení na Google.
 *
 * Výchozí hodnota MUSÍ být deep link na existující routu. `app/settings/`
 * v repu neexistuje, takže `songcraftstudio://settings/youtube` se parsuje
 * jako cesta `settings/youtube` a expo-router skončí na `+not-found`.
 * `songcraftstudio://settings` (scheme z `app.config.ts`, host jako první
 * segment cesty) odpovídá routě `/settings` z `app/(tabs)/settings.tsx` —
 * stejný tvar jako `songcraftstudio://reset-password` v `lib/reset-password.ts`.
 *
 * Edge Function `youtube-oauth-callback` čte `SONGCRAFT_APP_REDIRECT_URL` a
 * musí dostat TUTÉŽ hodnotu, jinak se OAuth tok po návratu neuloží.
 * Přepisuje se to přes `EXPO_PUBLIC_YOUTUBE_OAUTH_REDIRECT_URL`.
 */
export const YOUTUBE_OAUTH_REDIRECT_URL = process.env.EXPO_PUBLIC_YOUTUBE_OAUTH_REDIRECT_URL || "songcraftstudio://settings";

/**
 * Redirect URI, které se musí PŘESNĚ zapsat do *Authorized redirect URIs*
 * v Google Cloud a stejně tak do Supabase secretu `YOUTUBE_REDIRECT_URI`.
 * Google ho porovnává znak po znaku — jinak `redirect_uri_mismatch`.
 * Odvozené z `SUPABASE_URL`, aby tady nebyla druhá kopie project refu.
 */
export const YOUTUBE_OAUTH_REDIRECT_URI = `${SUPABASE_URL}/functions/v1/youtube-oauth-callback`;

/**
 * `reason` z hlubokého odkazu `youtube-oauth-callback` → text pro uživatele.
 * Klíče odpovídají `redirect("error", { reason })` v této edge funkci.
 */
const YOUTUBE_OAUTH_FAILURES: Record<string, string> = {
  denied: "Připojení jsi v Google zrušil. Kanál zůstal nepřipojený.",
  google_error: "Google vrátil chybu a kanál nebyl připojený.",
  invalid_request: "Google poslal neúplnou odpověď. Připojení to ještě zopakuj.",
  not_configured: "Na serveru chybí YOUTUBE_CLIENT_ID nebo YOUTUBE_CLIENT_SECRET. Bez nich se token nevymění.",
  invalid_state: "Připojení vypršelo nebo bylo zrušené. Spusť ho prosím znovu.",
  state_already_used: "Tohle připojení už bylo jednou použité. Spusť ho prosím znovu.",
  account_not_allowed: "Tento účet není v povoleném seznamu SCS2.",
  token_exchange_failed: "Google odmítl vyměnit kód za token. Zkontroluj redirect URI u klienta v Google Cloud.",
  channel_lookup_failed: "Token platí, ale kanál se nepodařilo načíst. Zkontroluj, že účet má YouTube kanál.",
  credential_save_failed: "Token se vyměnil, ale nepodařilo se ho uložit. Zkus připojení znovu.",
  oauth_failed: "Připojení se přerušilo. Zkus to znovu.",
};

export type YouTubeOauthReturn = { connected: boolean; failed: boolean; message: string | null };

/**
 * `youtube-oauth-callback` přesměruje aplikaci VŽDY, i když se nepovede, a
 * výsledek vepíše do parametru `youtube`. `openAuthSessionAsync` ale vrací
 * `type: "success"` pro jakýkoli návrat na `YOUTUBE_OAUTH_REDIRECT_URL`, takže
 * samotné `success` neznamená, že je kanál připojený.
 */
export function readYouTubeOauthReturn(redirectUrl: string): YouTubeOauthReturn {
  let params: URLSearchParams;
  try {
    params = new URL(redirectUrl).searchParams;
  } catch {
    return { connected: false, failed: true, message: null };
  }
  const status = params.get("youtube");
  if (status === "connected") return { connected: true, failed: false, message: null };
  if (status !== "error") return { connected: false, failed: false, message: null };
  const reason = params.get("reason") ?? "";
  return { connected: false, failed: true, message: YOUTUBE_OAUTH_FAILURES[reason] ?? "Google vrátil chybu a kanál nebyl připojený." };
}

/**
 * Tělo chyby z `supabase.functions.invoke()` je v `error.context` jako
 * `Response` a jde přečíst jen jednou — `error.message` je vždycky jen
 * "Edge Function returned a non-2xx status code". Bez toho by se konkrétní
 * česká hláška `youtube-oauth-start` nikdy neukázala.
 */
async function edgeFunctionErrorMessage(error: unknown): Promise<string | null> {
  const context = (error as { context?: unknown } | null)?.context;
  if (!(context instanceof Response)) return null;
  try {
    const text = await context.text();
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      return typeof parsed.error === "string" ? parsed.error : text;
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

export async function createYouTubeAuthorizationUrl() {
  const { data, error } = await supabase.functions.invoke("youtube-oauth-start", { body: {} });
  if (error) throw new Error((await edgeFunctionErrorMessage(error)) || "YouTube připojení se nepodařilo zahájit.");
  const url = (data as { authorizationUrl?: unknown } | null)?.authorizationUrl;
  if (typeof url !== "string" || !/^https:\/\/accounts\.google\.com\//i.test(url)) throw new Error("YouTube vrátil neplatnou autorizační adresu.");
  return url as string;
}