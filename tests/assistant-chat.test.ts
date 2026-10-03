import { describe, expect, it } from "vitest";

import { createAssistantRequest } from "../lib/assistant-chat-payload";

describe("assistant chat request", () => {
  it("keeps only a bounded, text-only conversation payload", () => {
    const result = createAssistantRequest(" Jaký refrén by seděl? ", Array.from({ length: 12 }, (_, index) => ({ id: String(index), role: index % 2 ? "assistant" as const : "user" as const, content: ` zpráva ${index} ` })));
    expect(result.message).toBe("Jaký refrén by seděl?");
    expect(result.history).toHaveLength(10);
    expect(result.history[0].content).toBe("zpráva 2");
  });

  it("rejects an empty prompt before any network call", () => {
    expect(() => createAssistantRequest("   ", [])).toThrow("Napiš zprávu");
  });
});
