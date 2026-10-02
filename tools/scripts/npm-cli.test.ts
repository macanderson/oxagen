import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  latestCorrection,
  manifestProblem,
  type NpmRunner,
  parseRegistryState,
  planPublish,
  type PublishDeps,
  publishCliToNpm,
} from "./lib/npm-cli";

const TOKEN = "npm_test_token_value";

describe("parseRegistryState", () => {
  it("reads the versions and the latest tag", () => {
    expect(
      parseRegistryState(
        JSON.stringify({
          versions: ["1.0.0", "1.0.1"],
          "dist-tags": { latest: "1.0.1" },
        }),
      ),
    ).toEqual({ versions: ["1.0.0", "1.0.1"], latest: "1.0.1" });
  });

  it("reads a lone version, which npm prints as a string", () => {
    expect(
      parseRegistryState(
        JSON.stringify({ versions: "1.0.0", "dist-tags": { latest: "1.0.0" } }),
      ),
    ).toEqual({ versions: ["1.0.0"], latest: "1.0.0" });
  });

  it("answers no latest when the package has no tags", () => {
    expect(parseRegistryState("{}")).toEqual({ versions: [], latest: null });
  });
});

describe("planPublish", () => {
  const state = { versions: ["1.0.1", "2.1.3", "2.1.4-5"], latest: "2.1.4-5" };

  it("publishes a version newer than everything on npm", () => {
    expect(planPublish(state, "2.1.4-6")).toEqual({ publish: true });
    expect(planPublish(state, "2.1.4")).toEqual({ publish: true });
    expect(planPublish({ versions: [], latest: null }, "2.1.4-1")).toEqual({
      publish: true,
    });
  });

  it("skips a version npm already holds", () => {
    expect(planPublish(state, "2.1.3")).toEqual({
      publish: false,
      reason: "@oxagen/cli@2.1.3 is already on npm",
    });
  });

  it("skips a version older than the newest on npm", () => {
    expect(planPublish(state, "2.1.4-2")).toEqual({
      publish: false,
      reason: "npm already holds 2.1.4-5, which is newer than 2.1.4-2",
    });
  });
});

describe("latestCorrection", () => {
  it("answers null when latest names the newest version", () => {
    expect(
      latestCorrection({ versions: ["2.1.3", "2.1.4-1"], latest: "2.1.4-1" }),
    ).toBeNull();
    expect(latestCorrection({ versions: [], latest: null })).toBeNull();
  });

  it("names the newest version when latest names an older one", () => {
    expect(
      latestCorrection({ versions: ["2.1.4-9", "2.1.4"], latest: "2.1.4-9" }),
    ).toBe("2.1.4");
  });
});

describe("manifestProblem", () => {
  const good = {
    name: "@oxagen/cli",
    version: "2.1.4-1",
    bin: { oxagen: "oxagen.mjs" },
    dependencies: { "@cedar-policy/cedar-wasm": "4.13.0" },
  };

  it("passes a clean manifest", () => {
    expect(manifestProblem(good, "2.1.4-1")).toBeNull();
  });

  it("refuses each historical failure", () => {
    expect(manifestProblem({ ...good, private: true }, "2.1.4-1")).toMatch(
      /private/,
    );
    expect(manifestProblem({ ...good, bin: {} }, "2.1.4-1")).toMatch(/bin/);
    expect(manifestProblem(good, "2.1.4-2")).toMatch(/!= release version/);
    expect(
      manifestProblem(
        { ...good, dependencies: { "@oxagen/oxagen": "workspace:*" } },
        "2.1.4-1",
      ),
    ).toMatch(/workspace:\* deps leaked into publish manifest: @oxagen\/oxagen/);
  });
});

/**
 * A registry the publish talks to through `npm view`, `npm publish` and
 * `npm dist-tag add`. `onPublish` runs inside the publish call, where a test
 * can stand in for a second run or a failure.
 */
