import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const legacyDeployer = readFileSync("scripts/create-youtube-export-function.mjs", "utf8");
const legacyVideo = readFileSync("scripts/render/render-youtube.mjs", "utf8");
const legacyCover = readFileSync("scripts/render/compose-cover.mjs", "utf8");

describe("legacy public render pipeline", () => {
  it("je fail-closed a neobsahuje renderer credential", () => {
    expect(legacyDeployer).toContain("retired");
    expect(legacyVideo).toContain("retired");
    expect(legacyCover).toContain("retired");
    expect(legacyDeployer).not.toContain("ffmpeg_site_");
    expect(legacyVideo).not.toContain("releases/download");
    expect(legacyCover).not.toContain("api.github.com");
  });
});
