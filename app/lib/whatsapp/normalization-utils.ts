export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

export function normalizeOccurredAt(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const numericValue = typeof value === "number" || /^\d+$/.test(value) ? Number(value) * 1000 : NaN;
  const date = Number.isFinite(numericValue) ? new Date(numericValue) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
