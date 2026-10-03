import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveCallerScope, resolveTargetUserId } from "../_shared/scheduler-auth.ts";
import { isAllowedPrivateUser, privateAccessMessage } from "../_shared/access.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const MAX_CREDENTIALS = 100;
const MAX_PUBLICATIONS = 100;
const MAX_DAYS = 30;
const ANALYTICS_TIMEOUT_MS = 20_000;
const env = {
  url: Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL"),
  anonKey: Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY"),
  serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SONGCRAFT_SERVICE_ROLE_KEY"),
  cronSecret: Deno.env.get("SYNC_STATS_CRON_SECRET") || Deno.env.get("SONGCRAFT_SYNC_STATS_CRON_SECRET"),
};

const verifyUser = async (bearer: string): Promise<string | null> => {
  if (!env.url || !env.anonKey) return null;
  const auth = createClient(env.url, env.anonKey, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
  const { data, error } = await auth.auth.getUser();
  return error || !data?.user ? null : data.user.id;
};

const verifyServiceRoleClaim = async (bearer: string): Promise<boolean> => {
  if (!env.url || !env.anonKey) return false;
  const auth = createClient(env.url, env.anonKey);
  const { data, error } = await auth.auth.getClaims(bearer);
  return !error && data?.claims?.role === "service_role";
};

const audit = async (admin: any, userId: string, result: "success" | "error", payload: unknown, errorMessage?: string) => {
  try { await admin.from("agent_action_log").insert({ user_id: userId, action_type: "sync_youtube_stats", payload, result, error_message: errorMessage ? errorMessage.slice(0, 500) : null }); } catch { /* audit nesmí shodit běh */ }
};

async function getAccessToken(admin: any, userId: string, credential: any) {
  if (credential.expires_at && new Date(credential.expires_at).getTime() > Date.now() + 60_000 && credential.access_token) return credential.access_token;
  const clientId = Deno.env.get("YOUTUBE_CLIENT_ID");
  const clientSecret = Deno.env.get("YOUTUBE_CLIENT_SECRET");
  if (!clientId || !clientSecret || !credential.refresh_token) throw new Error("YouTube OAuth refresh není nakonfigurovaný.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: credential.refresh_token, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(20_000),
  });
  const token = await response.json().catch(() => null) as { access_token?: string; expires_in?: number; error_description?: string } | null;
  if (!response.ok || !token?.access_token) throw new Error(token?.error_description || "YouTube OAuth refresh selhal.");
  const { error } = await admin.from("youtube_credentials").update({ access_token: token.access_token, expires_at: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq("user_id", userId);
  if (error) throw new Error("OAuth token se nepodařilo uložit.");
  return token.access_token;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "Použij POST požadavek." }, 405);
  if (!env.url || !env.serviceRoleKey) return json({ error: "Chybí konfigurace." }, 503);
  const caller = await resolveCallerScope(request, env, { user: verifyUser, serviceRoleClaim: verifyServiceRoleClaim });
  if (!caller.ok) return json({ error: caller.error }, caller.status);
  const input = await request.json().catch(() => ({})) as { userId?: unknown };
  const target = resolveTargetUserId(caller.scope, input?.userId);
  if (!target.ok) return json({ error: target.error }, target.status);
  const admin = createClient(env.url, env.serviceRoleKey);

  if (caller.scope.role === "user") {
    const { data: userRecord } = await admin.auth.admin.getUserById(caller.scope.userId);
    if (!isAllowedPrivateUser(userRecord?.user, { allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined, allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined })) return json({ error: privateAccessMessage() }, 403);
  }

  let credentialQuery = admin.from("youtube_credentials").select("user_id,access_token,refresh_token,expires_at,channel_id").limit(MAX_CREDENTIALS);
  if (target.userId) credentialQuery = credentialQuery.eq("user_id", target.userId);
  const { data: credentials, error: credentialError } = await credentialQuery;
  if (credentialError) return json({ error: credentialError.message }, 502);

  let synced = 0;
  let skipped = 0;
  let failed = 0;
  for (const credential of credentials ?? []) {
    if (!credential.user_id || !credential.channel_id || (!credential.access_token && !credential.refresh_token)) { skipped += 1; continue; }
    const { data: publications, error: publicationError } = await admin.from("youtube_publications").select("id,youtube_video_id").eq("user_id", credential.user_id).eq("status", "published").not("youtube_video_id", "is", null).limit(MAX_PUBLICATIONS);
    if (publicationError || !publications?.length) { skipped += 1; continue; }

    let accessToken: string;
    try { accessToken = await getAccessToken(admin, credential.user_id, credential); } catch (error) {
      failed += publications.length;
      await audit(admin, credential.user_id, "error", { publications: publications.length }, error instanceof Error ? error.message : "OAuth refresh selhal.");
      continue;
    }

    for (const publication of publications) {
      if (!publication.youtube_video_id) { skipped += 1; continue; }
      const endDate = new Date().toISOString().slice(0, 10);
      const query = new URLSearchParams({
        ids: `channel==${credential.channel_id}`,
        startDate: "2000-01-01",
        endDate,
        metrics: "views,estimatedMinutesWatched,averageViewDuration,likes,comments,subscribersGained",
        dimensions: "video,day",
        filters: `video==${publication.youtube_video_id}`,
        sort: "-day",
        maxResults: String(MAX_DAYS),
      });
      try {
        const response = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?${query.toString()}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(ANALYTICS_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`YouTube Analytics HTTP ${response.status}`);
        const report = await response.json().catch(() => null) as { rows?: Array<Array<string | number>> } | null;
        for (const values of (report?.rows ?? []).slice(0, MAX_DAYS)) {
          const videoId = String(values[0] ?? "");
          const date = String(values[1] ?? "");
          if (videoId !== String(publication.youtube_video_id) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
          const { error: upsertError } = await admin.from("youtube_stats").upsert({ user_id: credential.user_id, youtube_publication_id: publication.id, date, views: Number(values[2]) || 0, watch_time_minutes: Number(values[3]) || 0, avg_view_duration_seconds: Number(values[4]) || 0, likes: Number(values[5]) || 0, comments: Number(values[6]) || 0, subscribers_gained: Number(values[7]) || 0 }, { onConflict: "youtube_publication_id,date" });
          if (upsertError) throw new Error(upsertError.message);
          synced += 1;
        }
      } catch (error) {
        failed += 1;
        await audit(admin, credential.user_id, "error", { publicationId: publication.id, youtubeVideoId: publication.youtube_video_id }, error instanceof Error ? error.message : "Statistika se nepodařilo synchronizovat.");
      }
    }
  }
  return json({ synced, skipped, failed, scope: caller.scope.role });
});
