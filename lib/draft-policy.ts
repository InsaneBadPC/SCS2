/** Rozhodnutí mezi serverovou verzí a lokálním draftem. */
export function shouldRestoreDraft(serverUpdatedAt: number | Date | string | null | undefined, draftSavedAt: number) {
  if (serverUpdatedAt === null || serverUpdatedAt === undefined) return true;
  const serverTime = serverUpdatedAt instanceof Date ? serverUpdatedAt.getTime() : new Date(serverUpdatedAt).getTime();
  // Invalid server timestamps must not make a valid local draft disappear.
  return !Number.isFinite(serverTime) || serverTime < draftSavedAt;
}