function fakeRegistry(
  initial: { versions: string[]; latest: string | null },
  version: string,
  onPublish?: (state: { versions: string[]; latest: string | null }) => void,
) {
  const state = { versions: [...initial.versions], latest: initial.latest };
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  let staleViews = 0;
  const npm: NpmRunner = (args, opts) => {
    calls.push({ args, env: opts.env });
    switch (args[0]) {
      case "view":
        if (staleViews > 0) {
          staleViews--;
          return JSON.stringify({
            versions: initial.versions,
            "dist-tags": initial.latest ? { latest: initial.latest } : {},
          });
        }
        return JSON.stringify({
          versions: state.versions,
          "dist-tags": state.latest ? { latest: state.latest } : {},
        });
      case "publish":
        onPublish?.(state);
        state.versions.push(version);
        state.latest = version;
        return "";
      case "dist-tag": {
        const spec = args[2] ?? "";
        state.latest = spec.slice(spec.lastIndexOf("@") + 1);
        return "";
      }
      default:
        throw new Error(`unexpected npm ${args.join(" ")}`);
    }
  };
  return {
    npm,
    state,
    calls,
    lagNextView: () => {
      staleViews = 1;
    },
  };
}

function deps(npm: NpmRunner, version: string): PublishDeps & {
  build: ReturnType<typeof vi.fn>;
} {
  return {
    npm,
    build: vi.fn(),
    readManifest: () => ({
      name: "@oxagen/cli",
      version,
      bin: { oxagen: "oxagen.mjs" },
      dependencies: {},
    }),
    log: () => {},
  };
}

