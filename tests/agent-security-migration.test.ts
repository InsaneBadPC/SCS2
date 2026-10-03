import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// SQL assertions nad migračním souborem. Testy jsou offline (žádná síť, žádná DB),
// takže se dají spustit v CI bez produkčních credentialů.
const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");
const migration = read("supabase", "migrations", "20260925010000_agent_security_hardening.sql");
const syncStats = read("supabase", "functions", "youtube-sync-stats", "index.ts");

describe("security hardening migrace", () => {
  it("youtube_credentials nechává jen service role", () => {
    expect(migration).toContain("songcraft_drop_client_policies('public.youtube_credentials')");
    expect(migration).toContain("revoke all on public.youtube_credentials from %I");
    expect(migration).toContain("grant select, insert, update, delete on public.youtube_credentials to service_role");
    expect(migration).toContain("youtube_credentials vystavuje client policy");
  });

  it("audit log je append-only a server-only", () => {
    expect(migration).toContain("create or replace function public.agent_action_log_append_only() returns trigger");
    expect(migration).toContain("create trigger agent_action_log_append_only_trg");
    expect(migration).toContain("before truncate on public.agent_action_log");
    expect(migration).toContain("revoke insert, update, delete, truncate on public.agent_action_log from %I");
    expect(migration).toContain("agent_action_log je append-only");
  });

  it("render status a storage cesty v agent_videos mění jen server", () => {
    expect(migration).toContain("create trigger agent_videos_server_columns_trg");
    expect(migration).toContain("render_status a storage cesty mění jen server");
    expect(migration).toContain("revoke insert, update, delete, truncate on public.agent_videos from %I");
  });

  it("vynucuje user prefix na storage cestách", () => {
    expect(migration).toContain("create or replace function public.songcraft_path_allowed(owner_id uuid, path_value text) returns boolean");
    for (const constraint of [
      "agent_videos_storage_path_user_prefix",
      "agent_videos_output_path_user_prefix",
      "agent_videos_audio_storage_path_user_prefix",
      "agent_image_assets_base_path_user_prefix",
      "agent_image_assets_final_path_user_prefix",
      "agent_media_uploads_storage_path_user_prefix",
    ]) {
      expect(migration, constraint).toContain(`'${constraint}'`);
    }
    expect(migration).toContain("create trigger agent_videos_guard_paths_trg");
    expect(migration).toContain("create trigger agent_image_assets_guard_paths_trg");
    expect(migration).toContain("create trigger agent_media_uploads_guard_paths_trg");
    expect(migration).toContain("tg_op = 'INSERT'");
    expect(migration).toContain("new.storage_path is distinct from old.storage_path");
  });

  it("běží atomicky a fail-closed na legacy cestách", () => {
    expect(migration.trimStart().startsWith("--")).toBe(true);
    expect(migration).toContain("\nbegin;\n");
    expect(migration).toContain("legacy storage cesty");
    expect(migration.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("je idempotentní a nedestruktivní", () => {
    const code = migration.replace(/^\s*--.*$/gm, "");
    expect(code).not.toMatch(/drop\s+table/i);
    expect(code).not.toMatch(/delete\s+from\s+public\./i);
    expect(code).not.toMatch(/truncate\s+table/i);
    expect(code).not.toMatch(/update\s+public\./i);
    // každý create trigger má před sebou drop trigger if exists
    for (const [, trigger] of code.matchAll(/create trigger (\w+)/g)) {
      const before = code.slice(0, code.indexOf(`create trigger ${trigger}`));
      expect(before, trigger).toContain(`drop trigger if exists ${trigger} on`);
    }
  });

  it("zachovává client read/write cesty, které UI používá", () => {
    expect(migration).toContain("chybí SELECT policy pro klienta");
    expect(migration).toContain("chybí INSERT/UPDATE policy, kterou klient používá");
    for (const table of ["agent_settings", "agent_conversations", "agent_messages", "agent_recommendations", "agent_media_uploads"]) {
      expect(migration, table).toContain(`'${table}'`);
    }
  });
});

describe("youtube-sync-stats", () => {
  it("vyžaduje explicitní autorizaci a omezuje userId", () => {
    expect(syncStats).toContain("resolveCallerScope");
    expect(syncStats).toContain("resolveTargetUserId");
    expect(syncStats).toContain("if (request.method !== \"POST\")");
    expect(syncStats).toContain("SYNC_STATS_CRON_SECRET");
    expect(syncStats).not.toContain("if (input.userId) query = query.eq");
  });

  it("nevraceí tokeny ani cizí data v odpovědi", () => {
    expect(syncStats).not.toMatch(/json\(\{[^}]*access_token/);
    expect(syncStats).not.toMatch(/json\(\{[^}]*refresh_token/);
    expect(syncStats).toContain("scope: caller.scope.role");
  });

  it("ohraničuje práci (počet účtů, dní, publikací, timeout)", () => {
    expect(syncStats).toContain("MAX_CREDENTIALS = 100");
    expect(syncStats).toContain("MAX_PUBLICATIONS = 100");
    expect(syncStats).toContain("MAX_DAYS = 30");
    expect(syncStats).toContain("AbortSignal.timeout(ANALYTICS_TIMEOUT_MS)");
  });
});
