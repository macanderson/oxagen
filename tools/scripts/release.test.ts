import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertCleanTree,
  completeViaGateway,
  formatWrittenList,
  GATEWAY_TIMEOUT_MS,
  parseWrittenList,
  releaseFilesToStage,
} from "./release";

const ROOT = "/repo";

describe("assertCleanTree", () => {
  it("passes on an empty status", () => {
    expect(() => assertCleanTree("")).not.toThrow();
    expect(() => assertCleanTree("\n")).not.toThrow();
  });

  it("throws on a modified tracked file and names it", () => {
    expect(() => assertCleanTree(" M foo\n")).toThrow(/uncommitted changes/);
    expect(() => assertCleanTree(" M foo\n")).toThrow(/\n {2}foo$/);
  });

  it("throws on an untracked file and names it", () => {
    expect(() => assertCleanTree("?? secret.env\n")).toThrow(/secret\.env/);
  });

  it("names every dirty path, staged ones included", () => {
    let message = "";
    try {
      assertCleanTree("M  staged.ts\n M edited.ts\n?? secret.env\n");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("  staged.ts");
    expect(message).toContain("  edited.ts");
    expect(message).toContain("  secret.env");
  });
});

describe("releaseFilesToStage", () => {
  it("stages exactly the files the release wrote, relative to the root", () => {
    const staged = releaseFilesToStage(ROOT, [
      "package.json",
      "apps/cli/package.json",
      `${ROOT}/releases/v1.2.3.md`,
      `${ROOT}/CHANGELOG.md`,
      `${ROOT}/apps/docs/content/docs/releases/v1.2.3.mdx`,
      `${ROOT}/apps/docs/content/docs/releases/meta.json`,
    ]);
    expect(staged).toEqual([
      "package.json",
      "apps/cli/package.json",
      "releases/v1.2.3.md",
      "CHANGELOG.md",
      "apps/docs/content/docs/releases/v1.2.3.mdx",
      "apps/docs/content/docs/releases/meta.json",
    ]);
  });

  it("never includes a file the release did not write", () => {
    const staged = releaseFilesToStage(`${ROOT}/`, [
      "package.json",
      `${ROOT}/CHANGELOG.md`,
    ]);
    expect(staged).not.toContain("secret.env");
    expect(staged).not.toContain(".");
    expect(staged).not.toContain("-A");
    expect(staged).toEqual(["package.json", "CHANGELOG.md"]);
  });

  it("lists each path once", () => {
    expect(
      releaseFilesToStage(ROOT, ["package.json", `${ROOT}/package.json`]),
    ).toEqual(["package.json"]);
  });
});

describe("--written-list", () => {
  // release-publish.ts and release.yml commit with --no-git and stage only
  // the paths in this list, so the list must round-trip exactly.
  it("round-trips the files the release wrote, relative to the root", () => {
    const text = formatWrittenList(ROOT, [
      "package.json",
      `${ROOT}/releases/v1.2.3.md`,
      `${ROOT}/package.json`,
    ]);
    expect(text).toBe("package.json\nreleases/v1.2.3.md\n");
    expect(parseWrittenList(text)).toEqual([
      "package.json",
      "releases/v1.2.3.md",
    ]);
  });

  it("reads an empty list as no files", () => {
    expect(parseWrittenList(formatWrittenList(ROOT, []))).toEqual([]);
  });

  it("refuses a path that would split into two entries", () => {
    expect(() => formatWrittenList(ROOT, ["a\nsecret.env"])).toThrow(/newline/);
  });
});

describe("completeViaGateway", () => {
  const messages = [{ role: "user" as const, content: "notes" }];
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.AI_GATEWAY_API_KEY;
    process.env.AI_GATEWAY_API_KEY = "test-key";
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = savedKey;
    vi.unstubAllGlobals();
  });

  /** A gateway that accepts the request and never answers until aborted. */
  function stubHungGateway() {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("aborts a hung gateway call with a TimeoutError", async () => {
    stubHungGateway();
    await expect(completeViaGateway(messages, 20)).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("sends a timeout signal on the default call", () => {
    const fetchMock = stubHungGateway();
    void completeViaGateway(messages).catch(() => {});
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
    expect(GATEWAY_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("returns null without calling the gateway when no key is set", async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    const fetchMock = stubHungGateway();
    await expect(completeViaGateway(messages)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
