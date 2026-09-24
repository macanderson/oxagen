/**
 * Install lifecycle failures found by the tacho install audit, against the
 * install rig (real file writers, real model base URL and credential
 * contracts, a fake launchctl and control plane): a failed reassign or
 * harness addition, a daemon that does not come back, `--force` over a live
 * enrollment, a fleet-revoked host, `--print-managed`, root, a deleted
 * GitHub checkout, the `--port` and `--token` flags, a native layout with
 * no tacho executable, the harness files host.json records, and a bundle
 * signed for another host.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../host/control-client";
import {
  harnessFilesRecord,
  readHostFile,
  writeHostFile,
} from "../host/host-file";
import { acquireInstallLock } from "../host/install-lock";
import { tachoPaths } from "../host/paths";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import type { TachoHarness } from "../wire";
import type { CliDeps } from "./deps";
import { enroll } from "./enroll";
import { restoreGithubRepositories } from "./github";
import {
  buildRig,
  RIG_GATEWAY_PORT,
  type Rig,
  type RigOptions,
  seedHome,
} from "./install-rig";
import {
  buildTachoProgram,
  parsePort,
  recordedCliDeps,
  tokenOption,
} from "./main";
import { reassign } from "./reassign";
import { unenroll } from "./unenroll";

const ANTHROPIC_KEY = "sk-ant-api03-FAKE-AUDIT-FIX-0001";
const CLAUDE_URL = `http://127.0.0.1:${RIG_GATEWAY_PORT}/anthropic`;
const NEW_ENROLLMENT = "tch_zyxwvutsrqpnmkjhgfedcb";

interface ClaudeSettings {
  apiKeyHelper?: string;
  env?: Record<string, string>;
}

/**
 * A rig whose Claude Code settings hold a vendor key, enrolled for Claude
 * Code (and Codex unless told otherwise): the gateway holds the key, Claude
 * Code holds the helper, and every enrolled harness names the proxy.
 */
