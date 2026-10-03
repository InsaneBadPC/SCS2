export function firstQueryParam(value: string | string[] | null | undefined) {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() || null;
}
