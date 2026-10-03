import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Nahrávání obalů nešlo a hláška byla "Storage object MIME type is not allowed"
 * i pro JPG. Příčina: trigger v živé DB byl starší verze, než je v repu, protože
 * soubor migrace se editoval až po aplikaci. Tyhle testy drží trigger, bucket a
 * povolené typy pohromadě, aby se to nemohlo rozejít znovu.
 */
const migration = readFileSync("supabase/migrations/20260930000000_storage_guard_mime_fix.sql", "utf8");
const bootstrap = readFileSync("supabase/migrations/20260925110000_core_schema_bootstrap.sql", "utf8");
const storagePaths = readFileSync("lib/storage-paths.ts", "utf8");

const REQUIRED = ["image/jpeg", "image/png", "image/webp", "audio/mpeg", "video/mp4"];

describe("ochrana storage", () => {
  it("trigger dovolí typy, které aplikace reálně posílá", () => {
    for (const mime of REQUIRED) {
      expect(migration, `trigger bez ${mime}`).toContain(`'${mime}'`);
    }
  });

  it("prázdný typ se netrestí, bucket to posoudí sám", () => {
    expect(migration).toContain("if object_mime <> '' and not (object_mime = any (allowed_mime))");
  });

  it("bucket a trigger mají stejný seznam", () => {
    const bucketBlock = migration.slice(migration.indexOf("update storage.buckets"));
    for (const mime of REQUIRED) {
      expect(bucketBlock, `bucket bez ${mime}`).toContain(`'${mime}'`);
    }
  });

  it("vlastnictví cesty a limit velikosti zůstávají", () => {
    expect(migration).toContain("Storage object path does not belong to the current user");
    expect(migration).toContain("object_size > 180 * 1024 * 1024");
    expect(migration).toContain("service_role");
  });

  it("původní definice zůstává v bootstrapu nedotčená", () => {
    // nesmí se to opravovat editací starého souboru, to je přesně chyba,
    // která vznikla
    expect(bootstrap).toContain("create or replace function public.songcraft_storage_object_guard()");
  });

  it("klient posílá typy, které trigger zná", () => {
    expect(storagePaths).toContain('return { mimeType: sniffed');
  });
});
