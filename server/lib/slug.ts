import crypto from "node:crypto";

export function slugify(input: string, fallback = "untitled"): string {
  const cleaned = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  if (cleaned) return cleaned;
  return `${fallback}-${hashText(input).slice(0, 8)}`;
}

export function hashText(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function idFrom(input: string): string {
  return `${slugify(input)}-${hashText(`${input}-${Date.now()}`).slice(0, 8)}`;
}

export function fileBaseName(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}
