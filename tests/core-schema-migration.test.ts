import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/20260925110000_core_schema_bootstrap.sql", "utf8");
const pathMigration = readFileSync("supabase/migrations/20260925170000_core_storage_paths.sql", "utf8");

describe("core schema bootstrap", () => {
  it("vytváří tabulky, které klient i Edge workflow skutečně používají", () => {
    for (const table of ["sc_albums", "sc_lyrics", "sc_songs", "sc_audio_versions", "sc_style_prompts", "sc_cover_jobs", "sc_video_jobs"]) {
      expect(migration).toContain(`create table if not exists public.${table}`);
    }
  });

  it("nastavuje media bucket jako private a vlastnické storage policy", () => {
    expect(migration).toContain("on conflict (id) do update set public = false");
    expect(migration).toContain("storage.foldername(name))[1] = auth.uid()::text");
    expect(migration).not.toContain("values ('songcraft', 'songcraft', true)");
  });

  it("hlídá user-prefix core storage paths", () => {
    expect(pathMigration).toContain("sc_songs_path_guard_trg");
    expect(pathMigration).toContain("public.songcraft_path_allowed");
    expect(pathMigration).toContain("to_jsonb(new)");
    expect(pathMigration).toContain("to_jsonb(old)");
    expect(pathMigration).not.toContain("tg_table_name :=");
  });

  it("nepoužívá destruktivní DDL", () => {
    expect(migration).not.toMatch(/\b(drop\s+table|truncate\s+table|delete\s+from)\b/i);
  });
});
