/**
 * createOnnxEmbeddingClient / isOnnxAvailable tests. The `fastembed` module is
 * always injected via `loader` (never the real dynamic import), so this file
 * never downloads a model or touches the network, and passes identically
 * whether or not `fastembed`'s native binding is actually installed on the
 * machine running the suite.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOnnxEmbeddingClient,
  isOnnxAvailable,
  ONNX_PROVIDER_PREFIX,
} from "../embedding-onnx.js";

/** A minimal fake shaped exactly like the real `fastembed` module's public surface. */
function fakeFastEmbedModule(
  overrides: { init?: ReturnType<typeof vi.fn> } = {},
) {
  const instance = {
    queryEmbed: vi.fn(async (text: string) => [text.length, 0, 0]),
    passageEmbed: vi.fn(async function* (texts: string[]) {
      // Yield in two batches to prove the client drains + flattens in order.
      yield texts.slice(0, 1).map((t) => [t.length, 1, 1]);
      if (texts.length > 1) yield texts.slice(1).map((t) => [t.length, 1, 1]);
    }),
    listSupportedModels: vi.fn(() => [
      { model: "fast-bge-small-en-v1.5", dim: 384 },
    ]),
  };
  const init = overrides.init ?? vi.fn(async () => instance);
  return {
    module: {
      EmbeddingModel: { BGESmallENV15: "fast-bge-small-en-v1.5" },
      FlagEmbedding: { init },
    },
    instance,
    init,
  };
}

// Every temp dir a test makes is registered here so afterEach removes ALL of
// them — a single `let` binding silently leaked the dirs made after the last
// assignment (and the parent of a nested cacheDir) into /tmp on every run.
let tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oxagen-onnx-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("isOnnxAvailable", () => {
  it("true when the loader resolves a well-shaped fastembed module", async () => {
    const { module } = fakeFastEmbedModule();
    await expect(isOnnxAvailable(async () => module)).resolves.toBe(true);
  });

  it("false when the loader throws (package not installed)", async () => {
    await expect(
      isOnnxAvailable(async () => {
        throw new Error("Cannot find package 'fastembed'");
      }),
    ).resolves.toBe(false);
  });

  it("false when the loader resolves something not shaped like fastembed", async () => {
    await expect(isOnnxAvailable(async () => ({ nope: true }))).resolves.toBe(
      false,
    );
  });

  it("false when the loader resolves null", async () => {
    await expect(isOnnxAvailable(async () => null)).resolves.toBe(false);
  });
});

describe("createOnnxEmbeddingClient", () => {
  it("returns null when the loader throws (package absent / native binding failed)", async () => {
    const loader = async () => {
      throw new Error("native binding load failed");
    };
    await expect(createOnnxEmbeddingClient({ loader })).resolves.toBeNull();
  });

  it("returns null when the resolved module isn't fastembed-shaped", async () => {
    await expect(
      createOnnxEmbeddingClient({ loader: async () => ({}) }),
    ).resolves.toBeNull();
  });

  it("returns null when FlagEmbedding.init throws (e.g. offline on first download)", async () => {
    const init = vi.fn(async () => {
      throw new Error("ENOTFOUND huggingface.co");
    });
    const { module } = fakeFastEmbedModule({ init });
    await expect(
      createOnnxEmbeddingClient({ loader: async () => module }),
    ).resolves.toBeNull();
  });

  it("builds a working client with providerId local-onnx:bge-small-en-v1.5 and dim from listSupportedModels()", async () => {
    const cacheDir = makeTmpDir();
    const { module, init } = fakeFastEmbedModule();
    const client = await createOnnxEmbeddingClient({
      loader: async () => module,
      cacheDir,
    });

    expect(client).not.toBeNull();
    expect(client?.providerId).toBe(`${ONNX_PROVIDER_PREFIX}bge-small-en-v1.5`);
    expect(client?.providerId).toBe("local-onnx:bge-small-en-v1.5");
    expect(client?.dimensions).toBe(384);

    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({ model: "fast-bge-small-en-v1.5", cacheDir }),
    );
  });

  it("creates the cache dir before loading the model", async () => {
    const cacheDir = join(makeTmpDir(), "nested", "cache");
    expect(existsSync(cacheDir)).toBe(false);
    const { module } = fakeFastEmbedModule();
    await createOnnxEmbeddingClient({ loader: async () => module, cacheDir });
    expect(existsSync(cacheDir)).toBe(true);
  });

  it("embed() delegates to queryEmbed()", async () => {
    const { module, instance } = fakeFastEmbedModule();
    const client = await createOnnxEmbeddingClient({
      loader: async () => module,
      cacheDir: makeTmpDir(),
    });
    await expect(client?.embed("hello")).resolves.toEqual([5, 0, 0]);
    expect(instance.queryEmbed).toHaveBeenCalledWith("hello");
  });

  it("embedBatch() drains passageEmbed()'s async generator and flattens in order", async () => {
    const { module } = fakeFastEmbedModule();
    const client = await createOnnxEmbeddingClient({
      loader: async () => module,
      cacheDir: makeTmpDir(),
    });
    await expect(client?.embedBatch(["aa", "bbb", "c"])).resolves.toEqual([
      [2, 1, 1],
      [3, 1, 1],
      [1, 1, 1],
    ]);
  });

  it("embedBatch([]) short-circuits without calling passageEmbed", async () => {
    const { module, instance } = fakeFastEmbedModule();
    const client = await createOnnxEmbeddingClient({
      loader: async () => module,
      cacheDir: makeTmpDir(),
    });
    await expect(client?.embedBatch([])).resolves.toEqual([]);
    expect(instance.passageEmbed).not.toHaveBeenCalled();
  });

  it("returns null when the model key is missing from EmbeddingModel", async () => {
    const module = { EmbeddingModel: {}, FlagEmbedding: { init: vi.fn() } };
    await expect(
      createOnnxEmbeddingClient({ loader: async () => module }),
    ).resolves.toBeNull();
  });
});
