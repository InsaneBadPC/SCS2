import { supabase } from "@/lib/supabase";

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

export async function createYouTubeAuthorizationUrl() {
  const { data, error } = await supabase.functions.invoke("youtube-oauth-start", { body: {} });
  if (error) throw new Error(error.message || "YouTube připojení se nepodařilo zahájit.");
  const url = (data as { authorizationUrl?: unknown } | null)?.authorizationUrl;
  if (typeof url !== "string" || !/^https:\/\/accounts\.google\.com\//i.test(url)) throw new Error("YouTube vrátil neplatnou autorizační adresu.");
  return url as string;
}
