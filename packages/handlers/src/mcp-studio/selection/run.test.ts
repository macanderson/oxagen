// run.test.ts: run_studio_selection over an in-memory steering repo. The
// build is the real one, and the billing folder comes from
// packages/mcp-studio/fixtures. The store, the host, and the model are fakes,
// so no test spends a token. The deadline tests run on fake timers, so none
// of them waits.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("../../context.steering.host", () => ({
  createSteeringHost: vi.fn(() => {
    throw new Error("each test passes its own host");
  }),
}));
vi.mock("@oxagen/ai", () => ({
  CREDIT_REASONS: { CONSUME_ASSISTANT_TOKENS: "consume_assistant_tokens" },
  generateObjectFor: vi.fn(() => {
    throw new Error("each test passes its own model");
  }),
  modelIdOf: vi.fn(),
  modelIdentityFor: vi.fn(),
  resolveModelFundingSource: vi.fn(() => {
    throw new Error("each test passes its own model");
  }),
  selectModelFromFunding: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { TooManyToolsForProviderError } from "@oxagen/agent/runtime/tool-budget";
import {
  SELECTION_CONCURRENCY,
  SELECTION_INSTRUCTIONS,
  SELECTION_TASKS_MAX,
  type SelectionRequest,
} from "@oxagen/mcp-studio";
import { HandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { toolStudioSelectionRun } from "@oxagen/oxagen/contracts/tool.studio.selection.run";
import type { SteeringRepository } from "../../context.steering.github";
import { TEST_CTX, makeCTX } from "../../test-utils/fixtures";
import type { StudioReviewHost } from "../import/review.open";
import { importSource } from "../import/source";
import type { StoredStudioDraft } from "../import/store";
import { createStudioSelectionModel, type StudioSelectionModel, type StudioSelectionModelDeps } from "./model";
import { createRunStudioSelectionHandler, SELECTION_RUN_DEADLINE_MS } from "./run";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A file under packages/mcp-studio/fixtures. */
function fixture(path: string): string {
  return readFileSync(new URL(`../../../../mcp-studio/fixtures/${path}`, import.meta.url), "utf8");
}

/** A repository's files at one ref, by repository path. */
type Tree = Record<string, string>;

const REPO: SteeringRepository = {
  provider: "github",
  owner: "acme",
  repo: "steering",
  fullName: "acme/steering",
  currentFullName: "acme/steering",
  defaultBranch: "main",
};
const BILLING_CREDENTIAL = "oxagen:credential/billing-oauth-client";
const SELECTION_PATH = "tools/servers/billing/tests/selection.jsonl";

const REFUND = "billing__create_refund";
const CHARGES = "billing__list_charges";
const REFUND_TASK = "Give the customer back $40 of charge ch_3P9 because it was billed twice.";
const CHARGES_TASK = "What did customer cus_81 pay us in August?";

/** The billing folder on the production branch, with the fixture's two selection tests. */
function billingMain(): Tree {
  const paths = ["server.toml", "tools.toml", "tools.lock.json", "openapi.yaml", "tests/calls.jsonl", "tests/selection.jsonl"];
  return Object.fromEntries(paths.map((p) => [`tools/servers/billing/${p}`, fixture(`servers/billing/${p}`)]));
}

/** The billing folder with tests/selection.jsonl holding `lines`, or no such file for null. */
function withSelection(lines: readonly object[] | string | null): Tree {
  const tree = billingMain();
  if (lines === null) {
    delete tree[SELECTION_PATH];
    return tree;
  }
  tree[SELECTION_PATH] = typeof lines === "string" ? lines : `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  return tree;
}

/** `count` tasks that each expect the refund tool. */
function refundTasks(count: number): { task: string; expect: string }[] {
  return Array.from({ length: count }, (_, index) => ({ task: `Refund charge ch_${index}.`, expect: REFUND }));
}

/** A draft with no source that rewrites list_charges's description. */
function describeDraft(description: string): StoredStudioDraft {
  return {
    server: "billing",
    serverId: null,
    ops: [{ kind: "describe", tool: "list_charges", description }],
    serverToml: null,
    source: null,
    revision: 3,
    pr: null,
    updatedAt: new Date("2026-10-01T12:00:00Z"),
  };
}

// ── The rig ──────────────────────────────────────────────────────────────────

/** The fake head commit of a branch: its name in hex, cut or padded to 40 characters. */
function headOf(branch: string): string {
  return Buffer.from(branch).toString("hex").padEnd(40, "0").slice(0, 40);
}

/** A repository whose branches are `refs`. Files are found by commit only. It has no write method. */
function fakeHost(refs: Record<string, Tree>) {
  const trees = new Map(Object.entries(refs).map(([branch, tree]) => [headOf(branch), tree]));
  return {
    resolveRepository: vi.fn(async () => REPO),
    branchHead: vi.fn(async (_repo: SteeringRepository, branch: string) => (branch in refs ? headOf(branch) : null)),
    readFile: vi.fn(async (_repo: SteeringRepository, path: string, ref: string) => trees.get(ref)?.[path] ?? null),
    listFiles: vi.fn(async (_repo: SteeringRepository, ref: string, dir: string) =>
      Object.keys(trees.get(ref) ?? {})
        .filter((path) => path.startsWith(`${dir}/`))
        .sort(),
    ),
  } satisfies Pick<StudioReviewHost, "resolveRepository" | "branchHead" | "readFile" | "listFiles">;
}

interface FakeModel {
  model: StudioSelectionModel;
  /** Every request the run sent, in order. */
  requests: SelectionRequest[];
  /** The signal that came with each request. */
  signals: (AbortSignal | undefined)[];
}

/** A model that answers each request with answer(request), and names `modelId` once asked. */
function fakeModel(answer: (request: SelectionRequest) => unknown, modelId = "fast-model"): FakeModel {
  const requests: SelectionRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  let asked: string | null = null;
  return {
    requests,
    signals,
    model: {
      modelId: () => asked,
      async choose(request, signal) {
        requests.push(request);
        signals.push(signal);
        asked = modelId;
        return answer(request);
      },
    },
  };
}

/** A model that picks the listed tool for each task, and none for a task it does not know. */
function byTask(answers: Record<string, string | null>): FakeModel {
  return fakeModel((request) => ({ tool: answers[request.task] ?? null }));
}

interface SlowModel extends FakeModel {
  /** The most calls that waited for an answer at once. */
  peak: () => number;
}

/**
 * A model that picks the refund tool `ms` milliseconds of fake time after
 * each request, the way a slow model answers. An abort rejects a waiting call
 * at once with the signal's reason, as a request through @oxagen/ai does.
 */
function slowModel(ms: number): SlowModel {
  const requests: SelectionRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  let waiting = 0;
  let peak = 0;
  return {
    requests,
    signals,
    peak: () => peak,
    model: {
      modelId: () => (requests.length === 0 ? null : "slow-model"),
      choose(request, signal) {
        requests.push(request);
        signals.push(signal);
        waiting += 1;
        peak = Math.max(peak, waiting);
        return new Promise((resolve, reject) => {
          const onAbort = (): void => {
            clearTimeout(timer);
            waiting -= 1;
            reject(signal?.reason);
          };
          const timer = setTimeout(() => {
            waiting -= 1;
            signal?.removeEventListener("abort", onAbort);
            resolve({ tool: REFUND });
          }, ms);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
    },
  };
}

/** A signal that aborts SELECTION_RUN_DEADLINE_MS of fake time from now, as the production deadline does. */
function fakeDeadline(): AbortSignal {
  const controller = new AbortController();
  setTimeout(
    () => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    SELECTION_RUN_DEADLINE_MS,
  );
  return controller.signal;
}

interface RigOptions {
  tree?: Tree;
  draft?: StoredStudioDraft | null;
  model?: StudioSelectionModel;
  deadline?: AbortSignal;
  authorize?: () => Promise<string | null>;
}

function rig(options: RigOptions = {}) {
  const host = fakeHost({ main: options.tree ?? billingMain() });
  // The store can only read. The run has no way to change the draft.
  const store = { get: vi.fn(async () => options.draft ?? null) };
  const authorize = vi.fn(options.authorize ?? (async () => "u_1"));
  const fake = byTask({ [REFUND_TASK]: REFUND, [CHARGES_TASK]: CHARGES });
  const model = options.model ?? fake.model;
  const modelFor = vi.fn((_orgId: string, _telemetry: StudioSelectionModelDeps["telemetry"]) => model);
  const signal = options.deadline ?? new AbortController().signal;
  const handler = createRunStudioSelectionHandler({
    store,
    authorize,
    host: () => host,
    credentials: async () => new Set([BILLING_CREDENTIAL]),
    importSource: (source) => importSource(source),
    model: modelFor,
    deadline: () => signal,
  });
  return {
    host,
    store,
    authorize,
    fake,
    modelFor,
    signal,
    run: (ctx: CapabilityContext = TEST_CTX) => handler({ server: "billing" }, ctx),
  };
}

async function refusal(promise: Promise<unknown>): Promise<HandlerError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HandlerError) return err;
    throw err;
  }
  throw new Error("run_studio_selection did not refuse.");
}

// ── A run ────────────────────────────────────────────────────────────────────

describe("run_studio_selection runs the folder's selection tests", () => {
  it("asks the model once per task and reports a hit for each right pick", async () => {
    const r = rig();
    const out = await r.run();

    expect(out).toStrictEqual({
      server: "billing",
      basis: "published",
      revision: null,
      model: "fast-model",
      counts: { total: 2, hits: 2, misses: 0, malformed: 0, skipped: 0, errors: 0, notRun: 0 },
      cases: [
        { line: 1, task: REFUND_TASK, expected: REFUND, status: "hit", chosen: REFUND },
        { line: 2, task: CHARGES_TASK, expected: CHARGES, status: "hit", chosen: CHARGES },
      ],
      stopped: null,
    });
    expect(toolStudioSelectionRun.output.parse(out)).toStrictEqual(out);
    expect(r.fake.requests.map((request) => request.task)).toStrictEqual([REFUND_TASK, CHARGES_TASK]);
  });

  it("offers every imported tool as the agent receives it, with the run's instructions", async () => {
    const r = rig();
    await r.run();

    for (const request of r.fake.requests) {
      expect(request.instructions).toBe(SELECTION_INSTRUCTIONS);
      expect(request.tools.map((tool) => tool.name).sort()).toStrictEqual([REFUND, CHARGES]);
      const charges = request.tools.find((tool) => tool.name === CHARGES);
      expect(charges?.description).toBe("List one customer's charges, newest first. Amounts are in cents.");
      expect(charges?.annotations).toStrictEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
  });

  it("counts hits and misses, a task no tool fits, a malformed reply, and a tool the server does not offer", async () => {
    const tree = withSelection([
      { task: "refund", expect: REFUND },
      { task: "charges picked for a refund", expect: REFUND },
      { task: "a haiku", expect: null },
      { task: "a joke", expect: null },
      { task: "nothing picked", expect: CHARGES },
      { task: "unreadable", expect: CHARGES },
      { task: "void an invoice", expect: "billing__void_invoice" },
    ]);
    const model = fakeModel((request) => {
      switch (request.task) {
        case "refund":
          return { tool: REFUND };
        case "charges picked for a refund":
          return { tool: CHARGES };
        case "a haiku":
        case "nothing picked":
          return { tool: null };
        case "a joke":
          return { tool: REFUND };
        default:
          return null;
      }
    });
    const r = rig({ tree, model: model.model });
    const out = await r.run();

    expect(out.counts).toStrictEqual({ total: 7, hits: 2, misses: 3, malformed: 1, skipped: 1, errors: 0, notRun: 0 });
    expect(out.cases.map((entry) => [entry.line, entry.status])).toStrictEqual([
      [1, "hit"],
      [2, "miss"],
      [3, "hit"],
      [4, "miss"],
      [5, "miss"],
      [6, "malformed"],
      [7, "skipped"],
    ]);
    expect(out.cases[1]).toStrictEqual({ line: 2, task: "charges picked for a refund", expected: REFUND, status: "miss", chosen: CHARGES });
    expect(out.cases[2]).toStrictEqual({ line: 3, task: "a haiku", expected: null, status: "hit", chosen: null });
    // The skipped task was never put to the model.
    expect(model.requests.map((request) => request.task)).not.toContain("void an invoice");
    expect(model.requests).toHaveLength(6);
    expect(toolStudioSelectionRun.output.safeParse(out).success).toBe(true);
  });

  it("offers the draft's tools, so a description edited in Studio is the one the model reads", async () => {
    const edited = "List a customer's charges by customer id, newest first. Amounts are in cents.";
    const r = rig({ draft: describeDraft(edited) });
    const out = await r.run();

    expect(out.basis).toBe("draft");
    expect(out.revision).toBe(3);
    const charges = r.fake.requests[0]?.tools.find((tool) => tool.name === CHARGES);
    expect(charges?.description).toBe(edited);
  });

  it("reads tests/selection.jsonl at the production commit the folder was read at", async () => {
    const r = rig();
    await r.run();

    expect(r.host.readFile).toHaveBeenCalledWith(REPO, SELECTION_PATH, headOf("main"));
  });

  it("builds the model on the caller's organization, with the caller's telemetry", async () => {
    const r = rig();
    await r.run(makeCTX({ surface: "mcp", messageId: "msg_1" }));

    expect(r.modelFor).toHaveBeenCalledTimes(1);
    expect(r.modelFor).toHaveBeenCalledWith("org_1", {
      orgId: "org_1",
      workspaceId: "ws_1",
      surface: "mcp",
      messageId: "msg_1",
    });
  });

  it("passes the run's deadline to every model call", async () => {
    const controller = new AbortController();
    const r = rig({ deadline: controller.signal });
    await r.run();

    expect(r.fake.signals).toStrictEqual([controller.signal, controller.signal]);
  });

  it("names no model when the run asks nothing", async () => {
    const r = rig({ tree: withSelection([{ task: "void an invoice", expect: "billing__void_invoice" }]) });
    const out = await r.run();

    expect(out.model).toBeNull();
    expect(out.counts).toStrictEqual({ total: 1, hits: 0, misses: 0, malformed: 0, skipped: 1, errors: 0, notRun: 0 });
    expect(r.fake.requests).toHaveLength(0);
  });

  it("reads the folder and writes nothing", async () => {
    const r = rig({ draft: describeDraft("List charges.") });
    await r.run();

    expect(Object.keys(r.store)).toStrictEqual(["get"]);
    expect(Object.keys(r.host).sort()).toStrictEqual(["branchHead", "listFiles", "readFile", "resolveRepository"]);
  });
});

// ── The task cap ─────────────────────────────────────────────────────────────

describe("run_studio_selection caps the tasks one run asks", () => {
  it("says the cap in the contract's description", () => {
    expect(toolStudioSelectionRun.description).toContain(`at most ${SELECTION_TASKS_MAX} tasks`);
  });

  it("runs a file that holds exactly the cap", async () => {
    const r = rig({ tree: withSelection(refundTasks(SELECTION_TASKS_MAX)) });
    const out = await r.run();

    expect(out.counts.total).toBe(SELECTION_TASKS_MAX);
    expect(r.fake.requests).toHaveLength(SELECTION_TASKS_MAX);
  });

  it("refuses a file over the cap before any model call", async () => {
    const r = rig({ tree: withSelection(refundTasks(SELECTION_TASKS_MAX + 1)) });
    const err = await refusal(r.run());

    expect(err.code).toBe("conflict");
    expect(err.reason).toBe("too_many_tasks");
    expect(err.message).toBe(
      `The run has ${SELECTION_TASKS_MAX + 1} tasks, and one run asks at most ${SELECTION_TASKS_MAX}, because each task is a billed model call. Remove tasks from tests/selection.jsonl until it holds ${SELECTION_TASKS_MAX} or fewer.`,
    );
    expect(r.fake.requests).toHaveLength(0);
  });

  it("resolves no model route and makes no metered call over the cap", async () => {
    const route = vi.fn(async () => {
      throw new Error("the route must not resolve");
    });
    const generate = vi.fn(async () => {
      throw new Error("the model must not be called");
    });
    const model = createStudioSelectionModel({
      route,
      generate,
      telemetry: { orgId: "org_1", workspaceId: "ws_1", surface: "api", messageId: null },
    });
    const r = rig({ tree: withSelection(refundTasks(SELECTION_TASKS_MAX + 1)), model });
    const err = await refusal(r.run());

    expect(err.reason).toBe("too_many_tasks");
    expect(route).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});

// ── Refusals ─────────────────────────────────────────────────────────────────

describe("run_studio_selection refuses", () => {
  it("a folder with no tests/selection.jsonl on the production branch", async () => {
    const r = rig({ tree: withSelection(null) });
    const err = await refusal(r.run());

    expect(err.code).toBe("not_found");
    expect(err.reason).toBe("selection_tests_missing");
    expect(err.message).toBe(
      `acme/steering has no ${SELECTION_PATH} on main, so the run has no tasks. Add the file with one task and its expected tool per line, merge it, then run the selection tests again.`,
    );
    expect(r.fake.requests).toHaveLength(0);
  });

  it("a tests/selection.jsonl that does not parse, naming the line", async () => {
    const r = rig({ tree: withSelection(`${JSON.stringify({ task: REFUND_TASK, expect: REFUND })}\n{"task":"Refund a charge."}\n`) });
    const err = await refusal(r.run());

    expect(err.code).toBe("conflict");
    expect(err.reason).toBe("selection_tests_invalid");
    expect(err.message).toContain(`${SELECTION_PATH} on main does not parse.`);
    expect(err.message).toContain("line 2, expect:");
    expect(r.fake.requests).toHaveLength(0);
  });

  it("a tool list over the provider's cap, in Studio's words", async () => {
    const tooMany = new TooManyToolsForProviderError(
      "openai/gpt-5.2",
      129,
      128,
      "OpenAI function-calling limit of 128 tools per request",
    );
    const model = fakeModel(() => {
      throw tooMany;
    });
    const r = rig({ model: model.model });
    const err = await refusal(r.run());

    expect(err.code).toBe("conflict");
    expect(err.reason).toBe("too_many_tools_for_provider");
    expect(err.message).toBe(
      "billing offers 129 tools, and openai/gpt-5.2 takes at most 128 in one request (OpenAI function-calling limit of 128 tools per request). The run asked the model nothing. An agent on this model could not see every tool at once either. Import fewer tools, or move the workspace to a model without this limit.",
    );
  });

  it("a server with no draft and no folder, before it reads the tests or calls the model", async () => {
    const r = rig({ tree: {} });
    const err = await refusal(r.run());

    expect(err.code).toBe("not_found");
    expect(err.reason).toBe("folder_not_found");
    expect(r.host.readFile).not.toHaveBeenCalledWith(REPO, SELECTION_PATH, expect.anything());
    expect(r.modelFor).not.toHaveBeenCalled();
  });

  it("a person without the role, before it reads anything or calls the model", async () => {
    const r = rig({
      authorize: async () => {
        throw new HandlerError({ code: "forbidden", reason: "role_required", message: "No." });
      },
    });
    const err = await refusal(r.run());

    expect(err.code).toBe("forbidden");
    expect(r.authorize).toHaveBeenCalledWith(toolStudioSelectionRun, TEST_CTX);
    expect(r.store.get).not.toHaveBeenCalled();
    expect(r.host.resolveRepository).not.toHaveBeenCalled();
    expect(r.modelFor).not.toHaveBeenCalled();
  });
});

describe("run_studio_selection and a failed model call", () => {
  it("passes the model's own error through and starts no more tasks", async () => {
    const failure = new Error("The provider answered 503.");
    const model = fakeModel(() => {
      throw failure;
    });
    const r = rig({ tree: withSelection(refundTasks(SELECTION_CONCURRENCY + 2)), model: model.model });

    await expect(r.run()).rejects.toBe(failure);
    expect(model.requests).toHaveLength(SELECTION_CONCURRENCY);
  });

  it("returns the answers that came back before a failure, with the failed task marked error", async () => {
    const tasks = refundTasks(SELECTION_CONCURRENCY + 2);
    const failing = tasks[1]?.task;
    const model = fakeModel((request) => {
      if (request.task === failing) throw new Error("The provider answered 503.");
      return { tool: REFUND };
    });
    const r = rig({ tree: withSelection(tasks), model: model.model });

    const out = await r.run();

    expect(out.stopped).toBe("model_failed");
    expect(out.cases[1]).toStrictEqual({
      line: 2,
      task: failing,
      expected: REFUND,
      status: "error",
      reason: "The model call failed: The provider answered 503.",
    });
    const others = out.cases.filter((entry) => entry.line !== 2);
    expect(others.every((entry) => entry.status === "hit" || entry.status === "not_run")).toBe(true);
    expect(out.counts.errors).toBe(1);
    expect(out.counts.hits).toBeGreaterThan(0);
    expect(out.counts.hits + out.counts.errors + out.counts.notRun).toBe(tasks.length);
    expect(toolStudioSelectionRun.output.parse(out)).toStrictEqual(out);
  });
});

// ── The deadline ─────────────────────────────────────────────────────────────

describe("run_studio_selection at its deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Start a run of `tasks` refund tasks on `model`, under a fake deadline, and
   * resolve once its first calls are out. The run comes back in an object, so
   * awaiting this does not wait for the run.
   */
  async function startSlowRun(tasks: number, model: SlowModel) {
    // Only the timers are fake, so the folder build runs as it always does.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const r = rig({ tree: withSelection(refundTasks(tasks)), model: model.model, deadline: fakeDeadline() });
    const run = r.run();
    await vi.waitFor(() => expect(model.requests.length).toBeGreaterThan(0));
    return { run };
  }

  it("asks at most SELECTION_CONCURRENCY tasks at once, so the issue's slow run finishes: 50 tasks at 6 seconds each", async () => {
    const model = slowModel(6_000);
    const { run } = await startSlowRun(SELECTION_TASKS_MAX, model);
    expect(model.requests).toHaveLength(SELECTION_CONCURRENCY);

    await vi.advanceTimersByTimeAsync((SELECTION_TASKS_MAX / SELECTION_CONCURRENCY) * 6_000);
    const out = await run;

    expect(model.peak()).toBe(SELECTION_CONCURRENCY);
    expect(out.stopped).toBeNull();
    expect(out.counts).toStrictEqual({
      total: SELECTION_TASKS_MAX,
      hits: SELECTION_TASKS_MAX,
      misses: 0,
      malformed: 0,
      skipped: 0,
      errors: 0,
      notRun: 0,
    });
    expect(model.requests).toHaveLength(SELECTION_TASKS_MAX);
  });

  it("returns the tasks that finished and names the tasks it did not run", async () => {
    // Four rounds of five answer by 200 seconds. The fifth round is still out
    // at the 240-second deadline, and the run never asks the last 25 tasks.
    const model = slowModel(50_000);
    const { run } = await startSlowRun(SELECTION_TASKS_MAX, model);

    await vi.advanceTimersByTimeAsync(SELECTION_RUN_DEADLINE_MS);
    const out = await run;

    const answered = 4 * SELECTION_CONCURRENCY;
    expect(out.stopped).toBe("deadline");
    expect(out.model).toBe("slow-model");
    expect(out.counts).toStrictEqual({
      total: SELECTION_TASKS_MAX,
      hits: answered,
      misses: 0,
      malformed: 0,
      skipped: 0,
      errors: 0,
      notRun: SELECTION_TASKS_MAX - answered,
    });
    expect(out.cases.slice(0, answered).every((entry) => entry.status === "hit")).toBe(true);
    expect(out.cases.slice(answered)).toStrictEqual(
      refundTasks(SELECTION_TASKS_MAX)
        .slice(answered)
        .map((task, index) => ({
          line: answered + index + 1,
          task: task.task,
          expected: REFUND,
          status: "not_run",
          reason: "The run stopped before the model answered this task, so it has no result.",
        })),
    );
    // The fifth round was cut off at the deadline. Nothing after it was asked.
    expect(model.requests).toHaveLength(answered + SELECTION_CONCURRENCY);
    expect(toolStudioSelectionRun.output.parse(out)).toStrictEqual(out);
  });
});