describe("publishCliToNpm", () => {
  beforeEach(() => {
    vi.stubEnv("NPM_TOKEN", TOKEN);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does nothing without a token", async () => {
    vi.stubEnv("NPM_TOKEN", "");
    const reg = fakeRegistry({ versions: [], latest: null }, "2.1.4-1");
    const d = deps(reg.npm, "2.1.4-1");
    await expect(publishCliToNpm("2.1.4-1", d)).resolves.toBe("no-token");
    expect(reg.calls).toEqual([]);
    expect(d.build).not.toHaveBeenCalled();
  });

  it("publishes a newer build under latest with the token from the environment", async () => {
    const reg = fakeRegistry(
      { versions: ["1.0.1", "2.1.3"], latest: "2.1.3" },
      "2.1.4-1",
    );
    const d = deps(reg.npm, "2.1.4-1");
    let npmrc = "";
    let npmrcPath = "";
    const publish = reg.npm;
    const spy: NpmRunner = (args, opts) => {
      if (args[0] === "publish") {
        npmrcPath = args[args.indexOf("--userconfig") + 1] ?? "";
        npmrc = readFileSync(npmrcPath, "utf8");
      }
      return publish(args, opts);
    };
    d.npm = spy;

    await expect(publishCliToNpm("2.1.4-1", d)).resolves.toBe("published");

    expect(d.build).toHaveBeenCalledOnce();
    const call = reg.calls.find((c) => c.args[0] === "publish");
    expect(call?.args.slice(0, 3)).toEqual(["publish", "--tag", "latest"]);
    expect(call?.env?.NPM_TOKEN).toBe(TOKEN);
    expect(npmrc).toBe("//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n");
    expect(npmrc).not.toContain(TOKEN);
    expect(existsSync(npmrcPath)).toBe(false);
    expect(reg.state.latest).toBe("2.1.4-1");
    expect(reg.calls.some((c) => c.args[0] === "dist-tag")).toBe(false);
  });

  it("skips a version npm already holds without building", async () => {
    const reg = fakeRegistry(
      { versions: ["2.1.4-1"], latest: "2.1.4-1" },
      "2.1.4-1",
    );
    const d = deps(reg.npm, "2.1.4-1");
    await expect(publishCliToNpm("2.1.4-1", d)).resolves.toBe("skipped");
    expect(d.build).not.toHaveBeenCalled();
  });

  it("skips a build older than the newest on npm, so latest never moves back", async () => {
    const reg = fakeRegistry({ versions: ["2.1.4"], latest: "2.1.4" }, "2.1.4-7");
    const d = deps(reg.npm, "2.1.4-7");
    await expect(publishCliToNpm("2.1.4-7", d)).resolves.toBe("skipped");
    expect(d.build).not.toHaveBeenCalled();
    expect(reg.state.latest).toBe("2.1.4");
  });

  it("moves latest to a newer version another run published at the same time", async () => {
    const reg = fakeRegistry(
      { versions: ["2.1.3"], latest: "2.1.3" },
      "2.1.4-7",
      (state) => {
        // The release run lands first; this run's publish then takes latest.
        state.versions.push("2.1.4");
        state.latest = "2.1.4";
      },
    );
    await expect(
      publishCliToNpm("2.1.4-7", deps(reg.npm, "2.1.4-7")),
    ).resolves.toBe("published");
    const tag = reg.calls.find((c) => c.args[0] === "dist-tag");
    expect(tag?.args.slice(0, 4)).toEqual([
      "dist-tag",
      "add",
      "@oxagen/cli@2.1.4",
      "latest",
    ]);
    expect(tag?.env?.NPM_TOKEN).toBe(TOKEN);
    expect(reg.state.latest).toBe("2.1.4");
  });

  it("counts its own version when the registry has not caught up", async () => {
    const reg = fakeRegistry({ versions: ["2.1.3"], latest: "2.1.3" }, "2.1.4-1");
    const d = deps(reg.npm, "2.1.4-1");
    const inner = reg.npm;
    let published = false;
    d.npm = (args, opts) => {
      if (args[0] === "view" && published) reg.lagNextView();
      const out = inner(args, opts);
      if (args[0] === "publish") published = true;
      return out;
    };
    await expect(publishCliToNpm("2.1.4-1", d)).resolves.toBe("published");
    // The stale read says latest is 2.1.3; pointing it at 2.1.4-1 again is
    // harmless, and pointing it back at 2.1.3 would not be.
    expect(reg.state.latest).toBe("2.1.4-1");
  });

  it("treats a refused publish as done when another run published the version", async () => {
    const reg = fakeRegistry({ versions: ["2.1.3"], latest: "2.1.3" }, "2.1.4");
    const d = deps(reg.npm, "2.1.4");
    const inner = reg.npm;
    d.npm = (args, opts) => {
      if (args[0] === "publish") {
        reg.state.versions.push("2.1.4");
        throw new Error("E403 You cannot publish over the previously published versions");
      }
      return inner(args, opts);
    };
    await expect(publishCliToNpm("2.1.4", d)).resolves.toBe("skipped");
  });

  it("fails with the way to replace the token when npm refuses the publish", async () => {
    const reg = fakeRegistry({ versions: ["2.1.3"], latest: "2.1.3" }, "2.1.4-1");
    const d = deps(reg.npm, "2.1.4-1");
    const inner = reg.npm;
    d.npm = (args, opts) => {
      if (args[0] === "publish") throw new Error("E404 Not Found - PUT");
      return inner(args, opts);
    };
    await expect(publishCliToNpm("2.1.4-1", d)).rejects.toThrow(
      /E404 Not Found.*NPM_TOKEN is current.*ci-registry\.ts/,
    );
  });

  it("refuses a bad manifest before it publishes", async () => {
    const reg = fakeRegistry({ versions: [], latest: null }, "2.1.4-1");
    const d = deps(reg.npm, "2.1.4-1");
    d.readManifest = () => ({
      name: "@oxagen/cli",
      version: "2.1.3",
      bin: { oxagen: "oxagen.mjs" },
    });
    await expect(publishCliToNpm("2.1.4-1", d)).rejects.toThrow(
      /manifest version 2\.1\.3 != release version 2\.1\.4-1/,
    );
    expect(reg.calls.some((c) => c.args[0] === "publish")).toBe(false);
  });
});
