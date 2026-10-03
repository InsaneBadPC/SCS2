export const DRAFT_STORAGE_PREFIX = "songcraft-draft-";
export type DraftKind = "text" | "song";

/** Build a storage key that cannot be shared by two authenticated users or editors. */
export function draftKey(userId: string, id: string | null, kind: DraftKind = "text") {
  const encodedUser = encodeURIComponent(userId);
  const encodedEntity = encodeURIComponent(id ?? "new");
  return `${DRAFT_STORAGE_PREFIX}${encodedUser}:${kind}:${encodedEntity}`;
}

export function userDraftPrefix(userId: string) {
  return `${DRAFT_STORAGE_PREFIX}${encodeURIComponent(userId)}:`;
}

function isScopedDraftKey(key: string) {
  const parts = key.slice(DRAFT_STORAGE_PREFIX.length).split(":");
  return parts.length === 3 && (parts[1] === "text" || parts[1] === "song");
}

/** Keys written by the pre-user-scope format must never be restored. */
export function isLegacyDraftKey(key: string) {
  return key.startsWith(DRAFT_STORAGE_PREFIX) && !isScopedDraftKey(key);
}

export function isUserDraftKey(key: string, userId: string) {
  return key.startsWith(userDraftPrefix(userId));
}
