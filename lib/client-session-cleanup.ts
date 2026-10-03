import type { QueryClient } from "@tanstack/react-query";

import { clearLegacyDrafts, clearUserDrafts } from "@/lib/use-draft-storage";
import { studioSnapshotQueryKeyPrefix } from "@/lib/query-keys";

/**
 * Odstraní citlivé klientské artefakty předaného účtu. Supabase data se
 * tím nemazou; jde pouze o cache a lokálně uložené rozpracované texty.
 */
export async function clearUserClientData(queryClient: QueryClient, userId?: string | null) {
  try {
    await queryClient.cancelQueries({ queryKey: studioSnapshotQueryKeyPrefix });
  } catch {
    // Cache cleanup nesmí znemožnit dokončení odhlášení.
  }
  try {
    queryClient.removeQueries({ queryKey: studioSnapshotQueryKeyPrefix });
  } catch {
    // Query cache je best-effort; drafty se vyčistí níže.
  }
  if (userId) await clearUserDrafts(userId);
  await clearLegacyDrafts();
}
