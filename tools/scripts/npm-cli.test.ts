import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isAlreadyPublished,
  latestCorrection,
  manifestProblem,
  movesLatestForward,
  type NpmRunner,
  parseRegistryState,
  planPublish,
  type PublishDeps,
  publishCliToNpm,
  tarballUrl,
} from "./lib/npm-cli";

const TOKEN = "npm_test_token_value";

describe("tarballUrl", () => {
  it("names the file npm serves for a version", () => {
    expect(tarballUrl("2.1.4-363")).toBe(
      "https://registry.npmjs.org/@oxagen/cli/-/cli-2.1.4-363.tgz",
    );
  });
});

describe("isAlreadyPublished", () => {
  it("reads npm's refusal to publish a version twice", () => {
    expect(
      isAlreadyPublished(
        new Error(
          "npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@oxagen%2fcli - You cannot publish over the previously published versions: 2.1.4-9.",
        ),
      ),
    ).toBe(true);
    expect(isAlreadyPublished(new Error("E404 Not Found - PUT"))).toBe(false);
    expect(isAlreadyPublished("not an error")).toBe(false);
  });
});

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

describe("movesLatestForward", () => {
  it("moves only to a newer version", () => {
    expect(movesLatestForward("2.1.4-1", "2.1.4-2")).toBe(true);
    expect(movesLatestForward("2.1.4-2", "2.1.4-2")).toBe(false);
    expect(movesLatestForward("2.1.4-2", "2.1.4-1")).toBe(false);
  });

  it("gives way when latest names nothing or a shape it cannot order", () => {
    expect(movesLatestForward(null, "2.1.4-1")).toBe(true);
    expect(movesLatestForward("3.0.0-beta.1", "2.1.4-1")).toBe(true);
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
    expect(manifestProblem({ ...good, bin: undefined }, "2.1.4-1")).toMatch(
      /missing bin/,
    );
    expect(manifestProblem(good, "2.1.4-2")).toMatch(/!= release version/);
    expect(
      manifestProblem(
        { ...good, dependencies: { "@oxagen/oxagen": "workspace:*" } },
        "2.1.4-1",
      ),
    ).toMatch(/workspace:\* deps leaked into publish manifest: @oxagen\/oxagen/);
  });
});

type State = {
  versions: string[];
  latest: string | null;
  candidate?: string;
};

/**
 * A registry the publish talks to through `npm view`, `npm publish` and
 * `npm dist-tag add`. `npm publish` adds the version under the tag it names.
 * `beforePublish` and `afterPublish` run inside the publish call, where a
 * test stands in for a second run. `lagViews(n)` makes the next n reads
 * answer the registry as it was at the start, the way a read can trail a
 * publish by a few seconds.
 */
