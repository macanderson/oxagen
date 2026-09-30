// oracles.ts: the seven oracle classes with an evaluator on day one.
//
// Each evaluator is a pure function of its fixture and the trace, with no
// network and no clock (witness-spec.md). It stamps the trace or rejects it
// with a code from the closed enum. A crash, a missing fixture, or a trace the
// class cannot read is a rejection with its own code, never a pass.
//
// A class with no evaluator returns undefined from evaluateOracle, so the
// criterion that names it stays held until one is built.
import { digestJcs, type Sha256Digest } from "@oxagen/run-evidence";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Oracle, OracleClass } from "../types";
import { callWithinCapabilities } from "./tool-rules";
import {
  DAY_ONE_ORACLE_CLASSES,
  type BudgetFixture,
  type DayOneOracleClass,
  type ExampleFixture,
  type ExecutableFixture,
  type OracleFixture,
  type OracleResult,
  type PolicyFixture,
  type PredicateFixture,
  type ProvenanceFixture,
  type SchemaFixture,
  type Trace,
  type TraceJson,
  type WitnessReason,
} from "./types";

function pass(evidence: Sha256Digest): OracleResult {
  return { ok: true, evidence };
}

function reject(reason: WitnessReason, evidence: Sha256Digest, error?: true): OracleResult {
  return error ? { ok: false, error, reason, evidence } : { ok: false, reason, evidence };
}

/** The named output equals the expected value, compared by its JCS digest. */
export function evaluateExample(fixture: ExampleFixture, trace: Trace): OracleResult {
  const expected =
    fixture.expectedDigest ??
    (fixture.expected === undefined ? undefined : digestJcs(fixture.expected));
  const present = Object.hasOwn(trace.outputs, fixture.output);
  const actual = present ? digestJcs(trace.outputs[fixture.output]) : null;
  const evidence = digestJcs({
    class: "example",
    output: fixture.output,
    actual,
    expected: expected ?? null,
  });
  if (expected === undefined) return reject("FIXTURE_MISSING", evidence, true);
  return actual === expected ? pass(evidence) : reject("POST_MISMATCH", evidence);
}

/** Resolve an RFC 6901 JSON pointer. Throws on a pointer that is not one. */
export function resolvePointer(
  doc: TraceJson,
  pointer: string,
): { found: true; value: TraceJson } | { found: false } {
  if (pointer === "") return { found: true, value: doc };
  if (!pointer.startsWith("/")) {
    throw new TypeError(`"${pointer}" is not a JSON pointer: it must start with "/"`);
  }
  let node: TraceJson = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(node)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return { found: false };
      const item = node[Number(token)];
      if (item === undefined) return { found: false };
      node = item;
    } else if (node !== null && typeof node === "object") {
      if (!Object.hasOwn(node, token)) return { found: false };
      node = node[token] as TraceJson;
    } else {
      return { found: false };
    }
  }
  return { found: true, value: node };
}

/** Every assertion holds over the captured end state. */
export function evaluatePredicate(fixture: PredicateFixture, trace: Trace): OracleResult {
  const snapshot = trace.snapshot;
  if (snapshot === undefined || fixture.assertions.length === 0) {
    const evidence = digestJcs({ class: "predicate", snapshot: null, failed: [] });
    return reject("FIXTURE_MISSING", evidence, true);
  }
  const failed: number[] = [];
  fixture.assertions.forEach((assertion, index) => {
    const at = resolvePointer(snapshot, assertion.path);
    let holds: boolean;
    if (assertion.exists === false) {
      holds = !at.found;
    } else if (!at.found) {
      holds = false;
    } else {
      holds =
        (assertion.equals === undefined ||
          digestJcs(at.value) === digestJcs(assertion.equals)) &&
        (assertion.count === undefined ||
          (Array.isArray(at.value) && at.value.length === assertion.count));
    }
    if (!holds) failed.push(index);
  });
  const evidence = digestJcs({
    class: "predicate",
    snapshot: digestJcs(snapshot),
    failed,
  });
  return failed.length === 0 ? pass(evidence) : reject("POST_MISMATCH", evidence);
}

/**
 * The named output conforms to a JSON Schema (draft 2020-12). A schema that
 * names a remote `$ref` fails to compile, because nothing here fetches.
 */
export function evaluateSchema(fixture: SchemaFixture, trace: Trace): OracleResult {
  const present = Object.hasOwn(trace.outputs, fixture.output);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(fixture.schema);
  const valid = present && validate(trace.outputs[fixture.output]);
  const evidence = digestJcs({
    class: "schema",
    output: fixture.output,
    schema: digestJcs(fixture.schema),
    actual: present ? digestJcs(trace.outputs[fixture.output]) : null,
    errors: present ? (validate.errors?.length ?? 0) : null,
  });
  return valid ? pass(evidence) : reject("SCHEMA_INVALID", evidence);
}

/** The pinned command exited zero inside its timeout. */
export function evaluateExecutable(fixture: ExecutableFixture, trace: Trace): OracleResult {
  const timeoutS = fixture.timeout_s ?? 600;
  const record = trace.runs[fixture.command];
  if (!record) {
    const evidence = digestJcs({ class: "executable", command: fixture.command, recorded: false });
    return reject("FIXTURE_MISSING", evidence, true);
  }
  const evidence = digestJcs({
    class: "executable",
    command: fixture.command,
    timeoutS,
    exitCode: record.exitCode,
    signal: record.signal ?? null,
    durationS: record.durationS,
    stdout: record.stdout,
    stderr: record.stderr,
  });
  const killed =
    record.signal !== undefined || record.exitCode === null || record.durationS > timeoutS;
  if (killed) return reject("EXEC_FAILED", evidence, true);
  return record.exitCode === 0 ? pass(evidence) : reject("EXEC_FAILED", evidence);
}

