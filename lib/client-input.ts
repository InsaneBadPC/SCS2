/** Zachová null jako explicitní „bez alba“ a undefined jako „pole neměnit“. */
export function normalizeOptionalId(value: string | number | null | undefined) {
  return value === null || value === undefined ? value : String(value);
}
