import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isAllowedPrivateUser } from "../_shared/access.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const appRedirect = Deno.env.get("SONGCRAFT_APP_REDIRECT_URL") || "songcraftstudio://settings/youtube";

function redirect(status: string, extra: Record<string, string> = {}) {
  const url = new URL(appRedirect);
  url.searchParams.set("youtube", status);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return new Response(null, { status: 302, headers: { Location: url.toString(), "Cache-Control": "no-store" } });
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors });
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code")?.trim() ?? "";
  const state = requestUrl.searchParams.get("state")?.trim() ?? "";
  if (!code || !state || state.length > 256 || code.length > 2048) return redirect("error", { reason: "invalid_request" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SONGCRAFT_SERVICE_ROLE_KEY");
  const clientId = Deno.env.get("YOUTUBE_CLIENT_ID");
  const clientSecret = Deno.env.get("YOUTUBE_CLIENT_SECRET");
  if (!supabaseUrl || !serviceKey || !clientId || !clientSecret) return redirect("error", { reason: "not_configured" });
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: stateRow, error: stateError } = await admin
    .from("youtube_oauth_states")
    .select("id,user_id,code_verifier,redirect_uri,expires_at,consumed_at")
    .eq("state_hash", await sha256(state))
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (stateError || !stateRow) return redirect("error", { reason: "invalid_state" });
  const { data: userRecord } = await admin.auth.admin.getUserById(stateRow.user_id);
  if (!isAllowedPrivateUser(userRecord?.user, { allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined, allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined })) return redirect("error", { reason: "account_not_allowed" });

  // Claim the state before exchanging the code. A replay cannot reach Google.
  const { data: claimed, error: claimError } = await admin
    .from("youtube_oauth_states")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", stateRow.id)
    .is("consumed_at", null)
    .select("id,user_id,code_verifier,redirect_uri")
    .maybeSingle();
  if (claimError || !claimed) return redirect("error", { reason: "state_already_used" });

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, code_verifier: claimed.code_verifier, grant_type: "authorization_code", redirect_uri: claimed.redirect_uri }),
      signal: AbortSignal.timeout(20_000),
    });
    const token = await tokenResponse.json().catch(() => null) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error_description?: string } | null;
    if (!tokenResponse.ok || !token?.access_token) return redirect("error", { reason: "token_exchange_failed" });

    const channelResponse = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&mine=true", { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(20_000) });
    const channelBody = await channelResponse.json().catch(() => null) as { items?: Array<{ id?: string; snippet?: { title?: string } }> } | null;
    const channelId = channelBody?.items?.[0]?.id;
    if (!channelResponse.ok || !channelId) return redirect("error", { reason: "channel_lookup_failed" });

    const existing = await admin.from("youtube_credentials").select("refresh_token").eq("user_id", claimed.user_id).maybeSingle();
    const refreshToken = token.refresh_token || existing.data?.refresh_token || null;
    const { error: saveError } = await admin.from("youtube_credentials").upsert({
      user_id: claimed.user_id,
      access_token: token.access_token,
      refresh_token: refreshToken,
      expires_at: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
      channel_id: channelId,
      scopes: token.scope?.split(" ").filter(Boolean) ?? [],
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (saveError) return redirect("error", { reason: "credential_save_failed" });
    return redirect("connected");
  } catch {
    return redirect("error", { reason: "oauth_failed" });
  }
});
