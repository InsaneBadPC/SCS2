import { describe, expect, it } from "vitest";

import {
  constantTimeEquals,
  isUuid,
  resolveCallerScope,
  resolveTargetUserId,
} from "../supabase/functions/_shared/scheduler-auth";

const SERVICE_ROLE = "service-role-test-key-never-real";
const CRON_SECRET = "cron-secret-test-never-real";
const USER_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_USER_ID = "99999999-8888-7777-6666-555555555555";

const env = { url: "https://project.test", anonKey: "anon-test-key", serviceRoleKey: SERVICE_ROLE, cronSecret: CRON_SECRET };
const request = (headers: Record<string, string>) =>
  new Request("https://project.test/functions/v1/youtube-sync-stats", { method: "POST", headers });
const noUser = { user: async () => null };

describe("scheduler autorizace", () => {
  it("odmítne požadavek bez jakékoli autorizace", async () => {
    expect(await resolveCallerScope(request({}), env, noUser)).toEqual(expect.objectContaining({ ok: false, status: 401 }));
  });

  it("přijme service role jako scheduler", async () => {
    const result = await resolveCallerScope(request({ Authorization: `Bearer ${SERVICE_ROLE}` }), env, noUser);
    expect(result).toEqual({ ok: true, scope: { role: "scheduler" } });
  });

  it("nepřijme jiný bearer token jako scheduler", async () => {
    expect(await resolveCallerScope(request({ Authorization: "Bearer jiny-token" }), env, noUser)).toEqual(
      expect.objectContaining({ ok: false, status: 401 }),
    );
  });

  it("nepřijme service role s jinou délkou ani s case/prefix podvihem", async () => {
    for (const bearer of [`${SERVICE_ROLE}x`, `x${SERVICE_ROLE}`, SERVICE_ROLE.toUpperCase(), SERVICE_ROLE.slice(1)]) {
      expect((await resolveCallerScope(request({ Authorization: `Bearer ${bearer}` }), env, noUser)).ok, bearer).toBe(false);
    }
  });

  it("přijme x-cron-secret jako scheduler", async () => {
    const result = await resolveCallerScope(request({ "x-cron-secret": CRON_SECRET }), env, noUser);
    expect(result).toEqual({ ok: true, scope: { role: "scheduler" } });
  });

  it("odmítne chybné x-cron-secret", async () => {
    expect(await resolveCallerScope(request({ "x-cron-secret": `${CRON_SECRET}-x` }), env, noUser)).toEqual(
      expect.objectContaining({ ok: false, status: 401 }),
    );
  });

  it("bez nakonfigurovaného cron secretu hlavičku x-cron-secret ignoruje", async () => {
    const result = await resolveCallerScope(request({ "x-cron-secret": CRON_SECRET }), { ...env, cronSecret: undefined }, noUser);
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 401 }));
  });

  it("přijme podepsaný service_role claim jako scheduler", async () => {
    const result = await resolveCallerScope(request({ Authorization: "Bearer service-jwt" }), env, {
      user: async () => null,
      serviceRoleClaim: async (bearer) => bearer === "service-jwt",
    });
    expect(result).toEqual({ ok: true, scope: { role: "scheduler" } });
  });

  it("neváže se na tvrzení ověřovací funkce, která hodí výjimku", async () => {
    const result = await resolveCallerScope(request({ Authorization: "Bearer service-jwt" }), env, {
      user: async () => null,
      serviceRoleClaim: async () => {
        throw new Error("jwks nedostupné");
      },
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 401 }));
  });

  it("přihlášeného uživatele omezí na jeho vlastní scope", async () => {
    const result = await resolveCallerScope(request({ Authorization: "Bearer uzivatelsky-jwt" }), env, { user: async () => USER_ID });
    expect(result).toEqual({ ok: true, scope: { role: "user", userId: USER_ID } });
  });

  it("neplatné přihlášení odmítne a nepromění ho v scheduler", async () => {
    expect(await resolveCallerScope(request({ Authorization: "Bearer spatne-jwt" }), env, noUser)).toEqual(
      expect.objectContaining({ ok: false, status: 401 }),
    );
  });

  it("bez konfigurace anon klíče uživatelskou cestu odmítne", async () => {
    const result = await resolveCallerScope(request({ Authorization: "Bearer jwt" }), { ...env, anonKey: undefined }, { user: async () => USER_ID });
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 503 }));
  });

  it("neselže, když ověření tokenu hodí výjimku", async () => {
    const result = await resolveCallerScope(request({ Authorization: "Bearer jwt" }), env, {
      user: async () => {
        throw new Error("network");
      },
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 401 }));
  });
});

describe("userId v těle požadavku", () => {
  it("scheduler smí vybrat konkrétní účet, ale jen jako UUID", () => {
    const scheduler = { role: "scheduler" } as const;
    expect(resolveTargetUserId(scheduler, undefined)).toEqual({ ok: true, userId: null });
    expect(resolveTargetUserId(scheduler, "")).toEqual({ ok: true, userId: null });
    expect(resolveTargetUserId(scheduler, OTHER_USER_ID)).toEqual({ ok: true, userId: OTHER_USER_ID });
    expect(resolveTargetUserId(scheduler, "not-a-uuid")).toEqual(expect.objectContaining({ ok: false, status: 400 }));
    expect(resolveTargetUserId(scheduler, { userId: OTHER_USER_ID })).toEqual(expect.objectContaining({ ok: false, status: 400 }));
    expect(resolveTargetUserId(scheduler, ["../other"])).toEqual(expect.objectContaining({ ok: false, status: 400 }));
    expect(resolveTargetUserId(scheduler, `${OTHER_USER_ID} ' or '1'='1`)).toEqual(expect.objectContaining({ ok: false, status: 400 }));
  });

  it("uživatel si smí jen vlastní účet, cizí dostane 403", () => {
    const user = { role: "user", userId: USER_ID } as const;
    expect(resolveTargetUserId(user, undefined)).toEqual({ ok: true, userId: null });
    expect(resolveTargetUserId(user, USER_ID)).toEqual({ ok: true, userId: USER_ID });
    expect(resolveTargetUserId(user, OTHER_USER_ID)).toEqual(expect.objectContaining({ ok: false, status: 403 }));
  });
});

describe("helpery", () => {
  it("validuje UUID", () => {
    expect(isUuid(USER_ID)).toBe(true);
    expect(isUuid(USER_ID.toUpperCase())).toBe(true);
    expect(isUuid(`${USER_ID} ' or 1=1`)).toBe(false);
    expect(isUuid("../storage")).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });

  it("porovnává tajné hodnoty bez předčasného ukončení", () => {
    expect(constantTimeEquals("abcd", "abcd")).toBe(true);
    expect(constantTimeEquals("abcd", "abce")).toBe(false);
    expect(constantTimeEquals("abcd", "abcde")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
  });
});
