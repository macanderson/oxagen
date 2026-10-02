/**
 * `oxagen work list` and `oxagen work start` (P1-04, ADR-250). The control
 * plane and the spawn are stand-ins, so nothing here starts a process or
 * sends a request.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { ControlError, ControlUnreachable } from "../host/control-client";
import { writeHostFile } from "../host/host-file";
import { agentPaths, homeOf } from "../host/paths";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { keepWorkOrder, readWorkOrder } from "../host/work-orders";
import type { TachoHarness, WorkOrderClaimResponse } from "../wire";
import type { AgentExit } from "./agent-run";
import { type WorkCommandDeps, workList, workStart } from "./work";

const WO = "wo_01j9k2m3n4";
const PROMPT =
  "Work order wo_01j9k2m3n4 for acme/platform#612, brief revision 2.";

function claimFor(harness: string, repeat = false): WorkOrderClaimResponse {
  return {
    repeat,
    work_order: {
      id: WO,
      key: "wi_7f3a:r2:s1",
      send: 1,
      item_id: "wi_7f3a",
      item_number: "acme/platform#612",
      brief_revision: 2,
      repository: "acme/platform",
      agent_id: "agt_1",
      harness,
    },
    prompt: PROMPT,
  };
}

function machine(
  options: { enrolled?: boolean; harnesses?: TachoHarness[] } = {},
) {
  const paths = scratchPaths("linux");
  if (options.enrolled !== false) {
    const signer = bundleSigner();
    mkdirSync(dirname(paths.hostFile), { recursive: true });
    writeHostFile(
      paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle()), {
        harnesses: options.harnesses ?? ["claude-code"],
      }),
    );
  }
  const out: string[] = [];
  const errors: string[] = [];
  const claims: string[] = [];
  const rejects: Array<{ id: string; reason: string }> = [];
  const spawned: Array<{
    command: string;
    args: string[];
    env: Record<string, string | undefined>;
    cwd: string;
  }> = [];
  /** Whether the order still waited while each harness ran. */
  const waitingWhileRunning: boolean[] = [];
  let claim: () => Promise<WorkOrderClaimResponse> = async () =>
    claimFor("claude-code");
  let exit: AgentExit = { code: 0, signal: null };
  const deps: WorkCommandDeps = {
    paths,
    env: { PATH: "/usr/bin" },
    fetch: async () => {
      throw new Error("no request should be sent");
    },
    out: (line) => out.push(line),
    err: (line) => errors.push(line),
    cwd: "/work/platform",
    spawnAgent: async (command, args, opts) => {
      spawned.push({ command, args, env: opts.env, cwd: opts.cwd });
      // A process that starts reports it before it exits.
      if (exit.error === undefined) {
        opts.onSpawn?.();
        waitingWhileRunning.push(readWorkOrder(paths, WO) !== undefined);
      }
      return exit;
    },
    workOrderClient: () => ({
      claimWorkOrder: async (id) => {
        claims.push(id);
        return claim();
      },
      rejectWorkOrder: async (id, reason) => {
        rejects.push({ id, reason });
        return { repeat: false };
      },
    }),
  };
  return {
    paths,
    deps,
    out,
    errors,
    claims,
    rejects,
    spawned,
    waitingWhileRunning,
    answer: (next: () => Promise<WorkOrderClaimResponse>) => {
      claim = next;
    },
    exit: (next: AgentExit) => {
      exit = next;
    },
    keep: (id = WO) =>
      keepWorkOrder(paths, {
        command_id: "tcmd_1",
        work_order: id,
        key: "wi_7f3a:r2:s1",
        item: "wi_7f3a",
        received_at: "2026-10-02T10:00:05.000Z",
      }),
  };
}

describe("oxagen work list", () => {
  it("says none are waiting when the directory is empty", () => {
    const m = machine();
    expect(workList(m.deps)).toBe(0);
    expect(m.out).toEqual(["No work orders are waiting on this machine."]);
  });

  it("prints each waiting order with its item, time, and key", () => {
    const m = machine();
    m.keep();
    expect(workList(m.deps)).toBe(0);
    expect(m.out[0]).toBe("1 work order is waiting on this machine:");
    expect(m.out[1]).toBe(
      `  ${WO}  item wi_7f3a  received 2026-10-02T10:00:05.000Z  key wi_7f3a:r2:s1`,
    );
    expect(m.out[2]).toMatch(/oxagen work start <work order>/);
  });

  it("refuses on a machine that is not enrolled (negative)", () => {
    const m = machine({ enrolled: false });
    expect(workList(m.deps)).toBe(1);
    expect(m.errors[0]).toMatch(/not enrolled.*oxagen agent enroll/);
  });
});

