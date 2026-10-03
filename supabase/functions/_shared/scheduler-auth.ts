// Explicitní autorizace pro plánované (scheduler) Edge funkce.
//
// Proč: youtube-sync-stats dřív přijímal volání z internetu a dělal dotaz přes service role
// na všechny youtube_credentials. Bez ní se dalo (a) spustit cizí sync, (b) přepsat cizí userId
// v těle požadavku a (c) vynutit libovolný počet drahých volání na YouTube Analytics.
//
// Hierarchie autorizace (první vyhrazená):
//   1. service role v hlavičce Authorization  -> scheduler, smí syncovat všechny účty,
//   2. x-cron-secret shodný s SYNC_STATS_CRON_SECRET (nebo SONGCRAFT_*) -> scheduler,
//   3. JWT s podepsaným claimem role=service_role -> scheduler,
//   4. platný uživatelský JWT -> jen vlastní účet, cizí userId v těle se odmítne (403),
//   5. jinak 401.
//
// Claim se nikdy nebere z neověřeného rozparsování tokenu: caller si ho ověřuje proti
// JWKS (auth.getClaims) a do helperu se předává až jako booleanozna hodnota.
// Porovnání tajných hodnot je constant-time (bez předčasného ukončení v porovnání).
// Modul je záměrně bez importů, aby se dal testovat v Node/vitest bez Deno runtime.

export type SchedulerEnv = {
  url?: string;
  anonKey?: string;
  serviceRoleKey?: string;
  cronSecret?: string;
};

export type CallerScope = { role: "scheduler" } | { role: "user"; userId: string };

export type CallerResult = { ok: true; scope: CallerScope } | { ok: false; status: number; error: string };

export type BearerVerifier = {
  user: (bearer: string) => Promise<string | null>;
  serviceRoleClaim?: (bearer: string) => Promise<boolean>;
};

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

export function constantTimeEquals(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

function bearerToken(request: Request): string {
  return (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

/**
 * Rozhodne, kdo smí volat funkci. `verify.user` ověřuje uživatelský JWT proti auth serveru
 * (volající předá createClient(url, anonKey).auth.getUser()) a vrací user.id, nebo null.
 * `verify.serviceRoleClaim` volající předá jako getClaims(bearer).claims?.role === "service_role".
 */
export async function resolveCallerScope(request: Request, env: SchedulerEnv, verify: BearerVerifier): Promise<CallerResult> {
  const bearer = bearerToken(request);
  if (env.serviceRoleKey && bearer && constantTimeEquals(bearer, env.serviceRoleKey)) return { ok: true, scope: { role: "scheduler" } };
  const presented = (request.headers.get("x-cron-secret") ?? "").trim();
  if (env.cronSecret && presented && constantTimeEquals(presented, env.cronSecret)) return { ok: true, scope: { role: "scheduler" } };
  if (!bearer) return { ok: false, status: 401, error: "Chybí autorizace. Použij service role key, x-cron-secret, nebo přihlášený účet." };
  if (verify.serviceRoleClaim) {
    const isScheduler = await verify.serviceRoleClaim(bearer).catch(() => false);
    if (isScheduler) return { ok: true, scope: { role: "scheduler" } };
  }
  if (!env.url || !env.anonKey) return { ok: false, status: 503, error: "Chybí konfigurace ověření přihlášení." };
  const userId = await verify.user(bearer).catch(() => null);
  if (!userId) return { ok: false, status: 401, error: "Neplatné přihlášení." };
  return { ok: true, scope: { role: "user", userId } };
}

/**
 * userId z těla požadavku: scheduler ho smí použít (musí být UUID), přihlášený uživatel
 * smí jen ten vlastní. Cokoliv jiného je 400/403, ne tiše ignorovaný přesun scope.
 */
export function resolveTargetUserId(
  scope: CallerScope,
  requested: unknown,
): { ok: true; userId: string | null } | { ok: false; status: number; error: string } {
  if (requested === undefined || requested === null || requested === "") return { ok: true, userId: null };
  if (!isUuid(requested)) return { ok: false, status: 400, error: "userId musí být platné UUID." };
  const normalized = requested.trim();
  if (scope.role === "user" && normalized !== scope.userId) return { ok: false, status: 403, error: "Nemůžeš synkovat cizí účet." };
  return { ok: true, userId: normalized };
}
