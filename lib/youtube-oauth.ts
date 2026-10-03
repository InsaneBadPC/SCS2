import { supabase } from "@/lib/supabase";

export const YOUTUBE_OAUTH_REDIRECT_URL = process.env.EXPO_PUBLIC_YOUTUBE_OAUTH_REDIRECT_URL || "songcraftstudio://settings/youtube";

export async function createYouTubeAuthorizationUrl() {
  const { data, error } = await supabase.functions.invoke("youtube-oauth-start", { body: {} });
  if (error) throw new Error(error.message || "YouTube připojení se nepodařilo zahájit.");
  const url = (data as { authorizationUrl?: unknown } | null)?.authorizationUrl;
  if (typeof url !== "string" || !/^https:\/\/accounts\.google\.com\//i.test(url)) throw new Error("YouTube vrátil neplatnou autorizační adresu.");
  return url as string;
}
