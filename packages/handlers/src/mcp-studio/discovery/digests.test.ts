// digests.test.ts: Oxagen reads a registry package's digest the way the
// machine does (ADR-233, #4756), with a fake fetch.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { registryDigests } from "./digests";

const sha = (text: string) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

function answer(body: { json?: unknown; bytes?: string }, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body.json ?? {}),
    arrayBuffer: () =>
      Promise.resolve(new TextEncoder().encode(body.bytes ?? "").buffer),
  };
}

const TARBALL = "https://registry.npmjs.org/@acme/files-mcp/-/files-mcp-1.4.0.tgz";

describe("registryDigests", () => {
  it("hashes the tarball npm names for the version", async () => {
    const fetchFn = vi.fn((url: string) =>
      Promise.resolve(
        url === TARBALL
          ? answer({ bytes: "the 1.4.0 tarball" })
          : answer({ json: { dist: { tarball: TARBALL } } }),
      ),
    );
    const digest = await registryDigests(
      fetchFn as unknown as typeof fetch,
    ).digest(
      { name: "@acme/files-mcp", version: "1.4.0", registry_type: "npm" },
      { command: "npx", args: ["--yes", "@acme/files-mcp@1.4.0"] },
    );

    expect(digest).toBe(sha("the 1.4.0 tarball"));
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      "https://registry.npmjs.org/@acme%2Ffiles-mcp/1.4.0",
      TARBALL,
    ]);
  });

  it("reads no digest for a PyPI release, whose files differ by host (ADR-233)", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        answer({
          json: {
            urls: [
              { digests: { sha256: "c3".repeat(32) } },
              { digests: { sha256: "d4".repeat(32) } },
            ],
          },
        }),
      ),
    );
    const read = registryDigests(fetchFn as unknown as typeof fetch).digest(
      { name: "acme-files", version: "1.4.0", registry_type: "pypi" },
      { command: "uvx", args: ["acme-files==1.4.0"] },
    );

    await expect(read).rejects.toThrow(
      "acme-files@1.4.0 is a PyPI release, whose pin names one file the launch installs (ADR-233)",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects with the registry's answer, and names no local gateway", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(answer({}, 503)));
    const read = registryDigests(fetchFn as unknown as typeof fetch).digest(
      { name: "@acme/files-mcp", version: "1.4.0", registry_type: "npm" },
      { command: "npx", args: ["--yes", "@acme/files-mcp@1.4.0"] },
    );

    await expect(read).rejects.toThrow(
      "the registry answered 503 for https://registry.npmjs.org/@acme%2Ffiles-mcp/1.4.0",
    );
    await expect(read).rejects.not.toThrow(/local gateway/);
  });

  it("reads no executable on a machine", async () => {
    const fetchFn = vi.fn();
    const read = registryDigests(fetchFn as unknown as typeof fetch).digest(
      { name: "files-mcp", version: "2.0.0" },
      { command: "files-mcp", args: [] },
    );

    await expect(read).rejects.toThrow("files-mcp is not on this machine's PATH");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
