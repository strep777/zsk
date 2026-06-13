import { ProjectSettings, ProviderKind } from "../types.js";

export const PROVIDER_KINDS: ProviderKind[] = [
  "offline",
  "openai",
  "volcengine",
  "volcengine-coding-plan",
  "ollama",
  "anthropic",
  "gemini",
  "custom"
];

export const PROVIDER_DEFAULTS: Record<ProviderKind, Pick<ProjectSettings, "baseUrl" | "model">> = {
  offline: {
    baseUrl: "",
    model: ""
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini"
  },
  volcengine: {
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-2-0-lite-260215"
  },
  "volcengine-coding-plan": {
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    model: "ark-code-latest"
  },
  ollama: {
    baseUrl: "http://localhost:11434",
    model: "qwen2.5:7b"
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    model: "claude-3-5-sonnet-latest"
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-1.5-pro"
  },
  custom: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini"
  }
};

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && PROVIDER_KINDS.includes(value as ProviderKind);
}

export function envApiKeyFor(provider: ProviderKind): string | undefined {
  if (provider === "volcengine" || provider === "volcengine-coding-plan") {
    return process.env.VOLCENGINE_API_KEY || process.env.ARK_API_KEY;
  }
  if (provider === "openai") return process.env.OPENAI_API_KEY;
  if (provider === "custom") return process.env.CUSTOM_API_KEY || process.env.OPENAI_API_KEY;
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  if (provider === "gemini") return process.env.GEMINI_API_KEY;
  return undefined;
}

export function envBaseUrlFor(provider: ProviderKind): string | undefined {
  if (provider === "openai") return process.env.OPENAI_BASE_URL;
  if (provider === "volcengine") return process.env.VOLCENGINE_BASE_URL || process.env.ARK_BASE_URL;
  if (provider === "volcengine-coding-plan") {
    return process.env.VOLCENGINE_CODING_BASE_URL || process.env.ARK_CODING_BASE_URL;
  }
  if (provider === "ollama") return process.env.OLLAMA_BASE_URL;
  if (provider === "anthropic") return process.env.ANTHROPIC_BASE_URL;
  if (provider === "gemini") return process.env.GEMINI_BASE_URL;
  if (provider === "custom") return process.env.CUSTOM_BASE_URL || process.env.OPENAI_BASE_URL;
  return undefined;
}

export function envModelFor(provider: ProviderKind): string | undefined {
  if (provider === "openai") return process.env.OPENAI_MODEL;
  if (provider === "volcengine") return process.env.VOLCENGINE_MODEL || process.env.ARK_MODEL;
  if (provider === "volcengine-coding-plan") {
    return process.env.VOLCENGINE_CODING_MODEL || process.env.ARK_CODING_MODEL;
  }
  if (provider === "ollama") return process.env.OLLAMA_MODEL;
  if (provider === "anthropic") return process.env.ANTHROPIC_MODEL;
  if (provider === "gemini") return process.env.GEMINI_MODEL;
  if (provider === "custom") return process.env.CUSTOM_MODEL || process.env.OPENAI_MODEL;
  return undefined;
}

export function providerDefaults(provider: ProviderKind): Pick<ProjectSettings, "baseUrl" | "model"> {
  return PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.custom;
}
