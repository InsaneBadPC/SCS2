import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isAllowedPrivateUser, privateAccessMessage } from "../_shared/access.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const clip = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ownedPath(userId: string, value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\\") && !value.includes("..") && value.startsWith(`${userId}/`) ? value : null;
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameBytes(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

async function signedVideoUrl(url: string, serviceKey: string, storagePath: string) {
  const encodedPath = storagePath.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${url}/storage/v1/object/sign/songcraft/${encodedPath}`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 900 }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error("Video soubor se nepodařilo podepsat.");
  const result = await response.json().catch(() => null) as { signedURL?: string } | null;
  if (!result?.signedURL) throw new Error("Storage nevrátil podepsaný video odkaz.");
  return `${url}/storage/v1${result.signedURL}`;
}

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
  if (error) throw new Error("OAuth token se nepodařilo bezpečně uložit.");
  return token.access_token;
}

function normalizedTags(value: unknown) {
  return Array.isArray(value) ? value.map((tag) => clip(tag, 30)).filter(Boolean).slice(0, 15) : [];
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "Použij POST." }, 405);

  const authorization = request.headers.get("Authorization");
  const url = Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SONGCRAFT_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return json({ error: "Chybí konfigurace serveru (SUPABASE_URL / klíče / service role)." }, 503);
  if (!authorization) return json({ error: "Chybí přihlášení." }, 401);

  const auth = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await auth.auth.getUser();
  if (authError || !user) return json({ error: "Neplatné přihlášení." }, 401);
  if (!isAllowedPrivateUser(user, { allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined, allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined })) return json({ error: privateAccessMessage() }, 403);
  const admin = createClient(url, serviceKey);

  const input = await request.json().catch(() => null) as { confirmationId?: unknown; confirmationToken?: unknown } | null;
  const confirmationId = typeof input?.confirmationId === "string" ? input.confirmationId.trim() : "";
  const confirmationToken = typeof input?.confirmationToken === "string" ? input.confirmationToken.trim() : "";
  if (!uuid.test(confirmationId) || confirmationToken.length < 32 || confirmationToken.length > 256) {
    return json({ error: "Platný confirmationId a confirmationToken jsou povinné." }, 400);
  }

  const { data: candidate, error: candidateError } = await admin
    .from("agent_confirmations")
    .select("id,user_id,action,target_id,payload,status,expires_at,nonce_hash")
    .eq("id", confirmationId)
    .eq("user_id", user.id)
    .eq("action", "publish_to_youtube")
    .maybeSingle();
  if (candidateError || !candidate) return json({ error: "Potvrzení nebylo nalezeno." }, 404);
  if (candidate.status !== "pending" || new Date(candidate.expires_at).getTime() <= Date.now()) return json({ error: "Potvrzení vypršelo nebo už bylo použito." }, 409);
  if (!sameBytes(await hashToken(confirmationToken), String(candidate.nonce_hash ?? ""))) return json({ error: "Potvrzení není platné." }, 403);

  const payload = (candidate.payload ?? {}) as Record<string, unknown>;
  const publicationId = typeof payload.publicationId === "string" ? payload.publicationId : "";
  if (!uuid.test(publicationId)) return json({ error: "Potvrzení neobsahuje platnou publikaci." }, 400);
  const { data: publication, error: publicationError } = await admin.from("youtube_publications").select("id,title,description,tags,privacy_status,video_id,status,youtube_video_id,song_id").eq("id", publicationId).eq("user_id", user.id).maybeSingle();
  if (publicationError || !publication) return json({ error: "Draft publikace nebyl nalezen." }, 404);

  // Metadata is bound at confirmation time. Any drift requires a fresh review.
  const currentSnapshot = {
    publicationId,
    title: clip(publication.title, 100),
    description: clip(publication.description, 5_000),
    tags: normalizedTags(publication.tags),
    privacyStatus: clip(publication.privacy_status, 20) || "private",
  };
  const expectedSnapshot = {
    publicationId,
    title: clip(payload.title, 100),
    description: clip(payload.description, 5_000),
    tags: normalizedTags(payload.tags),
    privacyStatus: clip(payload.privacyStatus, 20) || "private",
  };
  if (!["private", "unlisted", "public"].includes(currentSnapshot.privacyStatus)) return json({ error: "Soukromí publikace není platné." }, 400);
  if (!currentSnapshot.title) return json({ error: "Před publikací chybí název videa." }, 400);
  if (JSON.stringify(currentSnapshot) !== JSON.stringify(expectedSnapshot)) {
    await admin.from("agent_action_log").insert({ user_id: user.id, action_type: "publish_to_youtube", target_id: publication.id, payload: { reason: "metadata_drift" }, result: "error" });
    return json({ error: "Metadata publikace se od potvrzení změnila. Potvrzení prosím vytvoř znovu." }, 409);
  }

  if (publication.status === "published" && publication.youtube_video_id) return json({ status: "published", youtubeVideoId: publication.youtube_video_id, idempotent: true });
  if (!publication.video_id) return json({ error: "Draft nemá připravené video. Nejprve spusť render." }, 400);
  const { data: video } = await admin.from("agent_videos").select("id,storage_path,render_status").eq("id", publication.video_id).eq("user_id", user.id).maybeSingle();
  const videoPath = ownedPath(user.id, video?.storage_path);
  if (!video || video.render_status !== "ready" || !videoPath) return json({ error: "Video ještě není připravené pro upload." }, 409);

  const { data: credential } = await admin.from("youtube_credentials").select("access_token,refresh_token,expires_at,channel_id").eq("user_id", user.id).maybeSingle();
  if (!credential?.access_token && !credential?.refresh_token) return json({ error: "Nejdříve připoj YouTube OAuth účet." }, 412);

  // Atomic one-time claim. A second tab/request cannot publish the same nonce.
  const { data: claimed, error: claimError } = await admin
    .from("agent_confirmations")
    .update({ status: "consumed", consumed_at: new Date().toISOString() })
    .eq("id", confirmationId)
    .eq("user_id", user.id)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .select("id")
    .maybeSingle();
  if (claimError || !claimed) return json({ error: "Potvrzení už bylo použito nebo vypršelo." }, 409);

  try {
    const accessToken = await getAccessToken(admin, user.id, credential);
    const fileUrl = await signedVideoUrl(url, serviceKey, videoPath);
    const fileResponse = await fetch(fileUrl, { signal: AbortSignal.timeout(120_000) });
    if (!fileResponse.ok) throw new Error("Video se nepodařilo stáhnout ze Storage.");
    const declaredLength = Number(fileResponse.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_VIDEO_BYTES) throw new Error("Video je větší než povolený limit.");
    const bytes = new Uint8Array(await fileResponse.arrayBuffer());
    if (bytes.byteLength <= 0 || bytes.byteLength > MAX_VIDEO_BYTES) throw new Error("Video má neplatnou velikost.");

    const metadata = {
      snippet: { title: currentSnapshot.title, description: currentSnapshot.description, tags: currentSnapshot.tags, categoryId: "10" },
      status: { privacyStatus: currentSnapshot.privacyStatus, selfDeclaredMadeForKids: false },
    };
    const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": String(bytes.byteLength) },
      body: JSON.stringify(metadata),
      signal: AbortSignal.timeout(30_000),
    });
    if (!init.ok) throw new Error(`YouTube upload session selhala (${init.status}).`);
    const location = init.headers.get("location");
    if (!location) throw new Error("YouTube nevrátil upload URL.");
    const upload = await fetch(location, { method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "video/mp4", "Content-Length": String(bytes.byteLength) }, body: bytes, signal: AbortSignal.timeout(10 * 60_000) });
    const result = await upload.json().catch(() => null) as { id?: string; error?: { message?: string } } | null;
    if (!upload.ok || !result?.id) throw new Error(result?.error?.message || `YouTube upload selhal (${upload.status}).`);

    const publishedAt = new Date().toISOString();
    const { error: updateError } = await admin.from("youtube_publications").update({ status: "published", youtube_video_id: result.id, published_at: publishedAt, error_message: null }).eq("id", publication.id).eq("user_id", user.id);
    if (updateError) throw new Error("Video bylo nahráno, ale stav publikace se nepodařilo uložit.");
    if (publication.song_id) await admin.from("sc_songs").update({ is_published: true, published_video_id: result.id, published_at: publishedAt }).eq("id", publication.song_id).eq("user_id", user.id);
    await admin.from("agent_action_log").insert({ user_id: user.id, action_type: "publish_to_youtube", target_id: publication.id, payload: { youtubeVideoId: result.id, confirmationId }, result: "success" });
    return json({ status: "published", youtubeVideoId: result.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload selhal.";
    await admin.from("youtube_publications").update({ status: "failed", error_message: message.slice(0, 1_000) }).eq("id", publication.id).eq("user_id", user.id);
    await admin.from("agent_action_log").insert({ user_id: user.id, action_type: "publish_to_youtube", target_id: publication.id, payload: { confirmationId }, result: "error", error_message: message.slice(0, 500) });
    return json({ error: message }, 502);
  }
});
