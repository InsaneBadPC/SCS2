import { describe, expect, it } from "vitest";

import { getPlayableAudioUrl } from "../lib/audio-source";

describe("getPlayableAudioUrl", () => {
  it("přijme pouze úplnou HTTPS adresu pro nativní přehrávač", () => {
    expect(getPlayableAudioUrl("https://storage.example.test/audio.mp3?token=abc")).toBe("https://storage.example.test/audio.mp3?token=abc");
    expect(getPlayableAudioUrl("http://storage.example.test/audio.mp3")).toBeNull();
    expect(getPlayableAudioUrl("content://broken-file")).toBeNull();
    expect(getPlayableAudioUrl("")).toBeNull();
    expect(getPlayableAudioUrl(undefined)).toBeNull();
  });
});
