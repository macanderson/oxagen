// selection.ts: a selection run asks the model once per task and reports
// each hit, miss, malformed reply, skipped task, and task it did not finish.
// The model here is a fake, so no test spends a token. The tests that need
// time use fake timers, so none of them waits.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManifestServer } from "../contract/manifest";
import { parseSelectionTests, parseToolManifest } from "../contract/parse";
import type { SelectionTest } from "../contract/tests-files";
import {
  runSelection,
  SELECTION_CONCURRENCY,
  SELECTION_INSTRUCTIONS,
  SELECTION_TASKS_MAX,
  SelectionRunError,
  selectionTools,
  type SelectionCase,
  type SelectionModel,
  type SelectionRequest,
} from "./selection";

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));

function text(path: string): string {
  return readFileSync(join(FIXTURES, path), "utf8");
}

function fixtureServer(name: string): ManifestServer {
  const manifest = parseToolManifest(text("expected/tool-manifest.json"));
  if (!manifest.ok) throw new Error("expected/tool-manifest.json does not parse.");
  const server = manifest.value.servers.find((entry) => entry.name === name);
  if (server === undefined) throw new Error(`The fixture manifest has no server named ${name}.`);
  return server;
}

function fixtureTests(name: string): SelectionTest[] {
  const tests = parseSelectionTests(text(`servers/${name}/tests/selection.jsonl`));
  if (!tests.ok) throw new Error(`servers/${name}/tests/selection.jsonl does not parse.`);
  return tests.value;
}

const BILLING = fixtureServer("billing");
const TOOLS = selectionTools(BILLING);
const REFUND = "billing__create_refund";
const CHARGES = "billing__list_charges";
const NOT_OFFERED = "billing__void_invoice";

interface FakeModel {
  model: SelectionModel;
  /** Every request the run sent, in order. */
  requests: SelectionRequest[];
  /** The signal that came with each request. */
  signals: (AbortSignal | undefined)[];
}

/** A model that replies to each request with answer(request). When answer throws, the call rejects. */
function fakeModel(answer: (request: SelectionRequest) => unknown): FakeModel {
  const requests: SelectionRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  return {
    requests,
    signals,
    model: {
      choose(request, signal) {
        requests.push(request);
        signals.push(signal);
        return new Promise((resolve) => resolve(answer(request)));
      },
    },
  };
}

/** A model that replies with the answer listed for each task. */
function byTask(answers: Record<string, unknown>): FakeModel {
  return fakeModel((request) => answers[request.task]);
}

interface DelayedModel extends FakeModel {
  /** The most calls that waited for an answer at once. */
  peak: () => number;
}

/**
 * A model that answers each request after delay(request) milliseconds of fake
 * time. When answer throws, the call rejects then. An abort rejects a waiting
 * call at once with the signal's reason, unless ignoreSignal is set.
 */
function delayedModel(
  delay: (request: SelectionRequest) => number,
  answer: (request: SelectionRequest) => unknown,
  options: { ignoreSignal?: boolean } = {},
): DelayedModel {
  const requests: SelectionRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  let waiting = 0;
  let peak = 0;
  return {
    requests,
    signals,
    peak: () => peak,
    model: {
      choose(request, signal) {
        requests.push(request);
        signals.push(signal);
        waiting += 1;
        peak = Math.max(peak, waiting);
        return new Promise((resolve, reject) => {
          const settle = (finish: () => void): void => {
            waiting -= 1;
            signal?.removeEventListener("abort", onAbort);
            finish();
          };
          const onAbort = (): void => {
            clearTimeout(timer);
            settle(() => reject(signal?.reason));
          };
          const timer = setTimeout(() => {
            settle(() => {
              try {
                resolve(answer(request));
              } catch (error) {
                reject(error);
              }
            });
          }, delay(request));
          if (options.ignoreSignal !== true) signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
    },
  };
}

/** `count` tasks that each expect the refund tool, numbered from 1. */
function refundTasks(count: number): SelectionCase[] {
  return Array.from({ length: count }, (_, index) => ({ task: `Refund charge ch_${index + 1}.`, expect: REFUND }));
}

/** A signal that aborts after `ms` milliseconds of fake time, the way a run's deadline does. */
function deadlineAfter(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("The run reached its deadline.", "TimeoutError")), ms);
  return controller.signal;
}

const NOT_RUN_REASON = "The run stopped before the model answered this task, so it has no result.";

afterEach(() => {
  vi.useRealTimers();
});

/** The error a run rejects with. Fails when the run resolves. */
async function rejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error("The run resolved, and the test expected it to reject.");
}

