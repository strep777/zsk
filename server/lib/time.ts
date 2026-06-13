export function nowIso(): string {
  return new Date().toISOString();
}

export function compactDate(value = new Date()): string {
  return value.toISOString().slice(0, 10);
}
