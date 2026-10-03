/** Stable query-key helpers for the authenticated studio client. */
export const studioSnapshotQueryKeyPrefix = ["songcraft", "supabase", "snapshot"] as const;

/**
 * Snapshot data belongs to exactly one Supabase user. Keeping the user id in
 * the key prevents a cached response from being shown after an account switch.
 */
export function studioSnapshotQueryKey(userId: string | null | undefined) {
  return [...studioSnapshotQueryKeyPrefix, userId ?? "anonymous"] as const;
}
