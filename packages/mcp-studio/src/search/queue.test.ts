import { describe, expect, it } from "vitest";
import { SearchIndexError, type Embedder } from "./embedder";
import { EmbeddingQueue } from "./queue";
import { fakeEmbedder } from "./__tests__/fakes";

describe("EmbeddingQueue", () => {
  it("cuts texts into batches and keeps their order", async () => {
    const embedder = fakeEmbedder((text) => [Number(text)]);
    const queue = new EmbeddingQueue(embedder, 2);

    const vectors = await queue.documents(["1", "2", "3", "4", "5"]);

    expect(vectors.map((vector) => vector[0])).toEqual([1, 2, 3, 4, 5]);
    expect(embedder.calls).toEqual([
      { texts: ["1", "2"], purpose: "document" },
      { texts: ["3", "4"], purpose: "document" },
      { texts: ["5"], purpose: "document" },
    ]);
  });

  it("sends one batch at a time across callers", async () => {
    let open = 0;
    let most = 0;
    const embedder: Embedder = {
      key: "k".repeat(32),
      async embed(texts) {
        open += 1;
        most = Math.max(most, open);
        await new Promise((resolve) => setTimeout(resolve, 1));
        open -= 1;
        return texts.map(() => new Float32Array([1]));
      },
    };
    const queue = new EmbeddingQueue(embedder, 1);

    await Promise.all([queue.documents(["a", "b"]), queue.documents(["c", "d"]), queue.documents(["e"])]);

    expect(most).toBe(1);
  });

  it("fails only the caller whose batch failed", async () => {
    const embedder = fakeEmbedder((text) => {
      if (text === "bad") throw new SearchIndexError("unreachable", "The endpoint failed.");
      return [1];
    });
    const queue = new EmbeddingQueue(embedder);

    const failed = queue.documents(["bad"]);
    const next = queue.documents(["good"]);

    await expect(failed).rejects.toMatchObject({ code: "unreachable" });
    await expect(next).resolves.toHaveLength(1);
  });

  it("refuses a batch size below one", () => {
    expect(() => new EmbeddingQueue(fakeEmbedder(() => [1]), 0)).toThrow(RangeError);
  });
});