describe("selectionTools", () => {
  it("offers each imported tool's definition in the order the server lists them", () => {
    expect(TOOLS.map((tool) => tool.name)).toStrictEqual([REFUND, CHARGES]);
    expect(TOOLS[0]).toBe(BILLING.tools["create_refund"]?.definition);
    expect(TOOLS[1]).toBe(BILLING.tools["list_charges"]?.definition);
  });

  it("keeps the server's order rather than sorting by name", () => {
    const [refund, charges] = TOOLS;
    if (refund === undefined || charges === undefined) throw new Error("The billing fixture has two tools.");

    const tools = selectionTools({ tools: { list_charges: { definition: charges }, create_refund: { definition: refund } } });

    expect(tools.map((tool) => tool.name)).toStrictEqual([CHARGES, REFUND]);
  });
});

describe("runSelection", () => {
  it("reports a hit for every fixture task when the model picks the expected tool", async () => {
    const tests = fixtureTests("billing");
    const fake = fakeModel((request) => ({ tool: tests.find((test) => test.task === request.task)?.expect }));

    const report = await runSelection(TOOLS, tests, fake.model);

    expect(report.cases).toStrictEqual(
      tests.map((test, index) => ({
        line: index + 1,
        task: test.task,
        expected: test.expect,
        status: "hit",
        chosen: test.expect,
      })),
    );
    expect(report.counts).toStrictEqual({ total: 2, hits: 2, misses: 0, malformed: 0, skipped: 0, errors: 0, notRun: 0 });
    expect(fake.requests.map((request) => request.task)).toStrictEqual(tests.map((test) => test.task));
    for (const request of fake.requests) {
      expect(request.instructions).toBe(SELECTION_INSTRUCTIONS);
      expect(request.tools).toBe(TOOLS);
    }
  });

  it("reports a miss with the expected tool and the tool the model picked", async () => {
    const task = "Refund $40 of charge ch_3P9.";
    const fake = byTask({ [task]: { tool: CHARGES } });

    const report = await runSelection(TOOLS, [{ task, expect: REFUND }], fake.model);

    expect(report.cases).toStrictEqual([{ line: 1, task, expected: REFUND, status: "miss", chosen: CHARGES }]);
    expect(report.counts).toStrictEqual({ total: 1, hits: 0, misses: 1, malformed: 0, skipped: 0, errors: 0, notRun: 0 });
  });

  it("counts a no-tool answer as a miss when a tool fits and as a hit when none does", async () => {
    const refund = "Refund $40 of charge ch_3P9.";
    const haiku = "Write a haiku about invoices.";
    const joke = "Tell me a joke.";
    const cases: SelectionCase[] = [
      { task: refund, expect: REFUND },
      { task: haiku, expect: null },
      { task: joke, expect: null },
    ];
    const fake = byTask({ [refund]: { tool: null }, [haiku]: { tool: null }, [joke]: { tool: REFUND } });

    const report = await runSelection(TOOLS, cases, fake.model);

    expect(report.cases).toStrictEqual([
      { line: 1, task: refund, expected: REFUND, status: "miss", chosen: null },
      { line: 2, task: haiku, expected: null, status: "hit", chosen: null },
      { line: 3, task: joke, expected: null, status: "miss", chosen: REFUND },
    ]);
    expect(report.counts).toStrictEqual({ total: 3, hits: 1, misses: 2, malformed: 0, skipped: 0, errors: 0, notRun: 0 });
  });

  it.each([
    ["a bare tool name", REFUND],
    ["nothing", undefined],
    ["an empty object", {}],
    ["a number for the tool", { tool: 3 }],
    ["an empty tool name", { tool: "" }],
    ["an extra field", { tool: REFUND, reason: "It refunds." }],
    ["another field name", { name: REFUND }],
  ])("reports %s as a malformed reply and names no tool", async (_label, reply) => {
    const task = "Refund $40 of charge ch_3P9.";

    const report = await runSelection(TOOLS, [{ task, expect: REFUND }], fakeModel(() => reply).model);

    expect(report.cases).toStrictEqual([
      {
        line: 1,
        task,
        expected: REFUND,
        status: "malformed",
        reason: "The model's reply is not { tool: <name or null> }, so the run could not tell which tool it picked.",
      },
    ]);
    expect(report.counts).toStrictEqual({ total: 1, hits: 0, misses: 0, malformed: 1, skipped: 0, errors: 0, notRun: 0 });
  });

  it("reports a reply that names a tool the server does not offer as malformed", async () => {
    const task = "Refund $40 of charge ch_3P9.";

    const fake = byTask({ [task]: { tool: NOT_OFFERED } });

    const report = await runSelection(TOOLS, [{ task, expect: REFUND }], fake.model);

    expect(report.cases).toStrictEqual([
      {
        line: 1,
        task,
        expected: REFUND,
        status: "malformed",
        reason: `The model picked ${NOT_OFFERED}, which the server does not offer.`,
      },
    ]);
  });

  it("skips a task that expects a tool the server does not offer, without asking the model", async () => {
    const task = "Void invoice in_1.";
    const fake = byTask({ [task]: { tool: REFUND } });

    const report = await runSelection(TOOLS, [{ task, expect: NOT_OFFERED }], fake.model);

    expect(fake.requests).toHaveLength(0);
    expect(report.cases).toStrictEqual([
      {
        line: 1,
        task,
        expected: NOT_OFFERED,
        status: "skipped",
        reason: `The server does not offer ${NOT_OFFERED}, so the run did not ask the model. Import the tool, or correct the task's expect.`,
      },
    ]);
    expect(report.counts).toStrictEqual({ total: 1, hits: 0, misses: 0, malformed: 0, skipped: 1, errors: 0, notRun: 0 });
  });

  it("counts each task once, and the counts add up to the total", async () => {
    const cases: SelectionCase[] = [
      { task: "hit", expect: REFUND },
      { task: "wrong tool", expect: REFUND },
      { task: "no tool", expect: CHARGES },
      { task: "none fits", expect: null },
      { task: "unreadable", expect: CHARGES },
      { task: "made-up tool", expect: CHARGES },
      { task: "stale test", expect: NOT_OFFERED },
      { task: "another hit", expect: CHARGES },
    ];
    const fake = byTask({
      hit: { tool: REFUND },
      "wrong tool": { tool: CHARGES },
      "no tool": { tool: null },
      "none fits": { tool: null },
      unreadable: "list_charges",
      "made-up tool": { tool: "billing__list_payments" },
      "another hit": { tool: CHARGES },
    });

    const report = await runSelection(TOOLS, cases, fake.model);

    expect(report.cases.map((result) => [result.line, result.status])).toStrictEqual([
      [1, "hit"],
      [2, "miss"],
      [3, "miss"],
      [4, "hit"],
      [5, "malformed"],
      [6, "malformed"],
      [7, "skipped"],
      [8, "hit"],
    ]);
    expect(report.counts).toStrictEqual({ total: 8, hits: 3, misses: 2, malformed: 2, skipped: 1, errors: 0, notRun: 0 });
    const { total, ...parts } = report.counts;
    expect(Object.values(parts).reduce((sum, count) => sum + count, 0)).toBe(total);
    expect(fake.requests).toHaveLength(7);
  });

  it("reports an empty run when there are no tasks", async () => {
    const fake = fakeModel(() => ({ tool: REFUND }));

    const report = await runSelection(TOOLS, [], fake.model);

    expect(report).toStrictEqual({
      cases: [],
      counts: { total: 0, hits: 0, misses: 0, malformed: 0, skipped: 0, errors: 0, notRun: 0 },
      stopped: null,
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("passes the caller's signal to every model call", async () => {
    const controller = new AbortController();
    const fake = fakeModel(() => ({ tool: REFUND }));

    await runSelection(TOOLS, fixtureTests("billing"), fake.model, controller.signal);

    expect(fake.signals).toStrictEqual([controller.signal, controller.signal]);
  });

  it("refuses a server with no tools before it asks the model", async () => {
    const fake = fakeModel(() => ({ tool: REFUND }));

    const error = await rejection(runSelection([], fixtureTests("billing"), fake.model));

    expect(error).toBeInstanceOf(SelectionRunError);
    expect(error).toMatchObject({ code: "no_tools", line: null, completed: [] });
    expect((error as SelectionRunError).cause).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses two tools with one name before it asks the model", async () => {
    const fake = fakeModel(() => ({ tool: REFUND }));

    const error = await rejection(runSelection([...TOOLS, ...TOOLS], fixtureTests("billing"), fake.model));

    expect(error).toBeInstanceOf(SelectionRunError);
    expect(error).toMatchObject({
      code: "duplicate_tool",
      message: `Two tools are named ${REFUND}, so a reply could not say which one the model picked.`,
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("asks every task when the run holds exactly the most tasks one run allows", async () => {
    const cases: SelectionCase[] = Array.from({ length: SELECTION_TASKS_MAX }, (_, index) => ({
      task: `Refund charge ch_${index}.`,
      expect: REFUND,
    }));
    const fake = fakeModel(() => ({ tool: REFUND }));

    const report = await runSelection(TOOLS, cases, fake.model);

    expect(report.counts).toStrictEqual({
      total: SELECTION_TASKS_MAX,
      hits: SELECTION_TASKS_MAX,
      misses: 0,
      malformed: 0,
      skipped: 0,
      errors: 0,
      notRun: 0,
    });
    expect(fake.requests).toHaveLength(SELECTION_TASKS_MAX);
  });

  it("refuses a run with more tasks than one run allows before it asks the model", async () => {
    const cases: SelectionCase[] = Array.from({ length: SELECTION_TASKS_MAX + 1 }, (_, index) => ({
      task: `Refund charge ch_${index}.`,
      expect: REFUND,
    }));
    const fake = fakeModel(() => ({ tool: REFUND }));

    const error = await rejection(runSelection(TOOLS, cases, fake.model));

    expect(error).toBeInstanceOf(SelectionRunError);
    expect(error).toMatchObject({
      code: "too_many_tasks",
      line: null,
      completed: [],
      message: `The run has ${SELECTION_TASKS_MAX + 1} tasks, and one run asks at most ${SELECTION_TASKS_MAX}, because each task is a billed model call. Remove tasks from tests/selection.jsonl until it holds ${SELECTION_TASKS_MAX} or fewer.`,
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("starts no task after a failed model call, and returns every task that finished", async () => {
    vi.useFakeTimers();
    const failure = Object.assign(new Error("The provider answered 503."), { code: "provider_unavailable" });
    const cases = refundTasks(SELECTION_CONCURRENCY + 2);
    const failing = cases[1]?.task;
    const fake = delayedModel(
      (request) => (request.task === failing ? 500 : 1_000),
      (request) => {
        if (request.task === failing) throw failure;
        return { tool: REFUND };
      },
    );

    const run = runSelection(TOOLS, cases, fake.model);
    await vi.advanceTimersByTimeAsync(1_000);
    const report = await run;

    expect(report.stopped).toBe("model_failed");
    // The calls out when task 2 failed still finished, and the run kept them:
    // each one is a billed answer.
    expect(report.cases.map((result) => [result.line, result.status])).toStrictEqual(
      cases.map((_, index) => {
        const line = index + 1;
        if (line === 2) return [line, "error"];
        return [line, line <= SELECTION_CONCURRENCY ? "hit" : "not_run"];
      }),
    );
    expect(report.cases[1]).toStrictEqual({
      line: 2,
      task: failing,
      expected: REFUND,
      status: "error",
      reason: "The model call failed (provider_unavailable): The provider answered 503.",
    });
    expect(report.counts).toStrictEqual({
      total: cases.length,
      hits: SELECTION_CONCURRENCY - 1,
      misses: 0,
      malformed: 0,
      skipped: 0,
      errors: 1,
      notRun: cases.length - SELECTION_CONCURRENCY,
    });
    // No task after the first round was asked.
    expect(fake.requests).toHaveLength(SELECTION_CONCURRENCY);
  });

  it("keeps a malformed answer that came back before a failure, because it was billed", async () => {
    vi.useFakeTimers();
    const cases = refundTasks(2);
    const fake = delayedModel(
      (request) => (request.task === cases[0]?.task ? 100 : 500),
      (request) => {
        if (request.task === cases[1]?.task) throw new Error("The provider answered 500.");
        return { pick: REFUND };
      },
    );

    const run = runSelection(TOOLS, cases, fake.model);
    await vi.advanceTimersByTimeAsync(500);
    const report = await run;

    expect(report.stopped).toBe("model_failed");
    expect(report.cases.map((result) => result.status)).toStrictEqual(["malformed", "error"]);
  });

  it("clips a long provider message in a failed task's reason", async () => {
    vi.useFakeTimers();
    const cases = refundTasks(2);
    const fake = delayedModel(
      (request) => (request.task === cases[0]?.task ? 100 : 500),
      (request) => {
        if (request.task === cases[1]?.task) throw new Error("x".repeat(2_000));
        return { tool: REFUND };
      },
    );

    const run = runSelection(TOOLS, cases, fake.model);
    await vi.advanceTimersByTimeAsync(500);
    const failed = (await run).cases[1];

    expect(failed?.status).toBe("error");
    expect(failed !== undefined && "reason" in failed ? failed.reason : "").toBe(
      `The model call failed: ${"x".repeat(500)}...`,
    );
  });

  it("throws when every call fails, because no task has an answer to report", async () => {
    const failure = new Error("The provider answered 503.");
    const fake = fakeModel(() => {
      throw failure;
    });

    const error = await rejection(runSelection(TOOLS, refundTasks(SELECTION_CONCURRENCY + 3), fake.model));

    expect(error).toBeInstanceOf(SelectionRunError);
    expect(error).toMatchObject({
      code: "model_failed",
      line: 1,
      message: "The model call for task 1 failed, and no task got an answer, so the run has no result to report.",
    });
    expect((error as SelectionRunError).cause).toBe(failure);
    expect((error as SelectionRunError).completed.every((result) => result.status === "error")).toBe(true);
    expect(fake.requests).toHaveLength(SELECTION_CONCURRENCY);
  });

  it("throws when the only finished tasks are skipped ones, because the model answered nothing", async () => {
    const fake = fakeModel(() => {
      throw new Error("The provider answered 401.");
    });

    const error = await rejection(
      runSelection(
        TOOLS,
        [
          { task: "void", expect: NOT_OFFERED },
          { task: "refund", expect: REFUND },
        ],
        fake.model,
      ),
    );

    expect(error).toMatchObject({ code: "model_failed", line: 2 });
    expect((error as SelectionRunError).completed.map((result) => result.status)).toStrictEqual(["skipped", "error"]);
  });
});

describe("runSelection asks several tasks at once", () => {
  it(`never has more than ${SELECTION_CONCURRENCY} calls waiting, and starts the next task as each answer comes back`, async () => {
    vi.useFakeTimers();
    const cases = refundTasks(SELECTION_CONCURRENCY * 2 + 2);
    const fake = delayedModel(() => 1_000, () => ({ tool: REFUND }));

    const run = runSelection(TOOLS, cases, fake.model);
    expect(fake.requests).toHaveLength(SELECTION_CONCURRENCY);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.requests).toHaveLength(SELECTION_CONCURRENCY * 2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.requests).toHaveLength(cases.length);

    await vi.advanceTimersByTimeAsync(1_000);
    const report = await run;

    expect(fake.peak()).toBe(SELECTION_CONCURRENCY);
    expect(fake.requests.map((request) => request.task)).toStrictEqual(cases.map((test) => test.task));
    expect(report.stopped).toBeNull();
    expect(report.counts).toStrictEqual({ total: cases.length, hits: cases.length, misses: 0, malformed: 0, skipped: 0, errors: 0, notRun: 0 });
  });

  it("starts a new task when any call answers, not when a whole round does", async () => {
    vi.useFakeTimers();
    const cases = refundTasks(SELECTION_CONCURRENCY + 1);
    const fast = cases[0]?.task;
    const fake = delayedModel((request) => (request.task === fast ? 100 : 1_000), () => ({ tool: REFUND }));

    const run = runSelection(TOOLS, cases, fake.model);
    await vi.advanceTimersByTimeAsync(100);

    expect(fake.requests).toHaveLength(SELECTION_CONCURRENCY + 1);
    expect(fake.peak()).toBe(SELECTION_CONCURRENCY);

    await vi.advanceTimersByTimeAsync(1_000);
    expect((await run).counts.hits).toBe(cases.length);
  });

  it("reports every task in file order when the answers come back out of order", async () => {
    vi.useFakeTimers();
    const cases: SelectionCase[] = [
      { task: "slow refund", expect: REFUND },
      { task: "fast charges", expect: CHARGES },
      { task: "medium none", expect: null },
    ];
    const delays: Record<string, number> = { "slow refund": 900, "fast charges": 100, "medium none": 500 };
    const fake = delayedModel(
      (request) => delays[request.task] ?? 0,
      (request) => ({ tool: request.task === "slow refund" ? REFUND : request.task === "fast charges" ? CHARGES : null }),
    );

    const run = runSelection(TOOLS, cases, fake.model);
    await vi.advanceTimersByTimeAsync(900);
    const report = await run;

    expect(report.cases).toStrictEqual([
      { line: 1, task: "slow refund", expected: REFUND, status: "hit", chosen: REFUND },
      { line: 2, task: "fast charges", expected: CHARGES, status: "hit", chosen: CHARGES },
      { line: 3, task: "medium none", expected: null, status: "hit", chosen: null },
    ]);
  });

  it("finishes the issue's slow run inside its deadline: 50 tasks at 6 seconds each", async () => {
    vi.useFakeTimers();
    const deadline = deadlineAfter(240_000);
    const cases = refundTasks(SELECTION_TASKS_MAX);
    const fake = delayedModel(() => 6_000, () => ({ tool: REFUND }));

    const run = runSelection(TOOLS, cases, fake.model, deadline);
    await vi.advanceTimersByTimeAsync((SELECTION_TASKS_MAX / SELECTION_CONCURRENCY) * 6_000);
    const report = await run;

    expect(deadline.aborted).toBe(false);
    expect(report.stopped).toBeNull();
    expect(report.counts.hits).toBe(SELECTION_TASKS_MAX);
    expect(fake.peak()).toBe(SELECTION_CONCURRENCY);
  });
});

describe("runSelection at its deadline", () => {
  it("returns the tasks that finished, marks the rest not_run, and starts no new task", async () => {
    vi.useFakeTimers();
    const cases = refundTasks(SELECTION_CONCURRENCY * 2 + 2);
    const fake = delayedModel(() => 1_000, () => ({ tool: REFUND }));
    const deadline = deadlineAfter(1_500);

    const run = runSelection(TOOLS, cases, fake.model, deadline);
    await vi.advanceTimersByTimeAsync(1_500);
    const report = await run;

    expect(report.stopped).toBe("deadline");
    expect(report.counts).toStrictEqual({
      total: cases.length,
      hits: SELECTION_CONCURRENCY,
      misses: 0,
      malformed: 0,
      skipped: 0,
      errors: 0,
      notRun: cases.length - SELECTION_CONCURRENCY,
    });
    expect(report.cases.slice(0, SELECTION_CONCURRENCY).every((result) => result.status === "hit")).toBe(true);
    expect(report.cases.slice(SELECTION_CONCURRENCY)).toStrictEqual(
      cases.slice(SELECTION_CONCURRENCY).map((test, index) => ({
        line: SELECTION_CONCURRENCY + index + 1,
        task: test.task,
        expected: REFUND,
        status: "not_run",
        reason: NOT_RUN_REASON,
      })),
    );
    // The second round was out at the deadline. Nothing after it was asked.
    expect(fake.requests).toHaveLength(SELECTION_CONCURRENCY * 2);
    expect(fake.signals.every((signal) => signal === deadline)).toBe(true);
  });

  it("stops waiting at the deadline even for a call that ignores the signal", async () => {
    vi.useFakeTimers();
    const cases = refundTasks(2);
    const fake = delayedModel((request) => (request.task === cases[0]?.task ? 100 : 60_000), () => ({ tool: REFUND }), {
      ignoreSignal: true,
    });
    const deadline = deadlineAfter(1_000);

    const run = runSelection(TOOLS, cases, fake.model, deadline);
    await vi.advanceTimersByTimeAsync(1_000);
    const report = await run;

    expect(report.stopped).toBe("deadline");
    expect(report.cases.map((result) => result.status)).toStrictEqual(["hit", "not_run"]);
  });

  it("counts a call that fails because the signal aborted as not_run, not as a failed run", async () => {
    const controller = new AbortController();
    const fake = fakeModel(() => {
      controller.abort();
      throw new Error("The request was aborted.");
    });

    const report = await runSelection(TOOLS, refundTasks(1), fake.model, controller.signal);

    expect(report.stopped).toBe("deadline");
    expect(report.cases).toStrictEqual([
      { line: 1, task: "Refund charge ch_1.", expected: REFUND, status: "not_run", reason: NOT_RUN_REASON },
    ]);
  });

  it("asks nothing when the signal aborted before the run, and still reports each skipped task", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeModel(() => ({ tool: REFUND }));

    const report = await runSelection(
      TOOLS,
      [
        { task: "refund", expect: REFUND },
        { task: "void", expect: NOT_OFFERED },
      ],
      fake.model,
      controller.signal,
    );

    expect(fake.requests).toHaveLength(0);
    expect(report.stopped).toBe("deadline");
    expect(report.cases.map((result) => [result.line, result.status])).toStrictEqual([
      [1, "not_run"],
      [2, "skipped"],
    ]);
    expect(report.counts).toStrictEqual({ total: 2, hits: 0, misses: 0, malformed: 0, skipped: 1, errors: 0, notRun: 1 });
  });

  it("reports a run that finished before the signal aborted as finished", async () => {
    const controller = new AbortController();
    const fake = fakeModel(() => ({ tool: REFUND }));

    const report = await runSelection(TOOLS, refundTasks(2), fake.model, controller.signal);
    controller.abort();

    expect(report.stopped).toBeNull();
    expect(report.counts.notRun).toBe(0);
  });
});
