/** Bezpečně odliší URL, které lze předat nativnímu audio přehrávači. */
export function getPlayableAudioUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
