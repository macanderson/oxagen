import { describe, expect, it } from "vitest";
import { OXAGEN_EMBEDDING_MODEL, VOYAGE_EMBEDDINGS_URL, embeddingTarget, targetKey } from "./settings";

describe("embeddingTarget", () => {
  const oxagen = {
    provider: "oxagen",
    url: VOYAGE_EMBEDDINGS_URL,
    model: OXAGEN_EMBEDDING_MODEL,
    key: targetKey("oxagen", VOYAGE_EMBEDDINGS_URL, OXAGEN_EMBEDDING_MODEL),
  };

  it("uses the oxagen default when nothing is stored", () => {
    expect(embeddingTarget(undefined)).toEqual(oxagen);
    expect(embeddingTarget(null)).toEqual(oxagen);
    expect(embeddingTarget({})).toEqual(oxagen);
    expect(embeddingTarget({ provider: "oxagen" })).toEqual(oxagen);
  });

  it("sends nothing for keyword", () => {
    expect(embeddingTarget({ provider: "keyword" })).toEqual({ provider: "keyword", invalid: false });
  });

  it("names a custom endpoint, model, and credential", () => {
    const target = embeddingTarget({
      provider: "custom",
      url: "https://embed.example.com/v1/embeddings",
      model: "e5-large",
      credential: "oxagen:credential/embed-key",
    });
    expect(target).toEqual({
      provider: "custom",
      url: "https://embed.example.com/v1/embeddings",
      model: "e5-large",
      credential: "oxagen:credential/embed-key",
      key: targetKey("custom", "https://embed.example.com/v1/embeddings", "e5-large"),
    });
  });

  it("takes no credential for an endpoint without a key", () => {
    const target = embeddingTarget({ provider: "custom", url: "https://embed.example.com/", model: "e5" });
    expect(target).toMatchObject({ provider: "custom", credential: null });
  });

  it("ranks by keyword when the stored value does not read", () => {
    expect(embeddingTarget({ provider: "custom" })).toEqual({ provider: "keyword", invalid: true });
    expect(embeddingTarget({ provider: "keyword", url: "https://embed.example.com/" })).toEqual({
      provider: "keyword",
      invalid: true,
    });
    expect(embeddingTarget("oxagen")).toEqual({ provider: "keyword", invalid: true });
  });

  it("gives a new key for a new model or endpoint", () => {
    const base = targetKey("custom", "https://a.example.com/", "m1");
    expect(base).toMatch(/^[0-9a-f]{32}$/);
    expect(targetKey("custom", "https://a.example.com/", "m2")).not.toBe(base);
    expect(targetKey("custom", "https://b.example.com/", "m1")).not.toBe(base);
    expect(targetKey("oxagen", "https://a.example.com/", "m1")).not.toBe(base);
  });
});
