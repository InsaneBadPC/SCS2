import { describe, expect, it } from "vitest";

import {
  assertOwnedStoragePath,
  buildOwnedStoragePath,
  isOwnedStoragePath,
  validateStorageUpload,
} from "../lib/storage-paths";

const userId = "11111111-1111-4111-8111-111111111111";

describe("storage path boundary", () => {
  it("accepts only paths inside the current user prefix", () => {
    expect(isOwnedStoragePath(userId, `${userId}/audio/final.mp3`)).toBe(true);
    expect(isOwnedStoragePath(userId, "22222222-2222-4222-8222-222222222222/audio/final.mp3")).toBe(false);
    expect(isOwnedStoragePath(userId, `${userId}/../other/file.mp3`)).toBe(false);
    expect(() => assertOwnedStoragePath(userId, "other/file.mp3")).toThrow();
  });

  it("builds a sanitized, unique user-owned path", () => {
    const path = buildOwnedStoragePath(userId, "covers", "../../cover na?.png", "fixed-suffix");
    expect(path).toBe(`${userId}/covers/fixed-suffix-cover_na_.png`);
  });

  it("validates image size and signature before upload", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(validateStorageUpload({ folder: "covers", contentType: "image/png", fileName: "cover.png", bytes: png }).mimeType).toBe("image/png");
    expect(() => validateStorageUpload({ folder: "covers", contentType: "image/png", fileName: "cover.png", bytes: new Uint8Array([1, 2, 3]) })).toThrow();
  });
});
