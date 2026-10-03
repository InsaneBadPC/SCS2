import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { albums, audioVersions, lyricDocuments, songs } from "../drizzle/schema";

describe("SongCraft cloudový model", () => {
  it("obsahuje čtyři oddělené doménové tabulky", () => {
    expect([albums, lyricDocuments, songs, audioVersions].map(getTableName)).toEqual([
      "albums",
      "lyricDocuments",
      "songs",
      "audioVersions",
    ]);
  });

  it("odděluje originál MP3 od exportované kopie s ID3 tagy", () => {
    expect(audioVersions.storageKey.name).toBe("storageKey");
    expect(audioVersions.taggedStorageKey.name).toBe("taggedStorageKey");
    expect(audioVersions.id3Title.name).toBe("id3Title");
  });
});
