import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isAllowedPrivateUser, privateAccessMessage } from "../_shared/access.ts";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });

/**
 * Kam poslat render. Dřív toto nebylo nikde definované a funkce jen přepsala
 * řádek na `queued` a vrátila `status: "queued"`, i když nikde neběžel žádný
 * worker. Klient pak čekal na video, které nemohl vzniknout.
 *
 * Nastavením VIDEO_RENDERER_URL na adresu hostovaného workeru (viz
 * workers/video-renderer/README.md) se dispatch zase zapne; bez ní funkce
 * fail-closed odmítne, místo aby posílal práci do prázdna.
 */
const rendererUrl = Deno.env.get("VIDEO_RENDERER_URL") || Deno.env.get("SONGCRAFT_VIDEO_RENDERER_URL") || "";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  const authorization = request.headers.get("Authorization"); const url = Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL"); const anon = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY"); const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SONGCRAFT_SERVICE_ROLE_KEY"); if (!url || !anon || !service) return json({ error: "Chybí konfigurace serveru." }, 503); if (!authorization) return json({ error: "Chybí přihlášení." }, 401);
  const auth = createClient(url, anon, { global: { headers: { Authorization: authorization } } }); const { data: { user } } = await auth.auth.getUser(); if (!user) return json({ error: "Neplatné přihlášení." }, 401); if (!isAllowedPrivateUser(user, { allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined, allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined })) return json({ error: privateAccessMessage() }, 403); const admin = createClient(url, service);
  const body = await request.json().catch(() => null) as { videoId?: string } | null; if (!body?.videoId) return json({ error: "Chybí videoId." }, 400);
  const { data: job, error } = await admin.from("agent_videos").select("id,song_id,type,render_status").eq("id", body.videoId).eq("user_id", user.id).maybeSingle(); if (error || !job) return json({ error: "Renderovací úloha nebyla nalezena." }, 404);

  // Renderer se ověřuje PŘED zápisem do fronty. Kdyby se řádek nejdřív přepsal na
  // `queued` a pak se zjistilo, že renderer neexistuje, zůstal by job ve stavu
  // `queued` bez spotřebitele a UI by čekalo na video, které nikdo nevyrenderuje.
  if (!rendererUrl) {
    return json({
      error: "Video renderer není nasazený. Fronta nemá žádného spotřebitele, proto se úloha neodesílá.",
      detail: "Set VIDEO_RENDERER_URL on this function to the address of a hosted workers/video-renderer worker (static_cover, video_loop and source_loop need only ffmpeg). image_animation and full_scenes additionally need the ai-video-generator dashboard on that host.",
      videoId: job.id,
      currentStatus: job.render_status,
    }, 503);
  }
  if (job.render_status !== "queued") return json({ status: job.render_status, videoId: job.id });

  let dispatch;
  try {
    dispatch = await fetch(`${rendererUrl.replace(/\/+$/, "")}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: service, Authorization: `Bearer ${service}` },
      body: JSON.stringify({ videoId: job.id }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return json({ error: `Video renderer na ${rendererUrl} neodpovídá (${(error as Error).name}).`, detail: "Job zůstal ve frontě beze změny.", videoId: job.id }, 502);
  }
  if (!dispatch.ok) {
    const text = await dispatch.text().catch(() => "");
    return json({ error: `Video renderer odmítl úlohu (${dispatch.status}).`, detail: text.slice(0, 300), videoId: job.id }, 502);
  }
  const { error: updateError } = await admin.from("agent_videos").update({ render_status: "queued" }).eq("id", job.id).eq("user_id", user.id); if (updateError) return json({ error: updateError.message }, 502);
  return json({ status: "queued", videoId: job.id, workerContract: { poll: "agent_videos where render_status=queued", input: ["song audio storage path", "artwork storage path"], output: "MP4 uploaded to songcraft storage and row updated to ready" } });
});
