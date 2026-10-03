import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isAllowedPrivateUser, privateAccessMessage } from "../_shared/access.ts";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  const authorization = request.headers.get("Authorization"); const url = Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL"); const anon = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY"); const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SONGCRAFT_SERVICE_ROLE_KEY"); if (!url || !anon || !service) return json({ error: "Chybí konfigurace serveru." }, 503); if (!authorization) return json({ error: "Chybí přihlášení." }, 401);
  const auth = createClient(url, anon, { global: { headers: { Authorization: authorization } } }); const { data: { user } } = await auth.auth.getUser(); if (!user) return json({ error: "Neplatné přihlášení." }, 401); if (!isAllowedPrivateUser(user, { allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined, allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined })) return json({ error: privateAccessMessage() }, 403); const admin = createClient(url, service);
  const body = await request.json().catch(() => null) as { videoId?: string } | null; if (!body?.videoId) return json({ error: "Chybí videoId." }, 400);
  const { data: job, error } = await admin.from("agent_videos").select("id,song_id,type,render_status").eq("id", body.videoId).eq("user_id", user.id).maybeSingle(); if (error || !job) return json({ error: "Renderovací úloha nebyla nalezena." }, 404);
  if (job.render_status !== "queued") return json({ status: job.render_status, videoId: job.id });
  const { error: updateError } = await admin.from("agent_videos").update({ render_status: "queued" }).eq("id", job.id).eq("user_id", user.id); if (updateError) return json({ error: updateError.message }, 502);
  return json({ status: "queued", videoId: job.id, workerContract: { poll: "agent_videos where render_status=queued", input: ["song audio storage path", "artwork storage path"], output: "MP4 uploaded to songcraft storage and row updated to ready" } });
});
