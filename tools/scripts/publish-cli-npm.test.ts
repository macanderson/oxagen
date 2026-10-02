import { describe, expect, it, vi } from "vitest";
import type { PublishOutcome } from "./lib/npm-cli";
import { main, type PublishCliDeps, VERIFY_TRIES } from "./publish-cli-npm";

function deps(over: Partial<PublishCliDeps> = {}) {
  const lines = { log: [] as string[], error: [] as string[] };
  const d: PublishCliDeps = {
    cliVersion: () => "2.1.4-3",
    publish: vi.fn(async (): Promise<PublishOutcome> => "published"),
    npxVersion: vi.fn(() => "2.1.4-3"),
    sleep: vi.fn(async () => {}),
    log: (line) => lines.log.push(line),
    error: (line) => lines.error.push(line),
    ...over,
  };
  return { d, lines };
}

describe("publish-cli-npm main", () => {
  it("asks for a version", async () => {
    const { d, lines } = deps();
    await expect(main(["--verify"], d)).resolves.toBe(2);
    expect(lines.error[0]).toMatch(/usage/);
    expect(d.publish).not.toHaveBeenCalled();
  });

  it("refuses a version the CLI manifest does not carry yet", async () => {
    const { d, lines } = deps({ cliVersion: () => "2.1.3" });
    await expect(main(["2.1.4-3"], d)).resolves.toBe(1);
    expect(lines.error[0]).toMatch(/says 2\.1\.3, not 2\.1\.4-3.*stamp 2\.1\.4-3/);
    expect(d.publish).not.toHaveBeenCalled();
  });

  it("fails when there is no token, rather than reporting a publish that did not happen", async () => {
    const { d, lines } = deps({ publish: async () => "no-token" });
    await expect(main(["2.1.4-3", "--verify"], d)).resolves.toBe(1);
    expect(lines.error[0]).toMatch(/NPM_TOKEN is not set/);
    expect(d.npxVersion).not.toHaveBeenCalled();
  });

  it("fails with the publish error", async () => {
    const { d, lines } = deps({
      publish: async () => {
        throw new Error("npm publish failed: E404");
      },
    });
    await expect(main(["2.1.4-3"], d)).resolves.toBe(1);
    expect(lines.error[0]).toBe("::error::npm publish failed: E404");
  });

  it("succeeds without verifying when npm already holds the version or newer", async () => {
    const { d } = deps({ publish: async () => "skipped" });
    await expect(main(["2.1.4-3", "--verify"], d)).resolves.toBe(0);
    expect(d.npxVersion).not.toHaveBeenCalled();
  });

  it("verifies only when asked", async () => {
    const { d } = deps();
    await expect(main(["2.1.4-3"], d)).resolves.toBe(0);
    expect(d.npxVersion).not.toHaveBeenCalled();
  });

  it("waits for the registry to serve the new version", async () => {
    const answers = ["E404 not found", "2.1.4-2", "2.1.4-3"];
    const { d, lines } = deps({
      npxVersion: vi.fn(() => {
        const next = answers.shift() ?? "";
        if (next.startsWith("E404")) throw new Error(`${next}\nmore detail`);
        return next;
      }),
    });
    await expect(main(["2.1.4-3", "--verify"], d)).resolves.toBe(0);
    expect(d.npxVersion).toHaveBeenCalledTimes(3);
    expect(d.npxVersion).toHaveBeenCalledWith(
      "https://registry.npmjs.org/@oxagen/cli/-/cli-2.1.4-3.tgz",
    );
    expect(d.sleep).toHaveBeenCalledTimes(2);
    expect(lines.log[0]).toBe(
      `npx https://registry.npmjs.org/@oxagen/cli/-/cli-2.1.4-3.tgz --version printed "E404 not found" (try 1 of ${VERIFY_TRIES})`,
    );
    expect(lines.log.at(-1)).toBe(
      "npx https://registry.npmjs.org/@oxagen/cli/-/cli-2.1.4-3.tgz --version prints 2.1.4-3",
    );
  });

  it("fails when the published CLI never reports its version", async () => {
    const { d, lines } = deps({ npxVersion: vi.fn(() => "2.1.3") });
    await expect(main(["2.1.4-3", "--verify"], d)).resolves.toBe(1);
    expect(d.npxVersion).toHaveBeenCalledTimes(VERIFY_TRIES);
    expect(d.sleep).toHaveBeenCalledTimes(VERIFY_TRIES - 1);
    expect(lines.error.at(-1)).toMatch(/never printed 2\.1\.4-3/);
  });
});
