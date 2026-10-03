import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const renderTypes = readFileSync("supabase/migrations/20260925000000_agent_video_render_types.sql", "utf8");
const confirmation = readFileSync("supabase/migrations/20260925130000_agent_confirmations.sql", "utf8");
const oauth = readFileSync("supabase/migrations/20260925150000_youtube_oauth_states.sql", "utf8");
const leases = readFileSync("supabase/migrations/20260925140000_video_worker_leases.sql", "utf8");
const videoLoop = readFileSync("supabase/migrations/20260928120000_agent_video_loop_mode.sql", "utf8");
const sourceLoop = readFileSync("supabase/migrations/20260929000000_agent_video_source_loop.sql", "utf8");

describe("production workflow migrations", () => {
  it("targets the render type constraint by column, not by text matching", () => {
    expect(renderTypes).toContain("a.attname = 'type'");
    expect(renderTypes).not.toContain("pg_get_constraintdef(oid) LIKE '%type%'");
    expect(renderTypes).toContain("conname = 'agent_videos_type_check'");
  });

  it("stores only hashed, expiring one-time confirmations", () => {
    expect(confirmation).toContain("nonce_hash text not null unique");
    expect(confirmation).toContain("status text not null default 'pending'");
    expect(confirmation).toContain("revoke all on public.agent_confirmations");
  });

  it("stores OAuth verifier server-side with an expiry", () => {
    expect(oauth).toContain("code_verifier text not null");
    expect(oauth).toContain("state_hash text not null unique");
    expect(oauth).toContain("revoke all on public.youtube_oauth_states");
  });

  it("defines bounded worker retries and leases", () => {
    expect(leases).toContain("attempt_count integer not null default 0");
    expect(leases).toContain("lease_expires_at timestamptz");
    expect(leases).toContain("agent_videos_attempts_check");
  });

  it("extends the render types instead of weakening the constraint", () => {
    // video_loop se přidává do existující hlídky, nesmí se mazat
    expect(videoLoop).toContain("agent_videos_type_check");
    expect(videoLoop).toContain("'static_cover', 'image_animation', 'full_scenes', 'video_loop'");
    expect(videoLoop).toContain("agent_videos_mode_check");
    expect(videoLoop).not.toMatch(/drop constraint if exists agent_videos_type_check\s*;\s*alter table[^;]*add constraint agent_videos_type_check\s+check \(\s*type in \('static_cover'\)/);
  });

  it("migrates legacy render values instead of leaving rows that fail the check", () => {
    expect(videoLoop).toContain("set mode = 'video_loop', type = 'video_loop'");
    expect(videoLoop).toContain("where mode = 'loop_video' or type in ('short', 'lyric_video')");
    expect(videoLoop).toContain("set backend = 'ffmpeg'");
    expect(videoLoop).toContain("where backend = 'vm_loop'");
  });

  it("fails the migration closed when illegal values remain", () => {
    expect(videoLoop).toContain("raise exception");
    expect(videoLoop).toContain("agent_videos má neplatné hodnoty po migraci");
  });

  it("adds source_loop as the primary render type instead of the dashboard modes", () => {
    expect(sourceLoop).toContain("'static_cover', 'image_animation', 'full_scenes', 'video_loop', 'source_loop'");
    expect(sourceLoop).toContain("agent_videos_type_check");
    expect(sourceLoop).toContain("agent_videos_mode_check");
    // staré hodnoty agenta se přemapují, ne zůstanou viset
    expect(sourceLoop).toContain("set mode = 'source_loop', type = 'source_loop'");
    expect(sourceLoop).toContain("raise exception");
  });

  it("never names a SQL function parameter after a reserved word", () => {
    // Regrese: sc_owned_storage_path(user uuid, p text) spadlo na 42601
    // ("syntax error at or near user"), takže migrace 20260928000000 nikdy
    // neplatila a source_video_path v produkci neexistoval.
    const reserved = [
      "user", "table", "order", "group", "select", "where", "limit", "type", "mode",
      "check", "default", "primary", "key", "references", "constraint", "column",
      "all", "and", "or", "not", "null", "true", "false", "case", "when", "then",
      "else", "end", "using", "natural", "join", "left", "right", "inner", "outer",
      "on", "as", "asc", "desc", "distinct", "having", "union", "into", "values",
      "returning", "with", "grant", "revoke", "row", "rows", "set", "begin", "commit",
      "to", "from", "for", "if", "window", "over", "partition", "do", "column_name",
    ];
    const offenders: string[] = [];
    for (const file of readdirSync("supabase/migrations")) {
      if (!file.endsWith(".sql")) continue;
      const sql = readFileSync(`supabase/migrations/${file}`, "utf8");
      const pattern = /(?:function|procedure)\s+\w+\s*\(([^)]*)\)/gi;
      for (const match of sql.matchAll(pattern)) {
        for (const raw of (match[1] ?? "").split(",")) {
          const name = raw.trim().split(/\s+/)[0]?.toLowerCase();
          if (name && reserved.includes(name)) offenders.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(offenders, `rezervovaná slova jako parametry:\n${offenders.join("\n")}`).toEqual([]);
  });
});