/** Every tool call the gateway recorded stayed inside the capability set. */
export function evaluatePolicy(fixture: PolicyFixture, trace: Trace): OracleResult {
  const { tier, basis, toolCalls } = trace.gateway;
  const outside: { index: number; tool: string }[] = [];
  toolCalls.forEach((call, index) => {
    if (!callWithinCapabilities(fixture.capabilities, call)) {
      outside.push({ index, tool: call.tool });
    }
  });
  const evidence = digestJcs({
    class: "policy",
    tier,
    basis,
    capabilities: [...fixture.capabilities],
    calls: toolCalls.length,
    outside,
  });
  return outside.length === 0 ? pass(evidence) : reject("POLICY_VIOLATION", evidence);
}

/**
 * Cost, tokens, wall time, tool calls, and retries stayed at or under their
 * limits. A cost limit on a run that reported no cost cannot be decided.
 */
export function evaluateBudget(fixture: BudgetFixture, trace: Trace): OracleResult {
  const { tier, basis, usage } = trace.gateway;
  const { limits } = fixture;
  const counters: [keyof typeof limits, number | null][] = [
    ["usd", usage.usd],
    ["tokens", usage.tokens],
    ["minutes", usage.minutes],
    ["tool_calls", usage.toolCalls],
    ["retries", usage.retries],
  ];
  const exceeded: string[] = [];
  let undecided = false;
  for (const [name, used] of counters) {
    const limit = limits[name];
    if (limit === undefined) continue;
    if (used === null) undecided = true;
    else if (used > limit) exceeded.push(name);
  }
  const evidence = digestJcs({
    class: "budget",
    tier,
    basis,
    usage: {
      usd: usage.usd,
      tokens: usage.tokens,
      minutes: usage.minutes,
      toolCalls: usage.toolCalls,
      retries: usage.retries,
    },
    limits: Object.fromEntries(
      counters
        .map(([name]) => [name, limits[name]] as const)
        .filter(([, limit]) => limit !== undefined),
    ),
    exceeded,
    undecided,
  });
  if (exceeded.length > 0) return reject("BUDGET_EXCEEDED", evidence);
  if (undecided) return reject("EVALUATOR_ERROR", evidence, true);
  return pass(evidence);
}

/**
 * Every citation resolves to a chunk the run retrieved, and every artifact
 * chains to its inputs: each input hash is a retrieved chunk, a pre-state the
 * fixture names, or an artifact recorded before it.
 */
export function evaluateProvenance(fixture: ProvenanceFixture, trace: Trace): OracleResult {
  const retrieved = new Set(trace.retrieved.map((chunk) => `${chunk.id}\n${chunk.sha256}`));
  const known = new Set<string>([
    ...trace.retrieved.map((chunk) => chunk.sha256),
    ...(fixture.inputs ?? []),
  ]);
  const missing: { kind: "citation" | "artifact"; index: number }[] = [];
  trace.citations.forEach((citation, index) => {
    if (!retrieved.has(`${citation.chunk}\n${citation.sha256}`)) {
      missing.push({ kind: "citation", index });
    }
  });
  trace.artifacts.forEach((artifact, index) => {
    const chained =
      artifact.inputs.length > 0 && artifact.inputs.every((input) => known.has(input));
    if (!chained) missing.push({ kind: "artifact", index });
    known.add(artifact.sha256);
  });
  const evidence = digestJcs({
    class: "provenance",
    citations: trace.citations.length,
    artifacts: trace.artifacts.length,
    missing,
  });
  return missing.length === 0 ? pass(evidence) : reject("PROVENANCE_MISSING", evidence);
}

/** Whether a class has an evaluator. */
export function hasOracleEvaluator(cls: OracleClass): cls is DayOneOracleClass {
  return (DAY_ONE_ORACLE_CLASSES as readonly OracleClass[]).includes(cls);
}

function dispatch(fixture: OracleFixture, trace: Trace): OracleResult {
  switch (fixture.class) {
    case "example":
      return evaluateExample(fixture, trace);
    case "predicate":
      return evaluatePredicate(fixture, trace);
    case "schema":
      return evaluateSchema(fixture, trace);
    case "executable":
      return evaluateExecutable(fixture, trace);
    case "policy":
      return evaluatePolicy(fixture, trace);
    case "budget":
      return evaluateBudget(fixture, trace);
    case "provenance":
      return evaluateProvenance(fixture, trace);
  }
}

/**
 * Run a criterion's oracle against a trace. Returns undefined when the class
 * has no evaluator. A fixture of the wrong class, or none, rejects with
 * FIXTURE_MISSING. An evaluator that throws rejects with EVALUATOR_ERROR.
 */
export function evaluateOracle(
  oracle: Oracle,
  fixture: OracleFixture | undefined,
  trace: Trace,
): OracleResult | undefined {
  if (!hasOracleEvaluator(oracle.class)) return undefined;
  if (!fixture || fixture.class !== oracle.class) {
    const evidence = digestJcs({
      class: oracle.class,
      fixture: fixture ? fixture.class : null,
    });
    return reject("FIXTURE_MISSING", evidence, true);
  }
  try {
    return dispatch(fixture, trace);
  } catch (err) {
    const evidence = digestJcs({
      class: oracle.class,
      error: err instanceof Error ? err.name : "thrown",
    });
    return reject("EVALUATOR_ERROR", evidence, true);
  }
}