describe("oxagen work start", () => {
  it("claims the order, then starts the harness with the prompt and the order in its environment", async () => {
    const m = machine();
    m.keep();
    m.exit({ code: 4, signal: null });
    expect(await workStart(WO, m.deps)).toBe(4);
    expect(m.claims).toEqual([WO]);
    expect(m.spawned).toEqual([
      {
        command: "claude",
        args: [PROMPT],
        env: { PATH: "/usr/bin", OXAGEN_WORK_ORDER_ID: WO },
        cwd: "/work/platform",
      },
    ]);
    expect(m.rejects).toEqual([]);
    // The harness started, so the order stopped waiting before it exited.
    expect(m.waitingWhileRunning).toEqual([false]);
    expect(readWorkOrder(m.paths, WO)).toBeUndefined();
    expect(m.errors.at(-1)).toBe(
      `Claimed ${WO} for acme/platform#612 in acme/platform. Starting Claude Code in /work/platform.`,
    );
  });

  it.each([
    ["codex", "codex", [PROMPT]],
    ["cursor", "cursor-agent", [PROMPT]],
    ["stella", "stella", ["run", PROMPT]],
  ] as const)(
    "starts %s as %s with the prompt as its first prompt",
    async (harness, binary, args) => {
      const m = machine({ harnesses: [harness] });
      m.keep();
      m.answer(async () => claimFor(harness));
      expect(await workStart(WO, m.deps)).toBe(0);
      expect(m.spawned[0]?.command).toBe(binary);
      expect(m.spawned[0]?.args).toEqual(args);
      expect(m.spawned[0]?.env["OXAGEN_WORK_ORDER_ID"]).toBe(WO);
    },
  );

  it("claims with the only live agent when the daemon has not kept the order yet", async () => {
    const m = machine();
    expect(await workStart(WO, m.deps)).toBe(0);
    expect(m.claims).toEqual([WO]);
    expect(m.spawned).toHaveLength(1);
  });

  it("says a repeated claim links only the first run", async () => {
    const m = machine();
    m.answer(async () => claimFor("claude-code", true));
    await workStart(WO, m.deps);
    expect(m.errors[0]).toBe(
      `This machine had already claimed ${WO}. Only the first run that starts for it is linked to it.`,
    );
  });

  it.each([
    [
      "a withdrawn send",
      409,
      "conflict",
      "This send was withdrawn. Ask the person who sent it to send it again.",
    ],
    [
      "a run that already started",
      409,
      "not_allowed",
      "Run tse_01j9 already started for send 1. This host must not start another.",
    ],
    [
      "another host's order",
      403,
      "forbidden",
      "This work order was sent to another host.",
    ],
    ["a busy server", 429, "rate_limited", "Too many requests."],
  ])(
    "prints the server's refusal for %s, starts nothing, claims once, and keeps the order (negative)",
    async (_, status, code, message) => {
      const m = machine();
      m.keep();
      m.answer(async () => {
        throw new ControlError(
          status,
          JSON.stringify({ error: { code, message } }),
        );
      });
      expect(await workStart(WO, m.deps)).toBe(1);
      expect(m.claims).toEqual([WO]);
      expect(m.spawned).toEqual([]);
      expect(m.rejects).toEqual([]);
      expect(m.errors).toEqual([
        `Oxagen refused the claim on ${WO}, so nothing started. ${message}`,
      ]);
      expect(readWorkOrder(m.paths, WO)).toBeDefined();
    },
  );

  it("keeps the order and starts nothing when Oxagen cannot be reached (negative)", async () => {
    const m = machine();
    m.keep();
    m.answer(async () => {
      throw new ControlUnreachable(new Error("ECONNREFUSED"));
    });
    expect(await workStart(WO, m.deps)).toBe(1);
    expect(m.spawned).toEqual([]);
    expect(m.errors[0]).toMatch(/Could not reach Oxagen to claim/);
    expect(readWorkOrder(m.paths, WO)).toBeDefined();
  });

  it("refuses an order for a harness this agent does not wrap (negative)", async () => {
    const m = machine();
    m.keep();
    m.answer(async () => claimFor("codex"));
    expect(await workStart(WO, m.deps)).toBe(1);
    expect(m.spawned).toEqual([]);
    expect(m.rejects).toEqual([
      {
        id: WO,
        reason:
          "This machine does not wrap Codex, so it cannot start this work order.",
      },
    ]);
    // Nothing started, so the order still shows in `oxagen work list`.
    expect(readWorkOrder(m.paths, WO)).toBeDefined();
  });

  it("refuses an order for a harness no host wraps (negative)", async () => {
    // Claude Desktop is connected, not wrapped: it has no hooks to record a run.
    const m = machine();
    m.answer(async () => claimFor("claude-desktop"));
    expect(await workStart(WO, m.deps)).toBe(1);
    expect(m.spawned).toEqual([]);
    expect(m.rejects[0]?.reason).toBe(
      "This machine does not wrap Claude Desktop, so it cannot start this work order.",
    );
  });

  it("names a harness it has never heard of as the server sent it (negative)", async () => {
    const m = machine();
    m.answer(async () => claimFor("aider"));
    expect(await workStart(WO, m.deps)).toBe(1);
    expect(m.rejects[0]?.reason).toBe(
      "This machine does not wrap aider, so it cannot start this work order.",
    );
  });

  it("refuses the order when the harness command is not installed (negative)", async () => {
    const m = machine();
    m.keep();
    m.exit({
      code: null,
      signal: null,
      error: Object.assign(new Error("spawn claude ENOENT"), {
        code: "ENOENT",
      }),
    });
    expect(await workStart(WO, m.deps)).toBe(1);
    expect(m.rejects).toEqual([
      {
        id: WO,
        reason: "The claude command is not installed on this machine.",
      },
    ]);
    expect(m.errors.at(-1)).toBe(
      "The claude command is not installed on this machine. Oxagen has ended this send, and the work item can be sent again.",
    );
    expect(readWorkOrder(m.paths, WO)).toBeDefined();
  });

  it("keeps the claim and the order when the harness fails to start for another reason (negative)", async () => {
    const m = machine();
    m.keep();
    m.exit({
      code: null,
      signal: null,
      error: Object.assign(new Error("spawn claude EACCES"), {
        code: "EACCES",
      }),
    });
    expect(await workStart(WO, m.deps)).toBe(1);
    expect(m.rejects).toEqual([]);
    expect(readWorkOrder(m.paths, WO)).toBeDefined();
    expect(m.errors.at(-1)).toMatch(
      new RegExp(`run \`oxagen work start ${WO}\` again`),
    );
  });

  it("refuses an id that is not a work order id (negative)", async () => {
    const m = machine();
    expect(await workStart("wi_7f3a", m.deps)).toBe(2);
    expect(m.claims).toEqual([]);
  });

  it("refuses on a machine that is not enrolled (negative)", async () => {
    const m = machine({ enrolled: false });
    expect(await workStart(WO, m.deps)).toBe(1);
    expect(m.claims).toEqual([]);
    expect(m.errors[0]).toMatch(/not enrolled/);
  });

  it("claims with the agent that keeps the order when the machine holds two", async () => {
    const m = machine();
    const signer = bundleSigner();
    const second = agentPaths(homeOf(m.paths), "z9y8x7w6");
    mkdirSync(dirname(second.hostFile), { recursive: true });
    writeHostFile(
      second.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle()), {
        host_enrollment_id: "tch_zzzzzzzzzzzzzzzzzzzzzz",
        agent_key: "acme.core.codex-agent",
        harnesses: ["codex"],
        enrolled_at: "2026-09-11T00:00:00.000Z",
      }),
    );
    keepWorkOrder(second, {
      command_id: "tcmd_2",
      work_order: WO,
      key: "wi_7f3a:r2:s1",
      item: "wi_7f3a",
      received_at: "2026-10-02T10:00:05.000Z",
    });
    const hosts: string[] = [];
    const base = m.deps.workOrderClient;
    m.answer(async () => claimFor("codex"));
    const deps: WorkCommandDeps = {
      ...m.deps,
      workOrderClient: (host) => {
        hosts.push(host.host_enrollment_id);
        if (base === undefined) throw new Error("no client");
        return base(host);
      },
    };
    expect(await workStart(WO, deps)).toBe(0);
    expect(hosts).toEqual(["tch_zzzzzzzzzzzzzzzzzzzzzz"]);
    expect(m.spawned[0]?.command).toBe("codex");
  });

  it("refuses an order no agent keeps when the machine holds two (negative)", async () => {
    const m = machine();
    const signer = bundleSigner();
    const second = agentPaths(homeOf(m.paths), "z9y8x7w6");
    mkdirSync(dirname(second.hostFile), { recursive: true });
    writeHostFile(
      second.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle()), {
        host_enrollment_id: "tch_zzzzzzzzzzzzzzzzzzzzzz",
        harnesses: ["codex"],
      }),
    );
    expect(await workStart(WO, m.deps)).toBe(1);
    expect(m.claims).toEqual([]);
    expect(m.errors[0]).toBe(
      `Work order ${WO} is not waiting on this machine. Run \`oxagen work list\` to see the ones that are.`,
    );
  });
});
