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

const {
  handleTachoEnroll,
  handleTachoStatus,
  handleTachoUnenroll,
  handleAgentEnroll,
  agentStatus,
  agentUnenroll,
} = vi.hoisted(() => ({
  handleTachoEnroll: vi.fn<HostHandler>(async () => true),
  handleTachoStatus: vi.fn<HostHandler>(async () => true),
  handleTachoUnenroll: vi.fn<HostHandler>(async () => true),
  handleAgentEnroll: vi.fn<HostHandler>(async () => true),
  agentStatus: vi.fn<AgentHandler>(async () => undefined),
  agentUnenroll: vi.fn<AgentHandler>(async () => undefined),
}));

vi.mock("../commands/tacho.js", () => ({
  handleTachoEnroll,
  handleTachoStatus,
  handleTachoUnenroll,
  handleTachoReassign: vi.fn(async () => true),
  handleTachoExport: vi.fn(async () => true),
  handleTachoVerify: vi.fn(async () => true),
  handleTachoHosts: vi.fn(async () => true),
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

  it("names one of this machine's agents by its harness, or all of them (ADR-202)", async () => {
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

// The deprecated group keeps the exact shape every enrolled machine was
// enrolled with. It does not forward to the merged commands: a forwarded
// `tacho enroll` would be re-parsed by a command with different flags, which is
// a behaviour change dressed up as compatibility.
describe("the deprecated tacho group still runs the host-scoped commands", () => {
  it("enrolls this machine, warning once on stderr", async () => {
    await run("tacho", "enroll");
    expect(handleTachoEnroll).toHaveBeenCalledTimes(1);
    expect(handleAgentEnroll).not.toHaveBeenCalled();
    expect(stderr).toContain("`oxagen agent`");
  });

  it("takes no agent argument, so it cannot reach the server-scoped read (negative)", async () => {
    await run("tacho", "status");
    expect(handleTachoStatus).toHaveBeenCalledTimes(1);
    expect(agentStatus).not.toHaveBeenCalled();
  });

  it("unenrolls one agent by its harness, or every agent (ADR-202)", async () => {
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
