import { describe, expect, it } from "vitest";
import { analyzeOffline, hasLiveModel } from "../server/lib/llm.js";
import { DEFAULT_SETTINGS } from "../server/lib/storage.js";

describe("llm helpers", () => {
  it("detects when a live model is configured", () => {
    expect(hasLiveModel(DEFAULT_SETTINGS)).toBe(false);
    expect(hasLiveModel({ ...DEFAULT_SETTINGS, provider: "ollama", baseUrl: "http://localhost:11434", model: "qwen" })).toBe(true);
    expect(hasLiveModel({ ...DEFAULT_SETTINGS, provider: "openai", apiKey: "key", baseUrl: "https://api.openai.com/v1", model: "gpt" })).toBe(true);
  });

  it("creates offline analysis without question mark garbage", () => {
    const result = analyzeOffline(
      "公司章程",
      "# 公司章程\n\n公司章程应当载明公司名称、住所、经营范围、注册资本和股东出资方式。"
    );
    expect(result.title).toBe("公司章程");
    expect(result.summary).toContain("公司章程");
    expect(result.questions.join("\n")).not.toContain("????");
  });
});
