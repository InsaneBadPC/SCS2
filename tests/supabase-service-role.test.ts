import { describe, expect, it } from "vitest";

const SUPABASE_URL = "https://hfykngbhcxmnpxvjagoj.supabase.co";

describe("Supabase service role configuration", () => {
  it("accepts the configured server key for a read-only administrative request", async () => {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(serviceRoleKey, "SUPABASE_SERVICE_ROLE_KEY must be configured").toBeTruthy();

    const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1&page=1`, {
      headers: {
        apikey: serviceRoleKey!,
        Authorization: `Bearer ${serviceRoleKey!}`,
      },
    });

    expect(response.status, "Supabase service role key must authorize administrative reads").toBe(200);
  });
});
