/**
 * `oxagen work list`, `oxagen work start`, and `oxagen work claim` (P1-04,
 * ADR-251). The control plane and the spawn are stand-ins, so nothing here
 * starts a harness or sends a request. `gitHeadIn` runs git in a scratch
 * repository.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import {
  keepWorkOrder,
  markWorkOrderRunning,
  readRunningWorkOrder,
  readWorkOrder,
  runningWorkOrder,
} from "../host/work-orders";
import type {
  TachoHarness,
  WorkCriterionClaimRequest,
  WorkCriterionClaimResponse,
  WorkOrderClaimResponse,
} from "../wire";
import type { AgentExit } from "./agent-run";
import {
  gitHeadIn,
  type WorkCommandDeps,
  workClaim,
  workList,
  workStart,
} from "./work";

const WO = "wo_01j9k2m3n4";
const PROMPT =
  "Work order wo_01j9k2m3n4 for acme/platform#612, brief revision 2.";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

function criterionAnswer(repeat = false): WorkCriterionClaimResponse {
  return {
    repeat,
    claim: { criterion_id: "c2", head_sha: HEAD, run_id: "tse_01j9" },
  };
}

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
  const criterionClaims: WorkCriterionClaimRequest[] = [];
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
  let criterionClaim: () => Promise<WorkCriterionClaimResponse> = async () =>
    criterionAnswer();
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
      claimWorkCriterion: async (input) => {
        criterionClaims.push(input);
        return criterionClaim();
      },
    }),
    gitHead: () => HEAD,
  };
  return {
    paths,
    deps,
    out,
    errors,
    claims,
    rejects,
    criterionClaims,
    spawned,
    waitingWhileRunning,
    answer: (next: () => Promise<WorkOrderClaimResponse>) => {
      claim = next;
    },
    answerCriterion: (next: () => Promise<WorkCriterionClaimResponse>) => {
      criterionClaim = next;
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

  it("refuses a second start while this machine's first harness for the order still runs (negative)", async () => {
    const m = machine();
    m.keep();
    let second: number | undefined;
    let markedWhileRunning = false;
    let markedItem: string | undefined;
    m.deps.spawnAgent = async (command, args, opts) => {
      m.spawned.push({ command, args, env: opts.env, cwd: opts.cwd });
      opts.onSpawn?.();
      markedWhileRunning = runningWorkOrder(m.paths, WO) !== undefined;
      markedItem = runningWorkOrder(m.paths, WO)?.item;
      second = await workStart(WO, m.deps);
      return { code: 0, signal: null };
    };
    expect(await workStart(WO, m.deps)).toBe(0);
    expect(markedWhileRunning).toBe(true);
    // The mark names the claim's work item, for `oxagen work claim`.
    expect(markedItem).toBe("wi_7f3a");
    expect(second).toBe(1);
    expect(m.claims).toEqual([WO]);
    expect(m.spawned).toHaveLength(1);
    expect(m.errors).toContain(
      `A harness for ${WO} is already running on this machine (process ${process.pid}), so nothing else started. Wait for it to end, or stop the run from the work item.`,
    );
    // The mark goes when the harness ends, so a later start may claim again.
    expect(runningWorkOrder(m.paths, WO)).toBeUndefined();
  });

  it("starts again when the process that marked the order running is gone", async () => {
    const m = machine();
    markWorkOrderRunning(m.paths, WO, 424242, "2026-10-03T09:00:00.000Z");
    m.deps.processIsAlive = () => false;
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
  ] as const)(
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

describe("oxagen work claim", () => {
  const TEXT = "The invite test covers an expired link.";

  const STARTED = "2026-10-03T09:00:00.000Z";

  /**
   * A machine inside the run of WO: the variable is set and the mark is
   * written. `null` writes a mark with no item, as an older start did.
   */
  function inRun(item: string | null = "wi_7f3a") {
    const m = machine();
    m.deps.env = { ...m.deps.env, OXAGEN_WORK_ORDER_ID: WO };
    markWorkOrderRunning(m.paths, WO, process.pid, STARTED, item ?? undefined);
    return m;
  }

  function refusal(status: number, error: Record<string, string>) {
    return async (): Promise<WorkCriterionClaimResponse> => {
      throw new ControlError(status, JSON.stringify({ error }));
    };
  }

  it("sends the item from the mark, the order from the environment, and the head commit", async () => {
    const m = inRun();
    const heads: string[] = [];
    m.deps.gitHead = (cwd) => {
      heads.push(cwd);
      return HEAD;
    };
    expect(await workClaim("c2", { text: `  ${TEXT}\n` }, m.deps)).toBe(0);
    expect(heads).toEqual(["/work/platform"]);
    expect(m.criterionClaims).toEqual([
      {
        item_id: "wi_7f3a",
        work_order_id: WO,
        criterion_id: "c2",
        head_sha: HEAD,
        text: TEXT,
      },
    ]);
    expect(m.claims).toEqual([]);
    expect(m.out).toEqual([
      `Claimed c2 at commit 0123456 for ${WO}. A person still checks each criterion and decides.`,
    ]);
    expect(m.errors).toEqual([]);
  });

  it("claims from inside a run that oxagen work start started", async () => {
    const m = machine();
    m.keep();
    let inside: number | undefined;
    m.deps.spawnAgent = async (_command, _args, opts) => {
      opts.onSpawn?.();
      // The agent runs the command in the harness, with the harness's environment.
      inside = await workClaim(
        "c1",
        { text: TEXT },
        { ...m.deps, env: opts.env },
      );
      return { code: 0, signal: null };
    };
    expect(await workStart(WO, m.deps)).toBe(0);
    expect(inside).toBe(0);
    expect(m.criterionClaims[0]).toMatchObject({
      item_id: "wi_7f3a",
      work_order_id: WO,
      criterion_id: "c1",
    });
    // The mark goes with the harness, so a later claim has no run to name.
    expect(readRunningWorkOrder(m.paths, WO)).toBeUndefined();
  });

  it("says when Oxagen already had the claim", async () => {
    const m = inRun();
    m.answerCriterion(async () => criterionAnswer(true));
    expect(await workClaim("c2", { text: TEXT }, m.deps)).toBe(0);
    expect(m.out).toEqual([
      "Oxagen already had this claim on c2 at commit 0123456, so nothing new was recorded. The first text stands.",
    ]);
  });

  it("refuses outside a work order's run, before it reads anything else (negative)", async () => {
    const m = machine();
    markWorkOrderRunning(m.paths, WO, process.pid, STARTED, "wi_7f3a");
    expect(await workClaim("c2", { text: TEXT }, m.deps)).toBe(1);
    expect(m.criterionClaims).toEqual([]);
    expect(m.errors).toEqual([
      "OXAGEN_WORK_ORDER_ID is not set, so this shell is not a work order's run. Run `oxagen work claim` from inside the run that `oxagen work start` started.",
    ]);
  });

  it("refuses when no run of the order is marked on this machine (negative)", async () => {
    const m = machine();
    m.deps.env = { ...m.deps.env, OXAGEN_WORK_ORDER_ID: WO };
    expect(await workClaim("c2", { text: TEXT }, m.deps)).toBe(1);
    expect(m.criterionClaims).toEqual([]);
    expect(m.errors).toEqual([
      `No run of ${WO} is running on this machine. Run \`oxagen work claim\` from inside the work order's run, which \`oxagen work start ${WO}\` starts.`,
    ]);
  });

  it("refuses a mark an older start wrote without the work item (negative)", async () => {
    const m = inRun(null);
    expect(await workClaim("c2", { text: TEXT }, m.deps)).toBe(1);
    expect(m.criterionClaims).toEqual([]);
    expect(m.errors[0]).toMatch(/does not record its work item/);
  });

  it("leaves an item out of the mark when it is not a work item id (negative)", () => {
    const m = machine();
    markWorkOrderRunning(m.paths, WO, process.pid, STARTED, "not-an-item");
    const mark = readRunningWorkOrder(m.paths, WO);
    // The mark still reads, so it still guards a second start.
    expect(mark?.pid).toBe(process.pid);
    expect(mark?.item).toBeUndefined();
  });

  it("refuses when the checkout has no head commit (negative)", async () => {
    const m = inRun();
    m.deps.gitHead = () => undefined;
    expect(await workClaim("c2", { text: TEXT }, m.deps)).toBe(1);
    expect(m.criterionClaims).toEqual([]);
    expect(m.errors[0]).toMatch(
      /Could not read the head commit in \/work\/platform\./,
    );
  });

  it("refuses on a machine that is not enrolled (negative)", async () => {
    const m = machine({ enrolled: false });
    m.deps.env = { ...m.deps.env, OXAGEN_WORK_ORDER_ID: WO };
    expect(await workClaim("c2", { text: TEXT }, m.deps)).toBe(1);
    expect(m.errors[0]).toMatch(/not enrolled/);
  });

  it.each([["2"], ["C2"], ["c0"], ["criterion-2"]])(
    "refuses %s, which is not a criterion id, before it sends anything (negative)",
    async (id) => {
      const m = inRun();
      expect(await workClaim(id, { text: TEXT }, m.deps)).toBe(2);
      expect(m.criterionClaims).toEqual([]);
      expect(m.errors[0]).toMatch(/is not a criterion id/);
    },
  );

  it.each([["   "], ["x".repeat(2001)]])(
    "refuses text Oxagen does not take %#, before it sends anything (negative)",
    async (text) => {
      const m = inRun();
      expect(await workClaim("c2", { text }, m.deps)).toBe(2);
      expect(m.criterionClaims).toEqual([]);
      expect(m.errors).toEqual([
        "Say how you met c2 with --text, in 1 to 2000 characters.",
      ]);
    },
  );

  it("says to push the commit first when Oxagen has another head (negative)", async () => {
    const m = inRun();
    m.answerCriterion(
      refusal(409, {
        code: "conflict",
        reason: "stale_head",
        message:
          "You named 0123456, and the pull request's head is now 89abcde. Claim on the current head.",
      }),
    );
    expect(await workClaim("c2", { text: TEXT }, m.deps)).toBe(1);
    expect(m.criterionClaims).toHaveLength(1);
    expect(m.out).toEqual([]);
    expect(m.errors).toEqual([
      "Oxagen refused the claim on c2 at commit 0123456, so nothing was recorded. You named 0123456, and the pull request's head is now 89abcde. Claim on the current head. Push commit 0123456 to the pull request first, then claim again.",
    ]);
  });

  it("names the criterion when the brief has no such criterion (negative)", async () => {
    const m = inRun();
    m.answerCriterion(
      refusal(400, {
        code: "bad_request",
        message: 'The brief of send 1 has no criterion "c9".',
      }),
    );
    expect(await workClaim("c9", { text: TEXT }, m.deps)).toBe(1);
    expect(m.errors).toEqual([
      'Oxagen refused the claim on c9, so nothing was recorded. The brief of send 1 has no criterion "c9". Name a criterion from the brief in your first prompt, such as c1.',
    ]);
  });

  it.each([
    [
      "another host's send",
      403,
      "forbidden",
      "forbidden",
      "This host did not claim send 1. Only the host running the send can claim a criterion.",
    ],
    [
      "a send that is over",
      409,
      "conflict",
      "not_allowed",
      "Send 1 is over. A claim needs an open send.",
    ],
    [
      "a work item that moved on",
      409,
      "conflict",
      "stale_revision",
      "Send 1 went out on revision 2, and the work item is now at revision 3. A claim counts only on the revision the send carries.",
    ],
  ] as const)(
    "prints the server's refusal for %s (negative)",
    async (_, status, code, reason, message) => {
      const m = inRun();
      m.answerCriterion(refusal(status, { code, reason, message }));
      expect(await workClaim("c2", { text: TEXT }, m.deps)).toBe(1);
      expect(m.errors).toEqual([
        `Oxagen refused the claim on c2, so nothing was recorded. ${message}`,
      ]);
    },
  );

  it("records nothing and says to run it again when Oxagen cannot be reached (negative)", async () => {
    const m = inRun();
    m.answerCriterion(async () => {
      throw new ControlUnreachable(new Error("ECONNREFUSED"));
    });
    expect(await workClaim("c2", { text: TEXT }, m.deps)).toBe(1);
    expect(m.errors).toEqual([
      "Could not reach Oxagen to claim c2, so nothing was recorded. Run this command again once this machine is online. (control plane unreachable: ECONNREFUSED)",
    ]);
  });

  it("says to run it again when Oxagen's answer does not read (negative)", async () => {
    const m = inRun();
    m.answerCriterion(async () => {
      throw new Error("Expected boolean, received string");
    });
    expect(await workClaim("c2", { text: TEXT }, m.deps)).toBe(1);
    expect(m.errors[0]).toMatch(
      /^Could not read Oxagen's answer to the claim on c2\. Run this command again\./,
    );
  });

  it("claims with the agent whose directory holds the mark when the machine holds two", async () => {
    const m = machine();
    m.deps.env = { ...m.deps.env, OXAGEN_WORK_ORDER_ID: WO };
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
    markWorkOrderRunning(second, WO, process.pid, STARTED, "wi_7f3a");
    const hosts: string[] = [];
    const base = m.deps.workOrderClient;
    const deps: WorkCommandDeps = {
      ...m.deps,
      workOrderClient: (host) => {
        hosts.push(host.host_enrollment_id);
        if (base === undefined) throw new Error("no client");
        return base(host);
      },
    };
    expect(await workClaim("c2", { text: TEXT }, deps)).toBe(0);
    expect(hosts).toEqual(["tch_zzzzzzzzzzzzzzzzzzzzzz"]);
  });
});

describe("gitHeadIn", () => {
  it("reads the commit checked out in a repository, and nothing before the first commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "oxagen-work-claim-"));
    try {
      const git = (...args: string[]) =>
        spawnSync(
          "git",
          [
            "-C",
            dir,
            "-c",
            "user.name=Oxagen Test",
            "-c",
            "user.email=test@oxagen.invalid",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: join(dir, "no-global-config"),
            },
          },
        );
      expect(git("init", "--quiet").status).toBe(0);
      // A repository with no commit has no head to claim on.
      expect(gitHeadIn(dir)).toBeUndefined();
      expect(
        git("commit", "--allow-empty", "--quiet", "-m", "first").status,
      ).toBe(0);
      const head = git("rev-parse", "HEAD").stdout.trim();
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      expect(gitHeadIn(dir)).toBe(head);
      // A subdirectory of the checkout reads the same head.
      mkdirSync(join(dir, "src"));
      expect(gitHeadIn(join(dir, "src"))).toBe(head);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
