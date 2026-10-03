/**
 * `oxagen agent enroll | status | unenroll` each serve two scopes.
 *
 * ADR-112 §2.1 names three wrapping commands whose names were already taken by
 * server-scoped operations, and decision 3 resolves the collision by argument
 * rather than by renaming either side. Which side a call lands on is the whole
 * of that decision, and it is invisible from the command tree's shape, so it is
 * asserted here against the handlers each call actually reaches.
 *
 * The flag refusals matter as much as the dispatch. Dropping a flag that
 * belongs to the other scope would tell an operator who passed `--purge` that a
 * local spool was deleted when nothing went near it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../program.js";

type Opts = Record<string, unknown>;
type HostHandler = (opts: Opts) => Promise<boolean>;
type AgentHandler = (agent: string, opts: Opts) => Promise<void>;

type RunHandler = (command: string[], opts: Opts) => Promise<number>;

const {
  handleTachoEnroll,
  handleTachoStatus,
  handleTachoUnenroll,
  handleTachoUninstall,
  handleTachoReassign,
  handleTachoVerify,
  handleAgentEnroll,
  handleAgentRun,
  handleAgentDetect,
  agentStatus,
  agentUnenroll,
} = vi.hoisted(() => ({
  handleTachoEnroll: vi.fn<HostHandler>(async () => true),
  handleTachoStatus: vi.fn<HostHandler>(async () => true),
  handleTachoUnenroll: vi.fn<HostHandler>(async () => true),
  handleTachoUninstall: vi.fn<HostHandler>(async () => true),
  handleTachoReassign: vi.fn<HostHandler>(async () => true),
  handleTachoVerify: vi.fn<HostHandler>(async () => true),
  handleAgentEnroll: vi.fn<HostHandler>(async () => true),
  handleAgentRun: vi.fn<RunHandler>(async () => 0),
  handleAgentDetect: vi.fn<HostHandler>(async () => true),
  agentStatus: vi.fn<AgentHandler>(async () => undefined),
  agentUnenroll: vi.fn<AgentHandler>(async () => undefined),
}));

vi.mock("../commands/tacho.js", () => ({
  handleTachoEnroll,
  handleTachoStatus,
  handleTachoUnenroll,
  handleTachoUninstall,
  handleTachoReassign,
  handleTachoExport: vi.fn(async () => true),
  handleTachoVerify,
  handleTachoHosts: vi.fn(async () => true),
  handleAgentRun,
  handleAgentDetect,
}));
vi.mock("../commands/agent-enroll.js", () => ({ handleAgentEnroll }));
vi.mock("../commands/agent.js", () => ({
  agentRegister: vi.fn(async () => undefined),
  agentStatus,
  agentUnenroll,
}));

// A real enrollment token's shape: the prefix plus the opaque remainder. The
// dispatch reads the prefix only, but a bare prefix would not prove that.
const ENROLLMENT_TOKEN = "oxe_1time_0123456789abcdefghjkmnpqrs";

let program: Command;
let stderr: string;

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  program = buildProgram().exitOverride();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const run = (...argv: string[]) => program.parseAsync(argv, { from: "user" });

describe("oxagen agent enroll", () => {
  it("sends a single-use enrollment token to the registered-agent path", async () => {
    await run("agent", "enroll", "--token", ENROLLMENT_TOKEN);
    expect(handleAgentEnroll).toHaveBeenCalledTimes(1);
    expect(handleAgentEnroll.mock.calls[0]?.[0]).toMatchObject({
      token: ENROLLMENT_TOKEN,
    });
    expect(handleTachoEnroll).not.toHaveBeenCalled();
  });

  // The prefix, not the presence of a token: `--token` means a platform API
  // token on the host-scoped side, and an operator pastes whichever they hold.
  it("sends any other token to the session path (negative)", async () => {
    await run("agent", "enroll", "--token", "oxp_live_not_an_enrollment_token");
    expect(handleTachoEnroll).toHaveBeenCalledTimes(1);
    expect(handleAgentEnroll).not.toHaveBeenCalled();
  });

  it("sends a call with no token to the session path (negative)", async () => {
    await run("agent", "enroll");
    expect(handleTachoEnroll).toHaveBeenCalledTimes(1);
    expect(handleAgentEnroll).not.toHaveBeenCalled();
  });

  it("carries the shared flags through to the registered-agent path", async () => {
    await run(
      "agent",
      "enroll",
      "--token",
      ENROLLMENT_TOKEN,
      "--harness",
      "codex,cursor",
      "--port",
      "7788",
      "--no-service",
      "--force",
    );
    expect(handleAgentEnroll.mock.calls[0]?.[0]).toEqual({
      token: ENROLLMENT_TOKEN,
      harness: "codex,cursor",
      port: 7788,
      service: false,
      force: true,
    });
  });

  it("refuses a host-only flag against an enrollment token rather than dropping it (negative)", async () => {
    await run("agent", "enroll", "--token", ENROLLMENT_TOKEN, "--managed");
    expect(handleAgentEnroll).not.toHaveBeenCalled();
    expect(handleTachoEnroll).not.toHaveBeenCalled();
    expect(stderr).toContain("--managed");
    expect(stderr).toContain("oxagen agent enroll");
    expect(process.exitCode).toBe(1);
  });

  it("carries --allow-root to the enroll on both paths, and to reassign", async () => {
    await run("agent", "enroll", "--allow-root");
    expect(handleTachoEnroll.mock.calls[0]?.[0]).toMatchObject({
      allowRoot: true,
    });
    program = buildProgram().exitOverride();
    await run("agent", "enroll", "--token", ENROLLMENT_TOKEN, "--allow-root");
    expect(handleAgentEnroll.mock.calls[0]?.[0]).toMatchObject({
      allowRoot: true,
    });
    program = buildProgram().exitOverride();
    await run("agent", "reassign", "--workspace", "edge", "--allow-root");
    expect(handleTachoReassign.mock.calls[0]?.[0]).toMatchObject({
      workspace: "edge",
      allowRoot: true,
    });
    program = buildProgram().exitOverride();
    await run("tacho", "enroll", "--allow-root");
    expect(handleTachoEnroll.mock.calls[1]?.[0]).toMatchObject({
      allowRoot: true,
    });
  });

  it("names every refused flag, not just the first (negative)", async () => {
    await run(
      "agent",
      "enroll",
      "--token",
      ENROLLMENT_TOKEN,
      "--managed",
      "--verify",
    );
    expect(stderr).toContain("--managed and --verify");
    expect(stderr).toContain("do not apply");
  });
});

describe("oxagen agent status", () => {
  it("reports this machine when no agent is named", async () => {
    await run("agent", "status");
    expect(handleTachoStatus).toHaveBeenCalledTimes(1);
    expect(agentStatus).not.toHaveBeenCalled();
  });

  it("reports the named agent when one is given", async () => {
    await run("agent", "status", "deploy-bot", "--json");
    expect(agentStatus).toHaveBeenCalledWith("deploy-bot", { json: true });
    expect(handleTachoStatus).not.toHaveBeenCalled();
  });
});

describe("oxagen agent unenroll", () => {
  it("unenrolls this machine when no agent is named", async () => {
    await run("agent", "unenroll", "--purge", "--reason", "decommissioned");
    expect(handleTachoUnenroll).toHaveBeenCalledTimes(1);
    expect(handleTachoUnenroll.mock.calls[0]?.[0]).toMatchObject({
      purge: true,
      reason: "decommissioned",
    });
    expect(agentUnenroll).not.toHaveBeenCalled();
  });

  it("revokes the named agent's hosts when one is given", async () => {
    await run("agent", "unenroll", "deploy-bot", "--host", "tch_123");
    expect(agentUnenroll).toHaveBeenCalledTimes(1);
    expect(agentUnenroll.mock.calls[0]?.[0]).toBe("deploy-bot");
    expect(handleTachoUnenroll).not.toHaveBeenCalled();
  });

  it("refuses an agent-scoped flag against this machine (negative)", async () => {
    await run("agent", "unenroll", "--host", "tch_123");
    expect(handleTachoUnenroll).not.toHaveBeenCalled();
    expect(stderr).toContain("--host");
    expect(process.exitCode).toBe(1);
  });

  it("refuses a host-scoped flag against a named agent (negative)", async () => {
    await run("agent", "unenroll", "deploy-bot", "--purge");
    expect(agentUnenroll).not.toHaveBeenCalled();
    expect(stderr).toContain("--purge");
    expect(process.exitCode).toBe(1);
  });

  it("names one of this machine's agents by its harness, or all of them (ADR-203)", async () => {
    await run("agent", "unenroll", "--harness", "codex");
    expect(handleTachoUnenroll.mock.calls[0]?.[0]).toMatchObject({
      harness: "codex",
    });
    // Commander keeps a parsed option on the command, so a second parse
    // gets a fresh program.
    program = buildProgram().exitOverride();
    await run("agent", "unenroll", "--all");
    expect(handleTachoUnenroll.mock.calls[1]?.[0]).toMatchObject({
      all: true,
    });
    expect(agentUnenroll).not.toHaveBeenCalled();
  });

  it("refuses --harness and --all against a named agent (negative)", async () => {
    await run("agent", "unenroll", "deploy-bot", "--harness", "codex", "--all");
    expect(agentUnenroll).not.toHaveBeenCalled();
    expect(stderr).toContain("--harness and --all do not apply");
    expect(process.exitCode).toBe(1);
  });
});

describe("oxagen agent uninstall", () => {
  it("unenrolls this machine and removes what the desktop app put here (ADR-230)", async () => {
    await run("agent", "uninstall", "--reason", "laptop returned");
    expect(handleTachoUninstall).toHaveBeenCalledTimes(1);
    expect(handleTachoUninstall.mock.calls[0]?.[0]).toMatchObject({
      reason: "laptop returned",
    });
    expect(handleTachoUnenroll).not.toHaveBeenCalled();
    expect(agentUnenroll).not.toHaveBeenCalled();
  });

  it("exits 1 when something stays on the machine (negative)", async () => {
    handleTachoUninstall.mockResolvedValueOnce(false);
    await run("agent", "uninstall");
    expect(process.exitCode).toBe(1);
  });
});

describe("oxagen agent run, detect, and verify", () => {
  it("hands everything after -- to the session, with its flags", async () => {
    handleAgentRun.mockResolvedValueOnce(7);
    await run(
      "agent",
      "run",
      "--name",
      "release-bot",
      "--",
      "./release-bot",
      "--dry-run",
    );
    expect(handleAgentRun).toHaveBeenCalledTimes(1);
    expect(handleAgentRun.mock.calls[0]?.[0]).toEqual([
      "./release-bot",
      "--dry-run",
    ]);
    expect(handleAgentRun.mock.calls[0]?.[1]).toMatchObject({
      name: "release-bot",
    });
    // The agent's exit code is the command's.
    expect(process.exitCode).toBe(7);
  });

  it("carries the contained launcher's flags", async () => {
    await run(
      "agent",
      "run",
      "--contained",
      "--image",
      "ghcr.io/acme/contained:1",
      "--workspace",
      "/repo",
      "--github-repository",
      "acme/app",
      "--",
      "claude",
      "-p",
      "fix the build",
    );
    expect(handleAgentRun.mock.calls[0]?.[0]).toEqual([
      "claude",
      "-p",
      "fix the build",
    ]);
    expect(handleAgentRun.mock.calls[0]?.[1]).toMatchObject({
      contained: true,
      image: "ghcr.io/acme/contained:1",
      workspace: "/repo",
      githubRepository: "acme/app",
    });
  });

  it("passes an empty command on, for the recorder to refuse with the form", async () => {
    await run("agent", "run");
    expect(handleAgentRun.mock.calls[0]?.[0]).toEqual([]);
  });

  it("detects this machine's harnesses", async () => {
    await run("agent", "detect", "--json");
    expect(handleAgentDetect).toHaveBeenCalledWith({ json: true });
  });

  it("verifies the named harness, with the result as JSON", async () => {
    await run("agent", "verify", "--harness", "codex", "--json");
    expect(handleTachoVerify).toHaveBeenCalledWith({
      harness: "codex",
      json: true,
    });
  });
});

// The hidden group keeps the exact shape every enrolled machine was enrolled
// with. It does not forward to the merged commands: a forwarded `tacho
// enroll` would be re-parsed by a command with different flags, which is a
// behaviour change dressed up as compatibility.
describe("the hidden tacho group still runs the host-scoped commands", () => {
  it("enrolls this machine, saying once on stderr which command replaced it", async () => {
    await run("tacho", "enroll");
    expect(handleTachoEnroll).toHaveBeenCalledTimes(1);
    expect(handleAgentEnroll).not.toHaveBeenCalled();
    expect(stderr).toBe(
      "`oxagen tacho enroll` is now `oxagen agent enroll`. The old name still works.\n",
    );
  });

  // #4879: every alias names its own replacement, not just the group's.
  it.each([
    "enroll",
    "status",
    "reassign",
    "unenroll",
    "export",
    "verify",
    "hosts",
  ])(
    "names the command that replaced `oxagen tacho %s`",
    async (verb) => {
      await run("tacho", verb);
      expect(stderr).toBe(
        `\`oxagen tacho ${verb}\` is now \`oxagen agent ${verb}\`. The old name still works.\n`,
      );
      expect(process.exitCode ?? 0).toBe(0);
    },
  );

  it("takes no agent argument, so it cannot reach the server-scoped read (negative)", async () => {
    await run("tacho", "status");
    expect(handleTachoStatus).toHaveBeenCalledTimes(1);
    expect(agentStatus).not.toHaveBeenCalled();
  });

  it("unenrolls one agent by its harness, or every agent (ADR-203)", async () => {
    await run("tacho", "unenroll", "--harness", "codex");
    expect(handleTachoUnenroll.mock.calls[0]?.[0]).toMatchObject({
      harness: "codex",
    });
    // Commander keeps a parsed option on the command, so a second parse
    // gets a fresh program.
    program = buildProgram().exitOverride();
    await run("tacho", "unenroll", "--all");
    expect(handleTachoUnenroll.mock.calls[1]?.[0]).toMatchObject({
      all: true,
    });
  });
});
