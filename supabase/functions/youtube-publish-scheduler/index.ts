import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveCallerScope, resolveTargetUserId } from "../_shared/scheduler-auth.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const env = {
  url: Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL"),
  anonKey: Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY"),
  serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SONGCRAFT_SERVICE_ROLE_KEY"),
  cronSecret: Deno.env.get("PUBLISH_SCHEDULER_SECRET") || Deno.env.get("SONGCRAFT_PUBLISH_SCHEDULER_SECRET"),
};
const verifyUser = async (bearer: string) => {
  if (!env.url || !env.anonKey) return null;
  const client = createClient(env.url, env.anonKey, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
  const { data, error } = await client.auth.getUser();
  return error || !data?.user ? null : data.user.id;
};
const verifyServiceRoleClaim = async (bearer: string) => {
  if (!env.url || !env.anonKey) return false;
  const client = createClient(env.url, env.anonKey);
  const { data, error } = await client.auth.getClaims(bearer);
  return !error && data?.claims?.role === "service_role";
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "Použij POST." }, 405);
  if (!env.url || !env.serviceRoleKey) return json({ error: "Chybí konfigurace." }, 503);
  const caller = await resolveCallerScope(request, env, { user: verifyUser, serviceRoleClaim: verifyServiceRoleClaim });
  if (!caller.ok) return json({ error: caller.error }, caller.status);
  const input = await request.json().catch(() => ({})) as { userId?: unknown };
  const target = resolveTargetUserId(caller.scope, input.userId);
  if (!target.ok) return json({ error: target.error }, target.status);
  const admin = createClient(env.url, env.serviceRoleKey);
  let query = admin.from("youtube_publications").select("id,user_id,scheduled_at").eq("status", "scheduled").lte("scheduled_at", new Date().toISOString()).order("scheduled_at", { ascending: true }).limit(100);
  if (target.userId) query = query.eq("user_id", target.userId);
  const { data, error } = await query;
  if (error) return json({ error: error.message }, 502);
  let prepared = 0;
  for (const publication of data ?? []) {
    const { error: updateError } = await admin.from("youtube_publications").update({ status: "draft", error_message: "Čeká na explicitní potvrzení uživatele." }).eq("id", publication.id).eq("user_id", publication.user_id).eq("status", "scheduled");
    if (updateError) continue;
    prepared += 1;
    await admin.from("agent_recommendations").insert({ user_id: publication.user_id, category: "schedule", recommendation: "Naplánovaná publikace je připravena k potvrzení.", reasoning: "Scheduler ji převedl do draftu; veřejná změna zůstává na uživateli.", status: "pending" });
    await admin.from("agent_action_log").insert({ user_id: publication.user_id, action_type: "prepare_scheduled_publication", target_id: publication.id, payload: { scheduledAt: publication.scheduled_at }, result: "success" });
  }
  return json({ prepared, scope: caller.scope.role });
});
