// Only actual, readable web documents can become answer evidence.
export function webSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\u0000-\u0020\u007F\uFFFD]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
    return url.toString();
  } catch { return undefined; }
}

export function sourceText(value: unknown, max = 4000): string {
  const text = Array.isArray(value) ? value.map((item) => sourceText(item, max)).filter(Boolean).join(" ") : typeof value === "string" ? value : "";
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/u.test(text)) return "";
  const characters = Array.from(text);
  if (characters.some((character) => { const code = character.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; })) return "";
  return Array.from(text.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim()).slice(0, max).join("");
}

export function firstSourceText(values: unknown[], max = 4000): string {
  return values.map((value) => sourceText(value, max)).find(Boolean) || "";
}
