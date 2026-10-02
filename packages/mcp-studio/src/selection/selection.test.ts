// selection.ts: a selection run asks the model once per task and reports
// each hit, miss, malformed reply, and skipped task. The model here is a
// fake, so no test spends a token.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ManifestServer } from "../contract/manifest";
import { parseSelectionTests, parseToolManifest } from "../contract/parse";
import type { SelectionTest } from "../contract/tests-files";
import {
  runSelection,
  SELECTION_INSTRUCTIONS,
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
    expect(report.counts).toStrictEqual({ total: 2, hits: 2, misses: 0, malformed: 0, skipped: 0 });
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
    expect(report.counts).toStrictEqual({ total: 1, hits: 0, misses: 1, malformed: 0, skipped: 0 });
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
    expect(report.counts).toStrictEqual({ total: 3, hits: 1, misses: 2, malformed: 0, skipped: 0 });
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
    expect(report.counts).toStrictEqual({ total: 1, hits: 0, misses: 0, malformed: 1, skipped: 0 });
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
    expect(report.counts).toStrictEqual({ total: 1, hits: 0, misses: 0, malformed: 0, skipped: 1 });
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
    expect(report.counts).toStrictEqual({ total: 8, hits: 3, misses: 2, malformed: 2, skipped: 1 });
    const { total, ...parts } = report.counts;
    expect(Object.values(parts).reduce((sum, count) => sum + count, 0)).toBe(total);
    expect(fake.requests).toHaveLength(7);
  });

  it("reports an empty run when there are no tasks", async () => {
    const fake = fakeModel(() => ({ tool: REFUND }));

    const report = await runSelection(TOOLS, [], fake.model);

    expect(report).toStrictEqual({ cases: [], counts: { total: 0, hits: 0, misses: 0, malformed: 0, skipped: 0 } });
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

  it("stops at a failed model call and keeps the tasks it finished", async () => {
    const failure = new Error("The provider answered 503.");
    const cases: SelectionCase[] = [
      { task: "first", expect: REFUND },
      { task: "second", expect: CHARGES },
      { task: "third", expect: CHARGES },
    ];
    const fake = fakeModel((request) => {
      if (request.task === "second") throw failure;
      return { tool: REFUND };
    });

    const error = await rejection(runSelection(TOOLS, cases, fake.model));

    expect(error).toBeInstanceOf(SelectionRunError);
    expect(error).toMatchObject({
      code: "model_failed",
      line: 2,
      message: "The model call for task 2 failed, so the run stopped after 1 of 3 tasks.",
      completed: [{ line: 1, task: "first", expected: REFUND, status: "hit", chosen: REFUND }],
    });
    expect((error as SelectionRunError).cause).toBe(failure);
    expect(fake.requests.map((request) => request.task)).toStrictEqual(["first", "second"]);
  });

  it("asks nothing when the signal aborted before the run", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeModel(() => ({ tool: REFUND }));

    const error = await rejection(runSelection(TOOLS, fixtureTests("billing"), fake.model, controller.signal));

    expect(error).toBe(controller.signal.reason);
    expect(fake.requests).toHaveLength(0);
  });

  it("throws the signal's reason when a model call ends because the signal aborted", async () => {
    const controller = new AbortController();
    const fake = fakeModel(() => {
      controller.abort();
      throw new Error("The request was aborted.");
    });

    const error = await rejection(runSelection(TOOLS, fixtureTests("billing"), fake.model, controller.signal));

    expect(error).toBe(controller.signal.reason);
    expect(error).not.toBeInstanceOf(SelectionRunError);
    expect(fake.requests).toHaveLength(1);
  });
});
