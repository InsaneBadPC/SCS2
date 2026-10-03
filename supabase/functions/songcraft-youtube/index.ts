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
const clip = (value: unknown, max: number) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
const EFFECTS = ["static", "zoom", "wave", "zoom_wave", "blur"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ownedPath = (userId: string, value: unknown) => typeof value === "string" && value.length <= 1024 && !value.includes("\\") && !value.includes("..") && value.startsWith(`${userId}/`) ? value : null;

async function signedUrl(url: string, serviceKey: string, storagePath: string) {
  const encoded = storagePath.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${url}/storage/v1/object/sign/songcraft/${encoded}`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 3600 }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error("Video soubor se nepodařilo podepsat.");
  const result = await response.json().catch(() => null) as { signedURL?: string } | null;
  if (!result?.signedURL) throw new Error("Storage nevrátil podepsaný video odkaz.");
  return `${url}/storage/v1${result.signedURL}`;
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
  const input = await request.json().catch(() => null) as { action?: unknown; songId?: unknown; versionId?: unknown; effect?: unknown; mode?: unknown; jobId?: unknown } | null;

  if (input?.action === "check") {
    if (typeof input.jobId !== "string" || !uuid.test(input.jobId)) return json({ error: "Neplatné jobId." }, 400);
    const { data: job, error } = await admin.from("agent_videos").select("id,render_status,storage_path,error_message,created_at").eq("id", input.jobId).eq("user_id", user.id).maybeSingle();
    if (error || !job) return json({ error: "Renderovací úloha nebyla nalezena." }, 404);
    if (job.render_status === "failed") return json({ status: "failed", error: job.error_message || "Video render selhal." });
    if (job.render_status !== "ready" || !job.storage_path) return json({ status: "processing", jobId: job.id, message: "Video se stále renderuje." });
    const path = ownedPath(user.id, job.storage_path);
    if (!path) return json({ error: "Renderovaný video soubor nemá platnou cestu vlastníka." }, 409);
    try {
      return json({ status: "completed", jobId: job.id, url: await signedUrl(url, serviceKey, path) });
    } catch (error) {
      return json({ status: "failed", error: error instanceof Error ? error.message : "Video se nepodařilo otevřít." }, 502);
    }
  }

  if (input?.action !== "create" || typeof input.songId !== "string" || !uuid.test(input.songId) || typeof input.versionId !== "string" || !uuid.test(input.versionId)) {
    return json({ error: "Chybí platná skladba, finální MP3 nebo akce." }, 400);
  }
  const effect = typeof input.effect === "string" && EFFECTS.includes(input.effect as (typeof EFFECTS)[number]) ? input.effect as (typeof EFFECTS)[number] : "static";
  const { data: song, error: songError } = await admin.from("sc_songs").select("id,user_id,title,cover_path,album_id,lyrics,style_prompt").eq("id", input.songId).eq("user_id", user.id).maybeSingle();
  if (songError || !song) return json({ error: "Skladba nebyla nalezena." }, 404);
  const { data: version, error: versionError } = await admin.from("sc_audio_versions").select("id,user_id,song_id,is_final,tagged_storage_path,original_storage_path,storage_path").eq("id", input.versionId).eq("user_id", user.id).maybeSingle();
  if (versionError || !version || version.song_id !== song.id || !version.is_final) return json({ error: "Pro video je potřeba finální MP3 verze této skladby." }, 400);
  const audioPath = ownedPath(user.id, version.tagged_storage_path || version.original_storage_path || version.storage_path);
  let coverPath = ownedPath(user.id, song.cover_path);
  if (!coverPath && song.album_id) {
    const { data: album } = await admin.from("sc_albums").select("cover_path").eq("id", song.album_id).eq("user_id", user.id).maybeSingle();
    coverPath = ownedPath(user.id, album?.cover_path);
  }
  if (!audioPath || !coverPath) return json({ error: "Finální MP3 nebo obal nemá platnou cestu vlastníka." }, 409);

  const requestedMode = typeof input.mode === "string" && ["static_cover", "image_animation", "full_scenes"].includes(input.mode) ? input.mode : null;
  const mode = requestedMode || (effect === "static" ? "static_cover" : "image_animation");
  const backend = mode === "static_cover" ? "ffmpeg" : mode === "image_animation" ? "vm_image_animation" : "vm_full_scenes";
  const renderPrompt = `SongCraft video mode: ${mode}. Song: ${clip(song.title, 140)}. Style: ${clip(song.style_prompt, 600)}. Lyrics/context: ${clip(song.lyrics, 2_400)}. Legacy effect: ${effect}.`;
  const { data: job, error: createError } = await admin.from("agent_videos").insert({
    user_id: user.id,
    song_id: song.id,
    type: mode,
    mode,
    backend,
    audio_storage_path: audioPath,
    prompt_used: renderPrompt,
    render_status: "queued",
  }).select("id,render_status,mode,backend").single();
  if (createError || !job) return json({ error: "Renderovací úlohu se nepodařilo založit." }, 502);
  await admin.from("agent_action_log").insert({ user_id: user.id, action_type: "render_video", target_id: job.id, payload: { mode, backend, effect }, result: "success" });
  return json({ status: "processing", jobId: job.id, videoId: job.id, message: "Video je ve frontě Oracle rendereru." });
});
