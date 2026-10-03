export type PrivateUser = { id?: string; email?: string | null };
export type AccessEnv = { allowedUserIds?: string; allowedEmails?: string };

function values(value: string | undefined) {
  return new Set((value ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean));
}

/**
 * Production auth is intentionally fail-closed: an Edge Function must be
 * configured with immutable user IDs or normalized emails before it can serve
 * private studio data. Local development can opt in explicitly with
 * SONGCRAFT_ALLOW_ALL_AUTHENTICATED=true, but that flag is never read here.
 */
export function isAllowedPrivateUser(user: PrivateUser | null | undefined, env: AccessEnv) {
  if (!user?.id) return false;
  const ids = values(env.allowedUserIds);
  const emails = values(env.allowedEmails);
  if (ids.size === 0 && emails.size === 0) return false;
  if (ids.has(user.id.toLowerCase())) return true;
  return Boolean(user.email && emails.has(user.email.toLowerCase()));
}

export function privateAccessMessage() {
  return "Účet není v produkčním allowlistu SongCraft Studia.";
}
