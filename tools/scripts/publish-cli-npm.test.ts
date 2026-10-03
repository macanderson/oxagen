import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CliCheck,
  type NpmRunner,
  type PublishOutcome,
  publishCliToNpm,
} from "./lib/npm-cli";
import {
  formatWait,
  main,
  npxFailure,
  type PublishCliDeps,
  VERIFY_WINDOW_MS,
  verifyPause,
} from "./publish-cli-npm";

const TARBALL = "https://registry.npmjs.org/@oxagen/cli/-/cli-2.1.4-3.tgz";

/** What npx's execFileSync throws when npm answers 404 for the tarball. */
function npx404(): Error {
  const stderr = `npm error code E404\nnpm error 404 Not Found - GET ${TARBALL}\nnpm error A complete log of this run can be found in: /tmp/log\n`;
  return Object.assign(
    new Error(`Command failed: npx --yes ${TARBALL} --version\n${stderr}`),
    { stderr },
  );
}

/**
 * Stand-ins for everything `main` touches. The clock moves only when the code
 * sleeps or a test moves it, so a ten-minute wait runs at once.
 */
function deps(over: Partial<PublishCliDeps> = {}) {
  const lines = { log: [] as string[], error: [] as string[] };
  const clock = { ms: 0 };
  const sleep = vi.fn(async (ms: number) => {
    clock.ms += ms;
  });
  const d: PublishCliDeps = {
    cliVersion: () => "2.1.4-3",
    // Stands in for publishCliToNpm: it runs the check it is given.
    publish: vi.fn(
      async (version: string, check?: CliCheck): Promise<PublishOutcome> => {
        if (check && !(await check(version)))
          throw new Error(`${version} failed the check`);
        return "published";
      },
    ),
    npxVersion: vi.fn(() => "2.1.4-3"),
    now: () => clock.ms,
    sleep,
    log: (line) => lines.log.push(line),
    error: (line) => lines.error.push(line),
    ...over,
  };
  return { d, lines, clock, sleep };
}

/**
 * A registry for the real publishCliToNpm: `npm view` answers the versions
 * and tags, `npm publish` adds `version` under the tag it names, and
 * `npm dist-tag add` moves a tag.
 */
function fakeRegistry(versions: string[], latest: string, version: string) {
  const state = {
    versions: [...versions],
    tags: { latest } as Record<string, string>,
  };
  const calls: string[][] = [];
  const npm: NpmRunner = (args) => {
    calls.push(args);
    switch (args[0]) {
      case "view":
        return JSON.stringify({
          versions: state.versions,
          "dist-tags": state.tags,
        });
      case "publish": {
        const tag = args[args.indexOf("--tag") + 1] ?? "latest";
        state.versions.push(version);
        state.tags[tag] = version;
        return "";
      }
      case "dist-tag": {
        const spec = args[2] ?? "";
        state.tags[args[3] ?? ""] = spec.slice(spec.lastIndexOf("@") + 1);
        return "";
      }
      default:
        throw new Error(`unexpected npm ${args.join(" ")}`);
    }
  };
  return { npm, state, calls };
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
    expect(lines.error[0]).toMatch(
      /says 2\.1\.3, not 2\.1\.4-3.*stamp 2\.1\.4-3/,
    );
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

  it("succeeds without a check when the publish leaves latest alone", async () => {
    const { d } = deps({ publish: async () => "skipped" });
    await expect(main(["2.1.4-3", "--verify"], d)).resolves.toBe(0);
    expect(d.npxVersion).not.toHaveBeenCalled();
  });

  it("checks only when asked", async () => {
    const { d } = deps();
    await expect(main(["2.1.4-3"], d)).resolves.toBe(0);
    expect(d.publish).toHaveBeenCalledWith("2.1.4-3", undefined);
    expect(d.npxVersion).not.toHaveBeenCalled();
  });

  it("checks the version's tarball URL and logs how long it waited", async () => {
    const answers = ["2.1.4-2", "2.1.4-3"];
    const { d, lines } = deps({
      npxVersion: vi.fn(() => answers.shift() ?? ""),
    });
    await expect(main(["2.1.4-3", "--verify"], d)).resolves.toBe(0);
    expect(d.npxVersion).toHaveBeenCalledWith(TARBALL);
    expect(lines.log).toEqual([
      `npx ${TARBALL} --version printed "2.1.4-2" after 0s (try 1)`,
      `npx ${TARBALL} --version printed 2.1.4-3 after 20s (try 2)`,
    ]);
  });

  it("fails when the published CLI never reports its version", async () => {
    const { d, lines, clock } = deps({ npxVersion: vi.fn(() => "2.1.3") });
    await expect(main(["2.1.4-3", "--verify"], d)).resolves.toBe(1);
    expect(clock.ms).toBeGreaterThanOrEqual(VERIFY_WINDOW_MS);
    expect(lines.log.at(-1)).toMatch(
      /never printed 2\.1\.4-3\. It waited 10m 0s over \d+ tries\./,
    );
    expect(lines.error.at(-1)).toBe("::error::2.1.4-3 failed the check");
  });
});