async function brokeredRig(
  options: RigOptions = {},
  harnesses: TachoHarness[] = ["claude-code", "codex"],
): Promise<Rig> {
  const seed = seedHome();
  const settingsPath = join(seed.home, ".claude", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    env: Record<string, string>;
  };
  settings.env["ANTHROPIC_API_KEY"] = ANTHROPIC_KEY;
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 4)}\n`);
  const rig = buildRig(seed, options);
  const enrolled = await enroll({ harnesses }, rig.deps);
  expect(enrolled.ok).toBe(true);
  const armed = claudeSettings(rig);
  expect(armed.env?.["ANTHROPIC_BASE_URL"]).toBe(CLAUDE_URL);
  expect(armed.apiKeyHelper).toContain("credential issue");
  expect(armed.env?.["ANTHROPIC_API_KEY"]).toBeUndefined();
  if (harnesses.includes("codex"))
    expect(codexConfig(rig)).toContain("openai_base_url");
  return rig;
}

function claudeSettings(rig: Rig): ClaudeSettings {
  return JSON.parse(
    readFileSync(join(rig.home, ".claude", "settings.json"), "utf8"),
  ) as ClaudeSettings;
}

function codexConfig(rig: Rig): string {
  return readFileSync(join(rig.home, ".codex", "config.toml"), "utf8");
}

/** The gateway is out of every file and the key is back where it came from. */
function expectDisarmed(rig: Rig): void {
  const settings = claudeSettings(rig);
  expect(settings.env?.["ANTHROPIC_BASE_URL"]).toBeUndefined();
  expect(settings.apiKeyHelper).toBeUndefined();
  expect(settings.env?.["ANTHROPIC_API_KEY"]).toBe(ANTHROPIC_KEY);
  expect(codexConfig(rig)).not.toContain("openai_base_url");
}

/** The rig's control plane with one route answering `status` instead. */
function refusing(rig: Rig, suffix: string, status: number): FetchLike {
  return async (url, init) =>
    url.endsWith(suffix)
      ? { ok: false, status, text: async () => "refused by the test" }
      : rig.deps.fetch(url, init);
}

describe("a failed reassign", () => {
  it("takes the gateway out of the harness files before it stops tachod", async () => {
    // What Claude Code's settings named at the moment tachod was booted out.
    const watched: { rig?: Rig } = {};
    let urlAtBootout: string | undefined = "not observed";
    const rig = await brokeredRig({
      onExec: (command, args) => {
        if (
          watched.rig !== undefined &&
          command === "launchctl" &&
          args[0] === "bootout"
        )
          urlAtBootout = claudeSettings(watched.rig).env?.[
            "ANTHROPIC_BASE_URL"
          ];
      },
    });
    watched.rig = rig;
    const d: CliDeps = {
      ...rig.deps,
      fetch: refusing(rig, "/tacho/enrollments", 403),
    };
    const result = await reassign({ workspace: "edge" }, d);
    expect(result.ok).toBe(false);
    expect(rig.errors.at(-1)).toContain(
      "Reassign failed after revoking the old enrollment",
    );
    expectDisarmed(rig);
    expect(rig.serviceLoaded()).toBe(false);
    // The bootout ran, and by then the base URL was already gone.
    expect(urlAtBootout).toBeUndefined();
    expect(readHostFile(rig.deps.paths.hostFile)?.revoked_at).not.toBeNull();
  });

  it("leaves tachod running when a harness file cannot be disarmed", async () => {
    const rig = await brokeredRig();
    const contract = rig.deps.modelBaseUrls;
    if (contract === undefined) throw new Error("rig has no base URL contract");
    const d: CliDeps = {
      ...rig.deps,
      fetch: refusing(rig, "/tacho/enrollments", 403),
      modelBaseUrls: {
        ...contract,
        restore: async () => {
          throw new Error("settings.json is locked");
        },
      },
    };
    const result = await reassign({ workspace: "edge" }, d);
    expect(result.ok).toBe(false);
    expect(rig.serviceLoaded()).toBe(true);
    expect(claudeSettings(rig).env?.["ANTHROPIC_BASE_URL"]).toBe(CLAUDE_URL);
    expect(rig.errors.join("\n")).toContain("tachod was left running");
    expect(rig.errors.join("\n")).toContain("settings.json is locked");
  });
});

describe("a re-enroll whose daemon does not come back", () => {
  it("takes the previous base URL and helper out and exits non-zero", async () => {
    const rig = await brokeredRig();
    const d: CliDeps = { ...rig.deps, daemonGet: async () => undefined };
    const result = await enroll({}, d);
    // `tacho enroll` exits 1 on a host that is not reporting (`main.ts`).
    expect(result.shipping).toMatchObject({ healthy: false });
    expect(result.shipping?.detail).toContain("tachod did not answer");
    expect(result.host?.host_enrollment_id).toBe(TEST_ENROLLMENT);
    expectDisarmed(rig);
    expect(result.warnings.join("\n")).toContain(
      "the model base URL was taken out of",
    );
    expect(rig.errors.at(-1)).toContain("it is not reporting");
  });

  it("fails a reassign whose new daemon never answers", async () => {
    const rig = await brokeredRig();
    const d: CliDeps = { ...rig.deps, daemonGet: async () => undefined };
    const result = await reassign({ workspace: "edge" }, d);
    expect(result.ok).toBe(false);
    expect(result.to?.workspace).toBe("edge");
    expectDisarmed(rig);
    expect(rig.errors.at(-1)).toContain("it is not reporting");
    expect(rig.lines.join("\n")).not.toContain("Reassigned");
  });

  it("disarms a healthy daemon whose proxy is not listening, and still succeeds", async () => {
    const rig = await brokeredRig();
    const quiet = buildRig(
      { home: rig.home, platform: "darwin" },
      { gatewayListening: false },
    );
    const result = await enroll({}, quiet.deps);
    expect(result.ok).toBe(true);
    expectDisarmed(rig);
  });
});

describe("adding a harness", () => {
  it("leaves the host unenrolled and disarmed when the new enrollment is refused after the revoke", async () => {
    const rig = await brokeredRig({}, ["claude-code"]);
    const d: CliDeps = {
      ...rig.deps,
      fetch: refusing(rig, "/tacho/enrollments", 503),
    };
    rig.requests.length = 0;
    const result = await enroll({ harnesses: ["claude-code", "codex"] }, d);
    expect(result.ok).toBe(false);
    expect(rig.requests.map((r) => r.url)).toEqual([
      "https://api.rig.test/v1/acme/core/tacho/enrollments/revoke",
    ]);
    const errors = rig.errors.join("\n");
    expect(errors).toContain("this host is now unenrolled");
    expect(errors).toContain(
      "tacho enroll --harness claude-code,codex --org acme --workspace core --api-url https://api.rig.test",
    );
    const host = readHostFile(rig.deps.paths.hostFile);
    expect(host?.revoked_at).not.toBeNull();
    const settings = claudeSettings(rig);
    expect(JSON.stringify(settings)).not.toContain(TEST_ENROLLMENT);
    expect(settings.env?.["ANTHROPIC_BASE_URL"]).toBeUndefined();
    expect(settings.apiKeyHelper).toBeUndefined();
    expect(settings.env?.["ANTHROPIC_API_KEY"]).toBe(ANTHROPIC_KEY);
    expect(rig.serviceLoaded()).toBe(false);

    // The printed recovery takes the fresh path.
    const recovered = await enroll(
      { harnesses: ["claude-code", "codex"] },
      rig.deps,
    );
    expect(recovered.ok).toBe(true);
    expect(readHostFile(rig.deps.paths.hostFile)).toMatchObject({
      harnesses: ["claude-code", "codex"],
      revoked_at: null,
    });
  });

  it("changes nothing when the control plane refuses the revoke", async () => {
    const seed = seedHome();
    const rig = buildRig(seed);
    expect((await enroll({ harnesses: ["claude-code"] }, rig.deps)).ok).toBe(
      true,
    );
    const hostBefore = readFileSync(rig.deps.paths.hostFile, "utf8");
    const settingsBefore = readFileSync(
      join(seed.home, ".claude", "settings.json"),
      "utf8",
    );
    rig.requests.length = 0;
    const d: CliDeps = {
      ...rig.deps,
      fetch: refusing(rig, "/tacho/enrollments/revoke", 403),
    };
    const result = await enroll({ harnesses: ["claude-code", "codex"] }, d);
    expect(result.ok).toBe(false);
    expect(rig.errors.at(-1)).toContain("Cannot add codex");
    expect(rig.errors.at(-1)).toContain("revoke answered 403");
    expect(rig.errors.at(-1)).toContain("nothing was changed");
    // Nothing minted, nothing marked, nothing stripped, tachod untouched.
    expect(rig.requests).toEqual([]);
    expect(readFileSync(rig.deps.paths.hostFile, "utf8")).toBe(hostBefore);
    expect(
      readFileSync(join(seed.home, ".claude", "settings.json"), "utf8"),
    ).toBe(settingsBefore);
    expect(rig.serviceLoaded()).toBe(true);
  });
});

/** The rig's control plane, answering a second enrollment with a new id. */
function mintingNewIds(rig: Rig): FetchLike {
  let minted = 0;
  return async (url, init) => {
    const answer = await rig.deps.fetch(url, init);
    if (!url.endsWith("/tacho/enrollments")) return answer;
    minted += 1;
    if (minted === 1) return answer;
    return reissued(answer, NEW_ENROLLMENT, NEW_ENROLLMENT);
  };
}

/**
 * An enrollment answer re-stated for `id`, with a bundle freshly signed
 * for `bundleFor` (the same id, unless a test wants them to disagree).
 */
async function reissued(
  answer: Awaited<ReturnType<FetchLike>>,
  id: string,
  bundleFor: string,
): Promise<Awaited<ReturnType<FetchLike>>> {
  const body = JSON.parse(await answer.text()) as Record<string, unknown> & {
    enrollment: { claims: { host_enrollment_id: string } };
  };
  const signer = bundleSigner();
  body["hostEnrollmentId"] = id;
  body.enrollment.claims.host_enrollment_id = id;
  body["policyBundle"] = signer.sign(
    unsignedBundle({ mode: "observe", host_enrollment_id: bundleFor }),
  );
  body["bundlePublicKeyPem"] = signer.publicKeyPem;
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
}

describe("enroll --force over a live enrollment", () => {
  it("revokes the enrollment it replaces", async () => {
    const seed = seedHome();
    const rig = buildRig(seed);
    const d: CliDeps = { ...rig.deps, fetch: mintingNewIds(rig) };
    expect((await enroll({ harnesses: ["claude-code"] }, d)).ok).toBe(true);
    rig.requests.length = 0;
    const forced = await enroll({ harnesses: ["claude-code"], force: true }, d);
    expect(forced.ok).toBe(true);
    expect(forced.host?.host_enrollment_id).toBe(NEW_ENROLLMENT);
    expect(rig.requests.map((r) => r.url)).toEqual([
      "https://api.rig.test/v1/acme/core/tacho/enrollments",
      "https://api.rig.test/v1/acme/core/tacho/enrollments/revoke",
    ]);
    expect(rig.requests[1]?.body).toMatchObject({
      hostEnrollmentId: TEST_ENROLLMENT,
      reason: "tacho enroll --force",
    });
  });

  it("keeps the new enrollment and warns when that revoke fails", async () => {
    const seed = seedHome();
    const rig = buildRig(seed);
    const minting = mintingNewIds(rig);
    let revokeRefused = false;
    const d: CliDeps = {
      ...rig.deps,
      fetch: async (url, init) => {
        if (revokeRefused && url.endsWith("/revoke"))
          return { ok: false, status: 503, text: async () => "down" };
        return minting(url, init);
      },
    };
    expect((await enroll({ harnesses: ["claude-code"] }, d)).ok).toBe(true);
    revokeRefused = true;
    const forced = await enroll({ harnesses: ["claude-code"], force: true }, d);
    expect(forced.ok).toBe(true);
    expect(readHostFile(rig.deps.paths.hostFile)?.host_enrollment_id).toBe(
      NEW_ENROLLMENT,
    );
    expect(forced.warnings.join("\n")).toContain(
      `the previous enrollment ${TEST_ENROLLMENT} could not be revoked (revoke answered 503`,
    );
  });

  it("does not revoke an enrollment the control plane answered again", async () => {
    const seed = seedHome();
    const rig = buildRig(seed);
    expect((await enroll({ harnesses: ["claude-code"] }, rig.deps)).ok).toBe(
      true,
    );
    rig.requests.length = 0;
    expect(
      (await enroll({ harnesses: ["claude-code"], force: true }, rig.deps)).ok,
    ).toBe(true);
    expect(rig.requests.map((r) => r.url)).toEqual([
      "https://api.rig.test/v1/acme/core/tacho/enrollments",
    ]);
  });
});

describe("a host revoked from the fleet page", () => {
  it("is refused rather than re-applied, and --force enrolls it again", async () => {
    const seed = seedHome();
    const rig = buildRig(seed);
    expect((await enroll({ harnesses: ["claude-code"] }, rig.deps)).ok).toBe(
      true,
    );
    const host = readHostFile(rig.deps.paths.hostFile);
    if (host === undefined) throw new Error("not enrolled");
    writeHostFile(rig.deps.paths.hostFile, { ...host, host_status: "revoked" });
    const bootstraps = () =>
      rig.execs.filter((e) => e.args[0] === "bootstrap").length;
    const before = bootstraps();
    rig.requests.length = 0;
    const refused = await enroll({}, rig.deps);
    expect(refused.ok).toBe(false);
    expect(rig.errors.at(-1)).toContain("was revoked on the control plane");
    expect(rig.errors.at(-1)).toContain("tacho unenroll");
    expect(rig.errors.at(-1)).toContain("tacho enroll --force");
    expect(rig.requests).toEqual([]);
    expect(bootstraps()).toBe(before);

    const forced = await enroll({ force: true }, rig.deps);
    expect(forced.ok).toBe(true);
    // Already revoked on the control plane: no second revoke is asked for.
    expect(rig.requests.map((r) => r.url)).toEqual([
      "https://api.rig.test/v1/acme/core/tacho/enrollments",
    ]);
    expect(readHostFile(rig.deps.paths.hostFile)?.host_status).toBe("active");
  });
});

describe("enroll --print-managed", () => {
  it("waits for the install lock like any enroll", async () => {
    const rig = buildRig(seedHome());
    const lock = acquireInstallLock(rig.deps.paths.root, rig.deps.now);
    if ("heldBy" in lock) throw new Error("lock already held");
    try {
      const result = await enroll({ printManaged: true }, rig.deps);
      expect(result.ok).toBe(false);
      expect(rig.errors.join("\n")).toMatch(/another tacho enroll/i);
      expect(rig.requests).toEqual([]);
    } finally {
      lock.release();
    }
  });

  it("renders an enrolled host's document without minting or installing", async () => {
    const rig = buildRig(seedHome());
    expect((await enroll({ harnesses: ["claude-code"] }, rig.deps)).ok).toBe(
      true,
    );
    const hostBefore = readFileSync(rig.deps.paths.hostFile, "utf8");
    const execsBefore = rig.execs.length;
    rig.requests.length = 0;
    rig.lines.length = 0;
    const result = await enroll(
      { printManaged: true, harnesses: ["claude-code", "codex"] },
      rig.deps,
    );
    expect(result.ok).toBe(true);
    expect(result.managedSettings).toMatchObject({
      allowManagedHooksOnly: true,
    });
    expect(rig.lines.join("\n")).toContain(TEST_ENROLLMENT);
    expect(rig.requests).toEqual([]);
    expect(rig.execs.length).toBe(execsBefore);
    expect(readFileSync(rig.deps.paths.hostFile, "utf8")).toBe(hostBefore);
  });
});

describe("running as root", () => {
  it("refuses enroll and reassign before touching anything, unless --allow-root", async () => {
    const rig = buildRig(seedHome());
    const root = {
      ...rig.deps,
      env: { ...rig.deps.env, SUDO_USER: "dev" },
      getuid: () => 0,
    };
    const refused = await enroll({ harnesses: ["claude-code"] }, root);
    expect(refused.ok).toBe(false);
    expect(rig.errors.at(-1)).toContain("running as root");
    expect(rig.errors.at(-1)).toContain("sudo -u dev tacho enroll");
    expect(rig.requests).toEqual([]);
    expect(readHostFile(rig.deps.paths.hostFile)).toBeUndefined();
    expect((await reassign({ workspace: "edge" }, root)).ok).toBe(false);
    expect(rig.errors.at(-1)).toContain("sudo -u dev tacho reassign");

    expect(
      (await enroll({ harnesses: ["claude-code"], allowRoot: true }, root)).ok,
    ).toBe(true);
    const user = { ...rig.deps, getuid: () => 501 };
    expect((await enroll({}, user)).ok).toBe(true);
  });

  it("offers --allow-root on enroll and reassign", () => {
    const program = buildTachoProgram();
    for (const name of ["enroll", "reassign"])
      expect(
        program.commands
          .find((c) => c.name() === name)
          ?.options.some((o) => o.long === "--allow-root"),
      ).toBe(true);
  });
});

describe("GitHub custody of a deleted checkout", () => {
  function gitExec(deps: CliDeps): CliDeps["exec"] {
    return (command, args) => {
      if (command !== "git") return deps.exec(command, args);
      const out = spawnSync("git", args, {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_COUNT: "0",
        },
      });
      return { status: out.status, stdout: out.stdout, stderr: out.stderr };
    };
  }

  function receipt(cwd: string) {
    return {
      cwd,
      repository: "acme/repo",
      harness: "claude-code" as const,
      url: "http://127.0.0.1:47123/github/acme/repo.git",
      helper: "!tacho github credential --harness claude-code",
      remotes: [
        {
          key: "remote.origin.url",
          before: ["git@github.com:acme/repo.git"],
          after: ["http://127.0.0.1:47123/github/acme/repo.git"],
        },
      ],
    };
  }

  it("drops the receipt with a warning, so unenroll and enroll --force go on", async () => {
    const seed = seedHome();
    const rig = buildRig(seed);
    const d: CliDeps = { ...rig.deps, exec: gitExec(rig.deps) };
    expect((await enroll({ harnesses: ["claude-code"] }, d)).ok).toBe(true);
    const notGit = join(seed.home, "not-a-checkout");
    mkdirSync(notGit);
    const host = readHostFile(d.paths.hostFile);
    if (host === undefined) throw new Error("not enrolled");
    writeHostFile(d.paths.hostFile, {
      ...host,
      github_repositories: [
        receipt(join(seed.home, "deleted")),
        receipt(notGit),
      ],
    });

    const forced = await enroll({ harnesses: ["claude-code"], force: true }, d);
    expect(forced.ok).toBe(true);
    expect(
      forced.warnings.filter((w) =>
        w.includes("is gone or is no longer a Git"),
      ),
    ).toHaveLength(2);

    writeHostFile(d.paths.hostFile, {
      ...(readHostFile(d.paths.hostFile) ?? host),
      github_repositories: [receipt(join(seed.home, "deleted"))],
    });
    const removed = await unenroll({ purge: true }, d);
    expect(removed.ok).toBe(true);
    expect(removed.warnings.join("\n")).toContain(
      `${join(seed.home, "deleted")} is gone or is no longer a Git checkout`,
    );
  });

  it("still refuses a checkout git cannot read for another reason", () => {
    const rig = buildRig(seedHome());
    const warnings: string[] = [];
    const d: CliDeps = {
      ...rig.deps,
      exec: () => ({
        status: 128,
        stdout: "",
        stderr: "fatal: detected dubious ownership in repository",
      }),
    };
    const failures = restoreGithubRepositories(
      { github_repositories: [receipt(rig.home)] },
      d,
      warnings,
    );
    expect(failures).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});

describe("--port", () => {
  it("accepts an unprivileged port and refuses anything host.json would not load", () => {
    expect(parsePort("47123")).toBe(47123);
    expect(parsePort("1024")).toBe(1024);
    expect(parsePort("65535")).toBe(65535);
    for (const bad of ["abc", "80", "1023", "65536", "4712.5", "-1", ""])
      expect(() => parsePort(bad)).toThrow(/1024 to 65535/);
    const option = buildTachoProgram()
      .commands.find((c) => c.name() === "enroll")
      ?.options.find((o) => o.long === "--port");
    expect(() => option?.parseArg?.("abc", undefined)).toThrow(/1024 to 65535/);
  });
});

describe("--token and --token-stdin", () => {
  it("reads the token from stdin, and warns when it is on the command line", () => {
    const errors: string[] = [];
    const err = (line: string) => errors.push(line);
    expect(
      tokenOption({ tokenStdin: true }, err, () => "oxa_from_stdin\n"),
    ).toBe("oxa_from_stdin");
    expect(errors).toEqual([]);
    expect(tokenOption({ token: "oxa_argv" }, err)).toBe("oxa_argv");
    expect(errors.join("\n")).toContain("--token-stdin");
    expect(tokenOption({}, err)).toBeUndefined();
    expect(() =>
      tokenOption({ token: "a", tokenStdin: true }, err, () => "b"),
    ).toThrow(/not both/);
    expect(() => tokenOption({ tokenStdin: true }, err, () => "  \n")).toThrow(
      /no token/,
    );
    const program = buildTachoProgram();
    for (const name of ["enroll", "unenroll", "reassign"])
      expect(
        program.commands
          .find((c) => c.name() === name)
          ?.options.some((o) => o.long === "--token-stdin"),
      ).toBe(true);
  });
});

describe("a native layout with no tacho executable", () => {
  const missing =
    "there is no tacho in /opt/oxagen, and this process (oxagen-sidecar) is not one";

  it("refuses a fresh enrollment before anything is minted", async () => {
    const rig = buildRig(seedHome());
    const d: CliDeps = {
      ...rig.deps,
      runtime: { ...rig.deps.runtime, executableProblem: missing },
    };
    const result = await enroll({ harnesses: ["claude-code"] }, d);
    expect(result.ok).toBe(false);
    expect(rig.errors.at(-1)).toContain("Cannot enroll from here");
    expect(rig.errors.at(-1)).toContain(missing);
    expect(rig.requests).toEqual([]);
    expect(readHostFile(rig.deps.paths.hostFile)).toBeUndefined();
  });

  it("keeps a live host on the commands it has instead of repointing them", async () => {
    const rig = buildRig(seedHome());
    expect((await enroll({ harnesses: ["claude-code"] }, rig.deps)).ok).toBe(
      true,
    );
    const before = readHostFile(rig.deps.paths.hostFile);
    const d: CliDeps = {
      ...rig.deps,
      runtime: {
        ...rig.deps.runtime,
        hookCommand: "'/opt/oxagen/tacho' hook",
        daemonCommand: ["/opt/oxagen/tacho", "daemon"],
        mcpStdioCommand: ["/opt/oxagen/tacho", "mcp-stdio"],
        binDir: "/opt/oxagen",
        executableProblem: missing,
      },
    };
    const result = await enroll({}, d);
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toContain(
      `${missing}, so the service and hooks stay on ${before?.hook_command}`,
    );
    expect(readHostFile(rig.deps.paths.hostFile)?.hook_command).toBe(
      before?.hook_command,
    );
  });

  it("refuses a reassign before the revoke", async () => {
    const rig = buildRig(seedHome());
    expect((await enroll({ harnesses: ["claude-code"] }, rig.deps)).ok).toBe(
      true,
    );
    rig.requests.length = 0;
    const d: CliDeps = {
      ...rig.deps,
      runtime: { ...rig.deps.runtime, executableProblem: missing },
    };
    expect((await reassign({ workspace: "edge" }, d)).ok).toBe(false);
    expect(rig.errors.at(-1)).toContain(
      "Cannot reassign, so nothing was changed",
    );
    expect(rig.errors.at(-1)).toContain(missing);
    expect(rig.requests).toEqual([]);
  });
});

describe("the harness files host.json records", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("are written at enroll, and are what unenroll and reassign strip", async () => {
    const rig = buildRig(seedHome());
    expect((await enroll({ harnesses: ["claude-code"] }, rig.deps)).ok).toBe(
      true,
    );
    const host = readHostFile(rig.deps.paths.hostFile);
    expect(host?.harness_files).toEqual(harnessFilesRecord(rig.deps.paths));

    // The shell that runs unenroll moved Claude Code's config directory;
    // the deps it gets still name the file the hooks went into.
    vi.stubEnv("HOME", rig.home);
    vi.stubEnv("TACHO_HOME", rig.deps.paths.root);
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(rig.home, "elsewhere"));
    expect(tachoPaths().claudeSettings).toBe(
      join(rig.home, "elsewhere", "settings.json"),
    );
    const recorded = recordedCliDeps();
    expect(recorded.paths.claudeSettings).toBe(rig.deps.paths.claudeSettings);
    expect(recorded.paths.codexHooks).toBe(rig.deps.paths.codexHooks);
  });

  it("are recorded again when a re-enroll repoints the commands", async () => {
    const rig = buildRig(seedHome());
    expect((await enroll({ harnesses: ["claude-code"] }, rig.deps)).ok).toBe(
      true,
    );
    const host = readHostFile(rig.deps.paths.hostFile);
    if (host === undefined) throw new Error("not enrolled");
    // Enrolled by a version that recorded nothing.
    const older = { ...host };
    delete older.harness_files;
    writeHostFile(rig.deps.paths.hostFile, older);
    const moved = join(rig.home, "Applications", "Oxagen 2.app", "tacho");
    const d: CliDeps = {
      ...rig.deps,
      runtime: {
        ...rig.deps.runtime,
        hookCommand: `'${moved}' hook`,
        daemonCommand: [moved, "daemon"],
        mcpStdioCommand: [moved, "mcp-stdio"],
      },
    };
    expect((await enroll({}, d)).ok).toBe(true);
    expect(readHostFile(rig.deps.paths.hostFile)?.harness_files).toEqual(
      harnessFilesRecord(rig.deps.paths),
    );
  });
});

describe("the service environment", () => {
  it("carries the harness homes the enrolling shell set", async () => {
    const seed = seedHome();
    const env = {
      HOME: seed.home,
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/zsh",
      CODEX_HOME: join(seed.home, ".codex"),
      STELLA_HOME: join(seed.home, ".stella"),
    };
    const rig = buildRig(seed, { overrides: { env } });
    const installed: Array<Record<string, string>> = [];
    const manager = rig.deps.serviceManager;
    const spy = Object.create(manager) as typeof manager;
    spy.install = (spec) => {
      installed.push(spec.env);
      manager.install(spec);
    };
    const d: CliDeps = { ...rig.deps, serviceManager: spy };
    expect((await enroll({ harnesses: ["claude-code"] }, d)).ok).toBe(true);
    expect(installed[0]).toMatchObject({
      CODEX_HOME: env.CODEX_HOME,
      STELLA_HOME: env.STELLA_HOME,
    });
    expect(installed[0]).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(installed[0]).not.toHaveProperty("CURSOR_CONFIG_DIR");
  });
});

describe("the first policy bundle", () => {
  it("is refused when it was signed for another host", async () => {
    const rig = buildRig(seedHome());
    const d: CliDeps = {
      ...rig.deps,
      fetch: async (url, init) => {
        const answer = await rig.deps.fetch(url, init);
        return url.endsWith("/tacho/enrollments")
          ? reissued(answer, NEW_ENROLLMENT, TEST_ENROLLMENT)
          : answer;
      },
    };
    const result = await enroll({ harnesses: ["claude-code"] }, d);
    expect(result.ok).toBe(false);
    expect(rig.errors.at(-1)).toContain(
      `bundle is for host ${TEST_ENROLLMENT}, not ${NEW_ENROLLMENT}`,
    );
    expect(readHostFile(rig.deps.paths.hostFile)).toBeUndefined();
  });
});
