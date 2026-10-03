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

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Porovnání v konstantním čase, stejně jako u youtube-publish. */
function sameBytes(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

/**
 * Explicit confirmation boundary. The token is forwarded over the internal
 * Supabase Functions call but never logged, persisted, or accepted as a
 * service-role credential. The youtube-publish function performs the atomic
 * nonce claim and all ownership/metadata checks.
 */
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "Použij POST." }, 405);
  const authorization = request.headers.get("Authorization");
  const url = Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY");
  if (!url || !anonKey) return json({ error: "Chybí konfigurace serveru (SUPABASE_URL / SUPABASE_ANON_KEY)." }, 503);
  if (!authorization) return json({ error: "Chybí přihlášení." }, 401);

  const auth = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await auth.auth.getUser();
  if (authError || !user) return json({ error: "Neplatné přihlášení." }, 401);
  if (!isAllowedPrivateUser(user, { allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined, allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined })) return json({ error: privateAccessMessage() }, 403);
  const input = await request.json().catch(() => null) as { action?: unknown; confirmationId?: unknown; confirmationToken?: unknown } | null;
  if (typeof input?.action !== "string" || typeof input.confirmationId !== "string" || typeof input.confirmationToken !== "string") {
    return json({ error: "Chybí action, confirmationId nebo confirmationToken." }, 400);
  }

  // Operace na VM nejdou přes youtube-publish. Potvrzení tady jen přepne stav
  // řádku v agent_ops z pending_confirmation na approved a ops-runner na VM ho
  // vyzvedne. Bez platného nonce se nic nespustí.
  if (input.action !== "publish_to_youtube") {
    const OPS_ACTIONS = ["run_vm_command", "push_git_branch", "deploy_worker", "read_repo_file", "read_skills"];
    if (!OPS_ACTIONS.includes(input.action)) return json({ error: "Tato potvrzovací akce zatím není podporována." }, 400);
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceKey) return json({ error: "Chybí konfigurace serveru." }, 503);
    const admin = createClient(url, serviceKey);
    const id = encodeURIComponent(input.confirmationId);
    const { data: row, error: readError } = await admin
      .from("agent_ops")
      .select("id,user_id,kind,summary,status,expires_at,nonce_hash")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();
    if (readError || !row) return json({ error: "Operace nenalezena." }, 404);
    if (row.status !== "pending_confirmation") return json({ error: `Operace už je ve stavu ${row.status}.` }, 409);
    // Bez shody tokenu s uloženým hashem operaci neschválíme. Samotné ID řádku
    // není potvrzení.
    if (!sameBytes(await hashToken(input.confirmationToken), String(row.nonce_hash ?? ""))) {
      await admin.from("agent_action_log").insert({
        user_id: user.id,
        agent_name: "agent",
        tool_name: `confirm:${input.action}`,
        status: "error",
        payload: { opId: row.id, reason: "neplatný potvrzovací token" },
      });
      return json({ error: "Potvrzení není platné." }, 403);
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await admin.from("agent_ops").update({ status: "expired" }).eq("id", row.id);
      return json({ error: "Potvrzení vypršelo, potvrď to prosím znovu." }, 409);
    }
    const { data: claim, error: claimError } = await admin
      .from("agent_ops")
      .update({ status: "approved" })
      .eq("id", row.id)
      .eq("status", "pending_confirmation")
      .select("id,kind,summary")
      .single();
    if (claimError || !claim) return json({ error: "Operaci už někdo potvrdil." }, 409);
    await admin.from("agent_action_log").insert({
      user_id: user.id,
      agent_name: "agent",
      tool_name: `confirm:${input.action}`,
      status: "success",
      payload: { opId: claim.id, kind: claim.kind, summary: claim.summary },
    });
    return json({
      status: "approved",
      operationId: claim.id,
      kind: claim.kind,
      summary: claim.summary,
      message: "Potvrzeno. Operace se spustí na VM, sleduj ji přes check_op_status.",
    });
  }

  const response = await fetch(`${url}/functions/v1/youtube-publish`, {
    method: "POST",
    headers: { Authorization: authorization, apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ confirmationId: input.confirmationId, confirmationToken: input.confirmationToken }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const body = await response.json().catch(() => ({ error: "Potvrzovací služba vrátila neplatnou odpověď." }));
  return json(body, response.status);
});