describe("publish-cli-npm with the registry", () => {
  beforeEach(() => {
    vi.stubEnv("NPM_TOKEN", "npm_test_token_value");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * main wired to the real publishCliToNpm and a fake registry. `npx` stands
   * in for one npx run and sees the clock and the registry's tags.
   */
  function wired(
    npx: (now: {
      clock: { ms: number };
      tags: Record<string, string>;
    }) => string,
  ) {
    const reg = fakeRegistry(["2.1.3", "2.1.4-2"], "2.1.4-2", "2.1.4-3");
    const t = deps();
    t.d.npxVersion = vi.fn(() =>
      npx({ clock: t.clock, tags: reg.state.tags }),
    );
    t.d.publish = vi.fn((version: string, check?: CliCheck) =>
      publishCliToNpm(version, {
        npm: reg.npm,
        build: () => {},
        readManifest: () => ({
          name: "@oxagen/cli",
          version,
          bin: { oxagen: "oxagen.mjs" },
          dependencies: {},
        }),
        log: () => {},
        ...(check ? { check } : {}),
      }),
    );
    return { ...t, reg };
  }

  it("moves latest only after a tarball that answers 404 for minutes starts to work", async () => {
    // npm served 2.1.4-378's tarball about 5½ minutes after the publish.
    const servedAt = 330_000;
    const latestDuringCheck: string[] = [];
    const t = wired(({ clock, tags }) => {
      clock.ms += 5_000; // one npx run
      latestDuringCheck.push(tags.latest ?? "");
      if (clock.ms < servedAt) throw npx404();
      return "2.1.4-3";
    });

    await expect(main(["2.1.4-3", "--verify"], t.d)).resolves.toBe(0);

    const publish = t.reg.calls.find((c) => c[0] === "publish");
    expect(publish?.slice(0, 3)).toEqual(["publish", "--tag", "candidate"]);
    expect(new Set(latestDuringCheck)).toEqual(new Set(["2.1.4-2"]));
    expect(t.reg.state.tags).toEqual({
      latest: "2.1.4-3",
      candidate: "2.1.4-3",
    });
    expect(t.sleep.mock.calls.map(([ms]) => ms)).toEqual([
      20_000, 30_000, 40_000, 50_000, 60_000, 60_000, 60_000,
    ]);
    expect(t.lines.log[0]).toBe(
      `npx ${TARBALL} --version printed "npm error 404 Not Found - GET ${TARBALL}" after 5s (try 1)`,
    );
    expect(t.lines.log.at(-1)).toBe(
      `npx ${TARBALL} --version printed 2.1.4-3 after 6m 0s (try 8)`,
    );
    expect(t.lines.error).toEqual([]);
  });

  it("leaves latest where it was when the tarball never works", async () => {
    const t = wired(({ clock }) => {
      clock.ms += 5_000;
      throw npx404();
    });

    await expect(main(["2.1.4-3", "--verify"], t.d)).resolves.toBe(1);

    expect(t.reg.calls.some((c) => c[0] === "dist-tag")).toBe(false);
    expect(t.reg.state.tags).toEqual({
      latest: "2.1.4-2",
      candidate: "2.1.4-3",
    });
    expect(t.lines.log.at(-1)).toBe(
      `npx ${TARBALL} --version never printed 2.1.4-3. It waited 10m 5s over 12 tries.`,
    );
    expect(t.lines.error).toHaveLength(1);
    expect(t.lines.error[0]).toMatch(
      /^::error::@oxagen\/cli@2\.1\.4-3 is on npm, but it failed the check, so latest still names 2\.1\.4-2/,
    );
    expect(t.lines.error[0]).toContain(
      "npm dist-tag add @oxagen/cli@2.1.4-3 latest",
    );
  });
});

describe("verifyPause", () => {
  it("starts at 20 seconds and grows to a minute", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(verifyPause)).toEqual([
      20_000, 30_000, 40_000, 50_000, 60_000, 60_000, 60_000,
    ]);
  });
});

describe("formatWait", () => {
  it("writes seconds, then minutes and seconds", () => {
    expect(formatWait(0)).toBe("0s");
    expect(formatWait(45_400)).toBe("45s");
    expect(formatWait(340_000)).toBe("5m 40s");
    expect(formatWait(VERIFY_WINDOW_MS)).toBe("10m 0s");
  });
});

describe("npxFailure", () => {
  it("names npm's reason from stderr, not the command or the error code", () => {
    expect(npxFailure(npx404())).toBe(`npm error 404 Not Found - GET ${TARBALL}`);
  });

  it("reads the lines after the command when the error carries no stderr", () => {
    expect(
      npxFailure(
        new Error("Command failed: npx --yes x --version\nTypeError: boom"),
      ),
    ).toBe("TypeError: boom");
  });

  it("falls back to the message of a one-line error", () => {
    expect(npxFailure(new Error("spawnSync npx ETIMEDOUT"))).toBe(
      "spawnSync npx ETIMEDOUT",
    );
    expect(npxFailure("not an error")).toBe("not an error");
  });
});
