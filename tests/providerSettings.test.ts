import { describe, expect, it } from "vitest";
import {
  PROVIDER_KINDS,
  envApiKeyFor,
  envBaseUrlFor,
  envModelFor,
  isProviderKind,
  providerDefaults
} from "../server/lib/providerSettings.js";

describe("provider settings", () => {
  it("recognizes supported providers", () => {
    expect(PROVIDER_KINDS).toContain("offline");
    expect(isProviderKind("openai")).toBe(true);
    expect(isProviderKind("unknown")).toBe(false);
  });

  it("returns built-in defaults", () => {
    expect(providerDefaults("volcengine").baseUrl).toContain("volces.com");
    expect(providerDefaults("custom").model).toBe("gpt-4o-mini");
  });

  it("reads provider environment overrides", () => {
    process.env.OPENAI_API_KEY = "test-openai";
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.OPENAI_MODEL = "model-x";
    expect(envApiKeyFor("openai")).toBe("test-openai");
    expect(envBaseUrlFor("openai")).toBe("https://example.test/v1");
    expect(envModelFor("openai")).toBe("model-x");
  });
});