function fakeRegistry(
  initial: State,
  version: string,
  hooks: {
    beforePublish?: (state: State) => void;
    afterPublish?: (state: State) => void;
    refusePublish?: (state: State) => Error;
  } = {},
) {
  const state: State = { versions: [...initial.versions], latest: initial.latest };
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  let stale = 0;
  const view = (s: State) =>
    JSON.stringify({
      versions: s.versions,
      "dist-tags": {
        ...(s.latest ? { latest: s.latest } : {}),
        ...(s.candidate ? { candidate: s.candidate } : {}),
      },
    });
  const npm: NpmRunner = (args, opts) => {
    calls.push({ args, env: opts.env });
    switch (args[0]) {
      case "view":
        if (stale > 0) {
          stale--;
          return view(initial);
        }
        return view(state);
      case "publish": {
        if (hooks.refusePublish) throw hooks.refusePublish(state);
        hooks.beforePublish?.(state);
        state.versions.push(version);
        if (args[args.indexOf("--tag") + 1] === "candidate")
          state.candidate = version;
        else state.latest = version;
        hooks.afterPublish?.(state);
        return "";
      }
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
    lagViews: (n: number) => {
      stale = n;
    },
    tags: () =>
      calls.filter((c) => c.args[0] === "dist-tag").map((c) => c.args[2]),
  };
}

function deps(
  npm: NpmRunner,
  version: string,
): PublishDeps & { build: ReturnType<typeof vi.fn> } {
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

/** The --userconfig file a publish passed, and its contents at the time. */
function captureUserconfig(inner: NpmRunner) {
  const seen = { path: "", text: "" };
  const npm: NpmRunner = (args, opts) => {
    const at = args.indexOf("--userconfig");
    if (at >= 0 && seen.path === "") {
      seen.path = args[at + 1] ?? "";
      seen.text = readFileSync(seen.path, "utf8");
    }
    return inner(args, opts);
  };
  return { npm, seen };
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
    const cap = captureUserconfig(reg.npm);
    const d = deps(cap.npm, "2.1.4-1");

    await expect(publishCliToNpm("2.1.4-1", d)).resolves.toBe("published");

    expect(d.build).toHaveBeenCalledOnce();
    const call = reg.calls.find((c) => c.args[0] === "publish");
    expect(call?.args.slice(0, 3)).toEqual(["publish", "--tag", "latest"]);
    expect(call?.env?.NPM_TOKEN).toBe(TOKEN);
    expect(cap.seen.text).toBe(
      "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n",
    );
    expect(existsSync(cap.seen.path)).toBe(false);
    expect(reg.state.latest).toBe("2.1.4-1");
    expect(reg.tags()).toEqual([]);
  });

  it("strips the quotes a pasted token arrives in", async () => {
    vi.stubEnv("NPM_TOKEN", `"${TOKEN}"`);
    const reg = fakeRegistry({ versions: [], latest: null }, "2.1.4-1");
    await publishCliToNpm("2.1.4-1", deps(reg.npm, "2.1.4-1"));
    const call = reg.calls.find((c) => c.args[0] === "publish");
    expect(call?.env?.NPM_TOKEN).toBe(TOKEN);
  });

  it("skips a version npm already holds without building", async () => {
    const reg = fakeRegistry(
      { versions: ["2.1.4-1"], latest: "2.1.4-1" },
      "2.1.4-1",
    );
    const d = deps(reg.npm, "2.1.4-1");
    await expect(publishCliToNpm("2.1.4-1", d)).resolves.toBe("skipped");
    expect(d.build).not.toHaveBeenCalled();
    expect(reg.tags()).toEqual([]);
  });

  it("skips a build older than the newest on npm, so latest never moves back", async () => {
    const reg = fakeRegistry({ versions: ["2.1.4"], latest: "2.1.4" }, "2.1.4-7");
    const d = deps(reg.npm, "2.1.4-7");
    await expect(publishCliToNpm("2.1.4-7", d)).resolves.toBe("skipped");
    expect(d.build).not.toHaveBeenCalled();
    expect(reg.state.latest).toBe("2.1.4");
    expect(reg.tags()).toEqual([]);
  });

  it("repairs a latest an earlier race left behind, even when it publishes nothing", async () => {
    const reg = fakeRegistry(
      { versions: ["2.1.3", "2.1.4-1"], latest: "2.1.3" },
      "2.1.4-1",
    );
    const d = deps(reg.npm, "2.1.4-1");
    await expect(publishCliToNpm("2.1.4-1", d)).resolves.toBe("skipped");
    expect(d.build).not.toHaveBeenCalled();
    expect(reg.tags()).toEqual(["@oxagen/cli@2.1.4-1"]);
    expect(reg.state.latest).toBe("2.1.4-1");
  });

  it("moves latest to a newer version another run published at the same time", async () => {
    const reg = fakeRegistry({ versions: ["2.1.3"], latest: "2.1.3" }, "2.1.4-7", {
      // The release run lands first; this run's publish then takes latest.
      beforePublish: (state) => {
        state.versions.push("2.1.4");
        state.latest = "2.1.4";
      },
    });
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

  it("counts its own version when every read after the publish is stale", async () => {
    // Without counting 2.1.4-2 in, the stale reads would name 2.1.4-1 as the
    // newest and move latest back to it.
    const reg = fakeRegistry(
      { versions: ["2.1.3", "2.1.4-1"], latest: "2.1.3" },
      "2.1.4-2",
      { afterPublish: () => reg.lagViews(2) },
    );
    await expect(
      publishCliToNpm("2.1.4-2", deps(reg.npm, "2.1.4-2")),
    ).resolves.toBe("published");
    expect(reg.tags()).not.toContain("@oxagen/cli@2.1.4-1");
    expect(reg.state.latest).toBe("2.1.4-2");
  });

  it("never moves latest back when a newer run lands between the publish and a stale read", async () => {
    const reg = fakeRegistry({ versions: ["2.1.3"], latest: "2.1.3" }, "2.1.4-1", {
      afterPublish: (state) => {
        state.versions.push("2.1.4-2");
        state.latest = "2.1.4-2";
        reg.lagViews(1);
      },
    });
    await expect(
      publishCliToNpm("2.1.4-1", deps(reg.npm, "2.1.4-1")),
    ).resolves.toBe("published");
    expect(reg.tags()).toEqual([]);
    expect(reg.state.latest).toBe("2.1.4-2");
  });

  it("treats a refused publish as done when another run published the version", async () => {
    const reg = fakeRegistry({ versions: ["2.1.3"], latest: "2.1.3" }, "2.1.4", {
      refusePublish: (state) => {
        state.versions.push("2.1.4");
        state.latest = "2.1.4";
        return new Error(
          "E403 You cannot publish over the previously published versions",
        );
      },
    });
    await expect(
      publishCliToNpm("2.1.4", deps(reg.npm, "2.1.4")),
    ).resolves.toBe("skipped");
    expect(reg.state.latest).toBe("2.1.4");
  });

  it("trusts npm's refusal over a stale read that does not list the version yet", async () => {
    // npm's package list trailed the first real publish by four minutes, so
    // a run started in that window misses a version another run published.
    const reg = fakeRegistry({ versions: ["2.1.3"], latest: "2.1.3" }, "2.1.4-9", {
      refusePublish: () =>
        new Error(
          "npm error 403 You cannot publish over the previously published versions: 2.1.4-9.",
        ),
    });
    await expect(
      publishCliToNpm("2.1.4-9", deps(reg.npm, "2.1.4-9")),
    ).resolves.toBe("skipped");
  });

  it("fails with the way to replace the token, and keeps the token out of the message", async () => {
    const reg = fakeRegistry({ versions: ["2.1.3"], latest: "2.1.3" }, "2.1.4-1", {
      refusePublish: () => new Error("E404 Not Found - PUT"),
    });
    const cap = captureUserconfig(reg.npm);
    const err = await publishCliToNpm("2.1.4-1", deps(cap.npm, "2.1.4-1")).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(
      /npm publish failed: E404 Not Found.*NPM_TOKEN is current.*ci-registry\.ts/,
    );
    expect(err?.message).not.toContain(TOKEN);
    expect(existsSync(cap.seen.path)).toBe(false);
  });

  it("refuses a bad manifest before it publishes, without blaming the token", async () => {
    const reg = fakeRegistry({ versions: [], latest: null }, "2.1.4-1");
    const d = deps(reg.npm, "2.1.4-1");
    d.readManifest = () => ({
      name: "@oxagen/cli",
      version: "2.1.3",
      bin: { oxagen: "oxagen.mjs" },
    });
    const err = await publishCliToNpm("2.1.4-1", d).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(
      /manifest version 2\.1\.3 != release version 2\.1\.4-1/,
    );
    expect(err?.message).not.toContain("NPM_TOKEN");
    expect(reg.calls.some((c) => c.args[0] === "publish")).toBe(false);
  });
  describe("with a check", () => {
    it("publishes under candidate and moves latest only after the check passes", async () => {
      const reg = fakeRegistry(
        { versions: ["2.1.3"], latest: "2.1.3" },
        "2.1.4-1",
      );
      const check = vi.fn(async () => {
        expect(reg.state.latest).toBe("2.1.3");
        return true;
      });
      await expect(
        publishCliToNpm("2.1.4-1", { ...deps(reg.npm, "2.1.4-1"), check }),
      ).resolves.toBe("published");
      const call = reg.calls.find((c) => c.args[0] === "publish");
      expect(call?.args.slice(0, 3)).toEqual(["publish", "--tag", "candidate"]);
      expect(check).toHaveBeenCalledOnce();
      expect(check).toHaveBeenCalledWith("2.1.4-1");
      expect(reg.tags()).toEqual(["@oxagen/cli@2.1.4-1"]);
      expect(reg.state.latest).toBe("2.1.4-1");
    });

    it("leaves latest where it was when the check fails", async () => {
      const reg = fakeRegistry(
        { versions: ["2.1.3"], latest: "2.1.3" },
        "2.1.4-1",
      );
      const err = await publishCliToNpm("2.1.4-1", {
        ...deps(reg.npm, "2.1.4-1"),
        check: async () => false,
      }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(
        /^@oxagen\/cli@2\.1\.4-1 is on npm, but it failed the check, so latest still names 2\.1\.3/,
      );
      expect(reg.tags()).toEqual([]);
      expect(reg.state.latest).toBe("2.1.3");
      expect(reg.state.candidate).toBe("2.1.4-1");
    });

    it("checks a version an earlier run left unchecked before latest moves to it", async () => {
      const reg = fakeRegistry(
        {
          versions: ["2.1.3", "2.1.4-1"],
          latest: "2.1.3",
          candidate: "2.1.4-1",
        },
        "2.1.4-1",
      );
      const d = deps(reg.npm, "2.1.4-1");
      const check = vi.fn(async () => true);
      await expect(publishCliToNpm("2.1.4-1", { ...d, check })).resolves.toBe(
        "skipped",
      );
      expect(d.build).not.toHaveBeenCalled();
      expect(check).toHaveBeenCalledOnce();
      expect(check).toHaveBeenCalledWith("2.1.4-1");
      expect(reg.state.latest).toBe("2.1.4-1");
    });

    it("keeps latest off a version an earlier run left unchecked when it still fails", async () => {
      const reg = fakeRegistry(
        { versions: ["2.1.3", "2.1.4-1"], latest: "2.1.3" },
        "2.1.4-1",
      );
      await expect(
        publishCliToNpm("2.1.4-1", {
          ...deps(reg.npm, "2.1.4-1"),
          check: async () => false,
        }),
      ).rejects.toThrow(/latest still names 2\.1\.3/);
      expect(reg.tags()).toEqual([]);
      expect(reg.state.latest).toBe("2.1.3");
    });

    it("checks nothing when latest already names the newest version", async () => {
      const reg = fakeRegistry(
        { versions: ["2.1.4-1"], latest: "2.1.4-1" },
        "2.1.4-1",
      );
      const check = vi.fn(async () => true);
      await expect(
        publishCliToNpm("2.1.4-1", { ...deps(reg.npm, "2.1.4-1"), check }),
      ).resolves.toBe("skipped");
      expect(check).not.toHaveBeenCalled();
    });

    it("leaves latest alone when another run moves it past this version during the check", async () => {
      const reg = fakeRegistry(
        { versions: ["2.1.3"], latest: "2.1.3" },
        "2.1.4-1",
      );
      const check = vi.fn(async () => {
        reg.state.versions.push("2.1.4-2");
        reg.state.latest = "2.1.4-2";
        return true;
      });
      await expect(
        publishCliToNpm("2.1.4-1", { ...deps(reg.npm, "2.1.4-1"), check }),
      ).resolves.toBe("published");
      expect(reg.tags()).toEqual([]);
      expect(reg.state.latest).toBe("2.1.4-2");
    });
  });
});
