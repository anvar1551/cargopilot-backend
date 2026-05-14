/** Common user projection reused in order read/write includes. */
export const userLiteSelect = { id: true, name: true, email: true, role: true };

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export function looksLikeOrderNumber(value: string) {
  return /^[0-9]{6,20}$/.test(value);
}

export function looksLikeParcelCode(value: string) {
  return /^[0-9]{6,20}-[0-9]+\/[0-9]+$/i.test(value);
}
