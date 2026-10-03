import { describe, expect, it } from "vitest";
import { isAllowedPrivateUser } from "../supabase/functions/_shared/access";

describe("private Edge Function allowlist", () => {
  it("fail-closes when no allowlist is configured", () => {
    expect(isAllowedPrivateUser({ id: "user-1", email: "a@example.com" }, {})).toBe(false);
  });

  it("matches immutable IDs and normalized emails only", () => {
    expect(isAllowedPrivateUser({ id: "USER-1" }, { allowedUserIds: "user-1" })).toBe(true);
    expect(isAllowedPrivateUser({ id: "user-2", email: "A@EXAMPLE.COM" }, { allowedEmails: "a@example.com" })).toBe(true);
    expect(isAllowedPrivateUser({ id: "user-2", email: "b@example.com" }, { allowedUserIds: "user-1", allowedEmails: "a@example.com" })).toBe(false);
  });
});
