// The servers half of the compile check against small edits to the fixture's
// billing folder. Each test names the rule, line, and field an agent reads.
import type { Finding as LintFinding, RecordedCall } from "@oxagen/mcp-studio";
import {
  compile as compileServer,
  formatJson,
  lock as lockServer,
  mcpToolsLockSchema,
  parseLock,
  parseServerToml,
  parseToolsToml,
} from "@oxagen/mcp-studio";
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import { describe, expect, it, vi } from "vitest";
import { runChecks } from "../run";
import { context, inputFor } from "../testing/support";
import type { CheckInput, CheckReport, CheckResult, SteeringTree } from "../types";
import {
  CALLS_FILE,
  changedServers,
  checkServerFolders,
  lockedSecuritySchemes,
  lockedUpstreamTools,
  runChecksWithServers,
  SERVER_READERS,
  type ServerLint,
} from "./index";

const BILLING = "tools/servers/billing";
const SERVER = `${BILLING}/server.toml`;
const TOOLS = `${BILLING}/tools.toml`;
const LOCK = `${BILLING}/tools.lock.json`;
const CALLS = `${BILLING}/${CALLS_FILE}`;
const STRIPE_LOCK = "tools/servers/stripe/tools.lock.json";

function textOf(files: SteeringTree, path: string): string {
  const text = files.get(path);
  if (text === undefined) throw new Error(`The tree has no ${path}.`);
  return text;
}

/** The tree with the one place `from` appears in `path` replaced by `to`. */
function replaced(path: string, from: string, to: string, files: SteeringTree = fixtureRepo()): SteeringTree {
  const text = textOf(files, path);
  if (!text.includes(from)) throw new Error(`${path} does not hold ${from}.`);
  return new Map(files).set(path, text.replace(from, to));
}

function withFile(path: string, text: string, files: SteeringTree = fixtureRepo()): SteeringTree {
  return new Map(files).set(path, text);
}

function without(path: string, files: SteeringTree = fixtureRepo()): SteeringTree {
  const next = new Map(files);
  next.delete(path);
  return next;
}

/** The 1-based line that starts with `prefix`. */
function lineStarting(text: string, prefix: string): number {
  const index = text.split("\n").findIndex((line) => line.startsWith(prefix));
  if (index < 0) throw new Error(`No line starts with ${prefix}.`);
  return index + 1;
}

/** The fixture with these calls after the two tests/calls.jsonl holds. */
function appended(...lines: unknown[]): SteeringTree {
  const text = textOf(fixtureRepo(), CALLS) + lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  return withFile(CALLS, text);
}

function compileOf(report: CheckReport): CheckResult {
  const result = report.results.find((entry) => entry.check === "compile");
  if (result === undefined) throw new Error("The report has no compile result.");
  return result;
}

function servers(files: SteeringTree, overrides: Partial<CheckInput> = {}, lint?: ServerLint) {
  return checkServerFolders(inputFor(files, overrides), lint === undefined ? {} : { lint });
}

function ok(body: unknown) {
  return { status: 200, headers: { "content-type": "application/json" }, body };
}

const CHARGE_1 = { id: "ch_1", amount: 1200, status: "succeeded" };
const CHARGE_2 = { id: "ch_2", amount: 800, status: "pending" };
const CHARGES_PATH = "/customers/cus_81/charges";

/** One page of one customer's charges. */
const singleCall: RecordedCall = {
  tool: "list_charges",
  arguments: { customer_id: "cus_81" },
  exchanges: [{ request: { method: "GET", path: CHARGES_PATH }, response: ok({ data: [CHARGE_1] }) }],
  result: { data: [CHARGE_1] },
};

/** Two pages by cursor: ch_1 with cursor cur_1, then ch_2 with no cursor. */
function pagedCall(secondCursor = "cur_1"): RecordedCall {
  return {
    tool: "list_charges",
    arguments: { customer_id: "cus_81" },
    exchanges: [
      { request: { method: "GET", path: CHARGES_PATH }, response: ok({ data: [CHARGE_1], next_cursor: "cur_1" }) },
      {
        request: { method: "GET", path: CHARGES_PATH, query: { cursor: secondCursor } },
        response: ok({ data: [CHARGE_2] }),
      },
    ],
    result: { data: [CHARGE_1, CHARGE_2] },
  };
}

/** A call to a tool the fixture's lock does not hold. */
const voidCall: RecordedCall = {
  tool: "void_refund",
  arguments: { refund_id: "re_1" },
  exchanges: [{ request: { method: "POST", path: "/refunds/re_1/void" }, response: ok({ id: "re_1" }) }],
  result: { id: "re_1" },
};

const STUDIO_SOURCE = replaced(TOOLS, '"X-Request-Source" = "oxagen"', '"X-Request-Source" = "studio"');

describe("the fixture", () => {
  it("compiles, verifies, and replays every server folder with no findings", async () => {
    const input = inputFor(fixtureRepo(), { base: null });
    expect(await checkServerFolders(input)).toEqual({ findings: [], notes: [] });
    expect(await runChecksWithServers(input)).toEqual(runChecks({ ...input, servers: SERVER_READERS }));
  });
});

describe("replay", () => {
  it("passes a single-page call whose request and result match", async () => {
    expect(await servers(appended(singleCall))).toEqual({ findings: [], notes: [] });
  });

  it("passes a paged call that serves each page in order", async () => {
    expect(await servers(appended(pagedCall()))).toEqual({ findings: [], notes: [] });
  });

  it("reports the first request that differs on a later page", async () => {
    const { findings } = await servers(appended(pagedCall("cur_0")));
    expect(findings).toEqual([
      expect.objectContaining({
        check: "compile",
        rule: "replay-matches",
        severity: "error",
        path: CALLS,
        line: 3,
        field: null,
        message:
          'The recorded list_charges call no longer replays. Exchange 2\'s request differs at query.cursor: the recording has "cur_0", and the build has "cur_1".',
        detail: { tool: "list_charges", part: "request", exchange: 2 },
      }),
    ]);
  });

  it("reports a changed shape as a result that differs", async () => {
    const head = replaced(TOOLS, 'description = "Read one refund by its id."', 'description = "Read one refund by its id."\nselect = ["id"]');
    const { findings } = await servers(head);
    const replays = findings.filter((finding) => finding.rule === "replay-matches");
    expect(replays).toHaveLength(1);
    expect(replays[0]).toMatchObject({ path: CALLS, line: 2, detail: { tool: "get_refund", part: "result" } });
    expect(replays[0]?.message).toMatch(/^The recorded get_refund call no longer replays\. The result differs at /);
  });

  it("reports a changed request at the header that differs", async () => {
    const { findings } = await servers(STUDIO_SOURCE);
    expect(findings).toEqual([
      expect.objectContaining({
        rule: "replay-matches",
        path: CALLS,
        line: 1,
        message:
          'The recorded create_refund call no longer replays. Exchange 1\'s request differs at headers.X-Request-Source: the recording has "oxagen", and the build has "studio".',
        detail: { tool: "create_refund", part: "request", exchange: 1 },
      }),
    ]);
  });

  it("reports a line that does not parse at its line", async () => {
    const head = withFile(CALLS, `${textOf(fixtureRepo(), CALLS)}{"tool":"get_refund"}\n`);
    const { findings } = await servers(head);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding).toMatchObject({ rule: "replay-parses", path: CALLS, line: 3 });
      expect(finding.message).toMatch(/^The recorded call does not parse: .*\.$/);
    }
  });

  it("notes a call to a tool tools.toml no longer imports", async () => {
    expect(await servers(appended(voidCall))).toEqual({
      findings: [],
      notes: [`Replay skipped 1 recorded call in ${CALLS}, because tools.toml no longer imports their tools.`],
    });
  });

  it("notes calls to a tool the lock does not hold yet", async () => {
    const entry = [
      "",
      "[tools.void_refund]",
      'operation = "voidRefund"',
      'description = "Void a pending refund."',
      'risk = "medium"',
      'side_effect = "write"',
      'egress = "org_tenant"',
      "",
    ].join("\n");
    const tools = `${textOf(fixtureRepo(), TOOLS)}${entry}`;
    const head = withFile(TOOLS, tools, appended(voidCall, voidCall));
    expect(await servers(head)).toEqual({
      findings: [],
      notes: [`Replay skipped 2 recorded calls in ${CALLS}, because the lock does not hold their tools yet.`],
    });
  });

  it("notes a gRPC server and skips it", async () => {
    const grpc = replaced(SERVER, 'type = "openapi"', 'type = "grpc"');
    const head = replaced(SERVER, 'path = "openapi/billing.yaml"', 'path = "proto/billing.proto"', grpc);
    const note = "The check does not compile or replay a gRPC server yet, so it skipped billing.";
    expect(await servers(head)).toEqual({ findings: [], notes: [note] });
    const summary = compileOf(await runChecksWithServers(inputFor(head))).summary;
    expect(summary.endsWith(` ${note}`)).toBe(true);
  });
});

describe("the lock", () => {
  it("warns when tools.toml makes a definition the lock does not pin", async () => {
    const head = replaced(
      TOOLS,
      'description = "Read one charge by its id. Amounts are in cents."',
      'description = "Read one charge by its id."',
    );
    const compile = compileOf(await runChecksWithServers(inputFor(head)));
    expect(compile.status).toBe("warned");
    expect(compile.summary).toBe("1 warning.");
    expect(compile.findings).toEqual([
      expect.objectContaining({
        rule: "lock-current",
        severity: "warning",
        path: TOOLS,
        line: lineStarting(textOf(head, TOOLS), "[tools.get_charge]"),
        field: "tools.get_charge",
        message: "This change makes a new definition for billing__get_charge, and the lock still pins the old one.",
      }),
    ]);
  });

  it("reports an upstream that does not hash to its upstream_hash, and replays nothing", async () => {
    const head = replaced(LOCK, '"description": "Read one refund."', '"description": "Read one refund and its status."');
    const { findings } = await servers(head);
    expect(findings).toEqual([
      expect.objectContaining({
        rule: "lock-upstream-hash",
        path: LOCK,
        line: lineStarting(textOf(head, LOCK), '    "get_refund": {'),
        field: "tools.get_refund.upstream_hash",
      }),
    ]);
  });

  it("reports a lock for another server at its server line", async () => {
    const head = replaced(LOCK, '"server": "billing"', '"server": "payments"');
    const { findings } = await servers(head);
    expect(findings).toEqual([
      expect.objectContaining({
        rule: "lock-server",
        path: LOCK,
        line: 3,
        field: "server",
        message: "The lock is for the server payments, and it sits in the folder for billing.",
      }),
    ]);
  });

  it("reads a lock in another form and reports its server with no line", async () => {
    const value = JSON.parse(textOf(fixtureRepo(), LOCK)) as Record<string, unknown>;
    const { findings } = await servers(withFile(LOCK, JSON.stringify({ ...value, server: "payments" })));
    expect(findings).toEqual([expect.objectContaining({ rule: "lock-server", line: null })]);
  });

  it("compiles and replays against a lock in another form", async () => {
    const minified = JSON.stringify(JSON.parse(textOf(fixtureRepo(), LOCK)));
    expect(await servers(withFile(LOCK, minified))).toEqual({ findings: [], notes: [] });
  });

  it.each(["{", "{}"])("reports a lock that does not parse: %s", async (text) => {
    const { findings } = await servers(withFile(LOCK, text));
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding).toMatchObject({ rule: "lock-parses", path: LOCK });
      expect(finding.message).toMatch(/^The lock does not parse: /);
    }
  });
});

/** The owned check's result in a report. */
function ownedOf(report: CheckReport): CheckResult {
  const result = report.results.find((entry) => entry.check === "owned");
  if (result === undefined) throw new Error("The report has no owned result.");
  return result;
}

const REFUND_ID = "The refund's id, such as re_1.";

/**
 * The billing lock a sync writes once the server describes get_refund's
 * refund_id: the upstream moves, so get_refund's definition changes and its
 * version rises from 1 to 2. MCP Studio's compile() and lock() write it, as
 * sync.ts does.
 */
function syncedBillingLock(): string {
  const production = parseLock(textOf(fixtureRepo(), LOCK));
  const server = parseServerToml(textOf(fixtureRepo(), SERVER));
  const tools = parseToolsToml(textOf(fixtureRepo(), TOOLS));
  if (!production.ok || !server.ok || !tools.ok) throw new Error("The billing fixture does not parse.");
  const moved = JSON.parse(textOf(fixtureRepo(), LOCK)) as {
    tools: Record<string, { upstream: { inputSchema: { properties: Record<string, Record<string, unknown>> } } }>;
  };
  const refundId = moved.tools.get_refund?.upstream.inputSchema.properties.refund_id;
  if (refundId === undefined) throw new Error("The billing lock has no get_refund refund_id.");
  refundId.description = REFUND_ID;
  const upstream = mcpToolsLockSchema.parse(moved);
  const compiled = compileServer({
    server: server.value,
    tools: tools.value,
    upstream: lockedUpstreamTools(upstream),
    security_schemes: lockedSecuritySchemes(upstream),
    descriptor_set: undefined,
  });
  return formatJson(lockServer({ compiled, source: production.value.source, previous: production.value }));
}

describe("the lock a steering PR writes", () => {
  it("passes the lock a sync writes, with the changed tool one version up", async () => {
    const synced = syncedBillingLock();
    const read = parseLock(synced);
    if (!read.ok) throw new Error("The synced lock does not parse.");
    expect(read.value.tools.get_refund?.version).toBe(2);
    expect(read.value.tools.get_charge?.version).toBe(1);

    const head = withFile(LOCK, synced);
    expect(SERVER_READERS.lock?.("billing", head, fixtureRepo())).toEqual({ ok: true });
    const report = await runChecksWithServers(inputFor(head));
    expect(ownedOf(report)).toMatchObject({ status: "passed", findings: [] });
    expect(report.findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  it("refuses a version a person raised by hand", async () => {
    const head = replaced(STRIPE_LOCK, '"version": 3', '"version": 4');
    expect(ownedOf(await runChecksWithServers(inputFor(head))).findings).toEqual([
      expect.objectContaining({
        rule: "oxagen-writes",
        severity: "error",
        path: STRIPE_LOCK,
        line: lineStarting(textOf(head, STRIPE_LOCK), '      "version": 4'),
        message: `This steering PR changes ${STRIPE_LOCK}, and the lock it holds is not one Oxagen writes. stripe__create_refund is at version 4. Its definition_hash is the production lock's, so its version stays 3.`,
      }),
    ]);
  });

  it("refuses a definition change whose version did not rise", async () => {
    const synced = syncedBillingLock();
    const head = withFile(LOCK, synced.replace(/("get_refund": \{[\s\S]*?"version": )2/, (_, entry: string) => `${entry}1`));
    expect(ownedOf(await runChecksWithServers(inputFor(head))).findings).toEqual([
      expect.objectContaining({
        rule: "oxagen-writes",
        message: `This steering PR changes ${LOCK}, and the lock it holds is not one Oxagen writes. billing__get_refund is at version 1. Its definition_hash differs from the production lock's, so its version is 2.`,
      }),
    ]);
  });

  it("refuses a lock not in the form Oxagen writes", async () => {
    const head = replaced(STRIPE_LOCK, '"version": 1\n', '"version": 1 \n');
    const [finding] = ownedOf(await runChecksWithServers(inputFor(head))).findings;
    expect(finding).toMatchObject({ rule: "oxagen-writes", path: STRIPE_LOCK });
    expect(finding?.message).toMatch(/not one Oxagen writes\. tools\.lock\.json is not in the form Oxagen writes, so it was edited by hand\./);
  });

  it("refuses a lock entry for a tool tools.toml does not import", async () => {
    const block = textOf(fixtureRepo(), TOOLS).match(/\[tools\.get_refund\][\s\S]*?\n\n/)?.[0];
    if (block === undefined) throw new Error("tools.toml has no get_refund block.");
    const head = replaced(TOOLS, block, "", withFile(LOCK, syncedBillingLock()));
    const [finding] = ownedOf(await runChecksWithServers(inputFor(head))).findings;
    expect(finding?.message).toContain("The lock holds billing__get_refund, and tools.toml imports no tool keyed get_refund.");
  });

  it("refuses a lock whose source is not the one server.toml names", () => {
    const openapi = textOf(fixtureRepo(), SERVER).replace('name = "billing"', 'name = "stripe"');
    const head = withFile("tools/servers/stripe/server.toml", openapi);
    expect(SERVER_READERS.lock?.("stripe", head, fixtureRepo())).toEqual({
      ok: false,
      problems: ["The lock's source is remote, and server.toml's source is openapi."],
    });
  });

  it("starts each tool of a new server at version 1", async () => {
    const base = without(STRIPE_LOCK, without("tools/servers/stripe/server.toml"));
    expect(ownedOf(await runChecksWithServers(inputFor(fixtureRepo(), { base }))).findings).toEqual([
      expect.objectContaining({
        rule: "oxagen-writes",
        line: 1,
        message: `This steering PR adds ${STRIPE_LOCK}, and the lock it holds is not one Oxagen writes. stripe__create_refund is at version 3, and a tool new to the lock starts at version 1.`,
      }),
    ]);
  });

  it("still refuses a removed lock", async () => {
    const head = without(STRIPE_LOCK);
    expect(ownedOf(await runChecksWithServers(inputFor(head))).findings).toEqual([
      expect.objectContaining({
        rule: "oxagen-writes",
        path: STRIPE_LOCK,
        line: null,
        message: `This steering PR removes ${STRIPE_LOCK}. It holds a server's reviewed upstream definitions, which Oxagen writes when it syncs the server.`,
      }),
    ]);
  });
});

describe("compile", () => {
  it("reports an operation the source does not offer at its field", async () => {
    const head = replaced(TOOLS, 'operation = "getRefund"', 'operation = "voidRefund"');
    const { findings } = await servers(head);
    expect(findings).toEqual([
      expect.objectContaining({
        rule: "server-compiles",
        path: TOOLS,
        line: lineStarting(textOf(head, TOOLS), 'operation = "voidRefund"'),
        field: "tools.get_refund.operation",
        message: "get_refund: the source offers no operation voidRefund.",
      }),
    ]);
  });

  it("reports a scheme the OpenAPI document does not declare on server.toml", async () => {
    const head = replaced(SERVER, 'scheme = "oauth"', 'scheme = "saml"');
    const { findings } = await servers(head);
    expect(findings).toEqual([
      expect.objectContaining({
        rule: "server-compiles",
        path: SERVER,
        line: lineStarting(textOf(head, SERVER), 'scheme = "saml"'),
        field: "auth.scheme",
      }),
    ]);
  });
});

describe("the tool checks", () => {
  const FOUND: LintFinding[] = [
    {
      rule: "no_description",
      level: "error",
      tool: "get_charge",
      field: "description",
      message: "get_charge has no description",
      fix: "Write a description for get_charge",
    },
    {
      rule: "recursive_schema",
      level: "info",
      tool: "list_charges",
      field: undefined,
      message: "list_charges has a schema that refers to itself.",
      fix: "Nothing blocks the merge.",
    },
    {
      rule: "over_definition_budget",
      level: "warning",
      tool: undefined,
      field: "exposure.definition_budget",
      message: "The imported definitions pass the budget.",
      fix: "Set exposure.mode to search.",
    },
    {
      rule: "unknown_credential",
      level: "error",
      tool: undefined,
      field: "auth.credential",
      message: "The vault has no credential named billing-oauth-client.",
      fix: "Add the credential.",
    },
    {
      rule: "tool_not_offered",
      level: "error",
      tool: "get_refund",
      field: "operation",
      message: "get_refund imports operation getRefund, and the source no longer offers it.",
      fix: "Remove [tools.get_refund] from tools.toml.",
    },
  ];

  it("runs MCP Studio's lint when the options name none", async () => {
    const head = replaced(TOOLS, 'select = ["items[].id", "items[].amount", "items[].status"]\n', "");
    const { findings } = await servers(head);
    expect(findings).toEqual([
      expect.objectContaining({
        rule: "lint-unbounded-array",
        severity: "warning",
        path: TOOLS,
        line: lineStarting(textOf(head, TOOLS), "[tools.list_refunds]"),
        field: "tools.list_refunds.select",
        detail: { tool_check: "unbounded_array", level: "warning" },
      }),
    ]);
  });

  it("maps each finding to the file, line, and field it names, and leaves out what other checks report", async () => {
    const lint = vi.fn<ServerLint>((folder) => (folder.name === "billing" ? FOUND : []));
    const { findings } = await servers(fixtureRepo(), { base: null }, lint);
    const tools = textOf(fixtureRepo(), TOOLS);
    expect(findings).toEqual([
      {
        check: "compile",
        rule: "lint-no-description",
        severity: "error",
        path: TOOLS,
        line: lineStarting(tools, 'description = "Read one charge'),
        field: "tools.get_charge.description",
        message: "get_charge has no description.",
        expected: "billing passes the no_description tool check.",
        fix: "Write a description for get_charge.",
        detail: { tool_check: "no_description", level: "error" },
      },
      expect.objectContaining({
        rule: "lint-recursive-schema",
        severity: "warning",
        path: TOOLS,
        line: lineStarting(tools, "[tools.list_charges]"),
        field: "tools.list_charges",
        detail: { tool_check: "recursive_schema", level: "info" },
      }),
      expect.objectContaining({
        rule: "lint-over-definition-budget",
        severity: "warning",
        path: SERVER,
        line: lineStarting(textOf(fixtureRepo(), SERVER), "definition_budget"),
        field: "exposure.definition_budget",
      }),
    ]);
  });

  it("keeps unknown_credential when the run leaves out the references check", async () => {
    const lint = vi.fn<ServerLint>((folder) => (folder.name === "billing" ? FOUND : []));
    const { findings } = await servers(fixtureRepo(), { base: null, checks: ["compile"] }, lint);
    const rules = findings.map((finding) => finding.rule);
    expect(rules).toContain("lint-unknown-credential");
    expect(rules).not.toContain("lint-tool-not-offered");
  });

  it("passes each folder with the lock's tools as offered and the vault's names as references", async () => {
    const lint = vi.fn<ServerLint>(() => []);
    await servers(fixtureRepo(), { base: null }, lint);
    const call = lint.mock.calls.find(([folder]) => folder.name === "billing");
    if (call === undefined) throw new Error("The tool checks did not run on billing.");
    const [folder, lintContext] = call;
    expect(folder.lock?.server).toBe("billing");
    expect(folder.offered).toHaveLength(6);
    expect(lintContext.credentials.has("oxagen:credential/billing-oauth-client")).toBe(true);
    expect(lintContext.credentials.has("billing-oauth-client")).toBe(false);
  });

  it("passes no lock and nothing offered for a folder with no lock", async () => {
    const lint = vi.fn<ServerLint>(() => []);
    expect(await servers(without(LOCK), {}, lint)).toEqual({ findings: [], notes: [] });
    const call = lint.mock.calls.find(([folder]) => folder.name === "billing");
    expect(call?.[0].lock).toBeUndefined();
    expect(call?.[0].offered).toEqual([]);
  });

  it("drops a finding in an unchanged file that the base has too", async () => {
    const [first] = FOUND;
    const lint = vi.fn<ServerLint>(() => (first === undefined ? [] : [first]));
    expect(await servers(appended(singleCall), {}, lint)).toEqual({ findings: [], notes: [] });
    expect(lint).toHaveBeenCalledTimes(2);
  });

  it("keeps a finding in an unchanged file that the base does not have", async () => {
    let runs = 0;
    const lint = vi.fn<ServerLint>(() => {
      runs += 1;
      return runs === 1 ? FOUND.slice(0, 1) : [];
    });
    const { findings } = await servers(appended(singleCall), {}, lint);
    expect(findings.map((finding) => finding.rule)).toEqual(["lint-no-description"]);
  });

  it("runs on no folder when the change leaves every folder alone", async () => {
    const lint = vi.fn<ServerLint>(() => FOUND);
    expect(await servers(fixtureRepo(), {}, lint)).toEqual({ findings: [], notes: [] });
    expect(lint).not.toHaveBeenCalled();
  });
});

describe("runChecksWithServers", () => {
  it("adds the servers half to the compile result and keeps the Cedar note", async () => {
    const report = await runChecksWithServers(inputFor(STUDIO_SOURCE, { cedar: undefined }));
    const compile = compileOf(report);
    expect(report.passed).toBe(false);
    expect(compile.status).toBe("failed");
    expect(compile.summary).toBe(
      "1 error. Oxagen did not evaluate the Cedar policies, because no Cedar evaluator was passed in.",
    );
    expect(report.findings).toContainEqual(expect.objectContaining({ rule: "replay-matches" }));
  });

  it("runs no tool checks when the run leaves out the compile check", async () => {
    const lint = vi.fn<ServerLint>(() => []);
    const input = inputFor(STUDIO_SOURCE, { checks: ["schema"] });
    expect(await runChecksWithServers(input, { lint })).toEqual(runChecks({ ...input, servers: SERVER_READERS }));
    expect(lint).not.toHaveBeenCalled();
  });

  describe("a credential the vault does not hold", () => {
    const head = replaced(
      SERVER,
      'credential = "oxagen:credential/billing-oauth-client"',
      'credential = "oxagen:credential/billing-oauth"',
    );
    const credentialRules = new Set(["credential-exists", "lint-unknown-credential"]);

    it("fails a compile-only run through the tool checks", async () => {
      const compile = compileOf(await runChecksWithServers(inputFor(head, { checks: ["compile"] })));
      expect(compile.findings.filter((finding) => finding.rule === "lint-unknown-credential")).toEqual([
        expect.objectContaining({
          severity: "error",
          path: SERVER,
          line: lineStarting(textOf(head, SERVER), "credential = "),
          field: "auth.credential",
        }),
      ]);
    });

    it("is reported once, by the references check, when every check runs", async () => {
      const report = await runChecksWithServers(inputFor(head));
      const reported = report.findings.filter((finding) => credentialRules.has(finding.rule));
      expect(reported.map((finding) => finding.rule)).toEqual(["credential-exists"]);
    });
  });

  it("reports a folder whose check throws as one internal error on its server.toml", async () => {
    const lint = vi.fn<ServerLint>(() => {
      throw new Error("the tool checks broke");
    });
    const compile = compileOf(await runChecksWithServers(inputFor(appended(singleCall)), { lint }));
    expect(compile.findings).toEqual([
      expect.objectContaining({
        rule: "internal",
        path: SERVER,
        message: "The compile check stopped before it finished: the tool checks broke",
      }),
    ]);
  });

  it("reports one internal error when the servers half cannot start", async () => {
    const broken = { ...context(), credentials: 5 as unknown as string[] };
    const compile = compileOf(await runChecksWithServers(inputFor(appended(singleCall), { context: broken })));
    expect(compile.findings).toContainEqual(expect.objectContaining({ rule: "internal", path: "" }));
  });
});

describe("the readers and the lock helpers", () => {
  it("reads server.toml and tools.toml with MCP Studio's readers", () => {
    expect(SERVER_READERS.server?.(textOf(fixtureRepo(), SERVER))).toEqual({ ok: true });
    expect(SERVER_READERS.tools?.(textOf(fixtureRepo(), TOOLS))).toEqual({ ok: true });
    expect(SERVER_READERS.server?.('schema = "mcp-server/v1"')).toMatchObject({ ok: false });
    expect(SERVER_READERS.tools?.("tools = 5")).toMatchObject({ ok: false });
  });

  it("names the server folders a change touches", () => {
    expect(changedServers(fixtureRepo(), null)).toEqual(["billing", "stripe"]);
    expect(changedServers(fixtureRepo(), fixtureRepo())).toEqual([]);
    expect(changedServers(appended(singleCall), fixtureRepo())).toEqual(["billing"]);
    expect(changedServers(without(STRIPE_LOCK), fixtureRepo())).toEqual(["stripe"]);
  });

  it("reads the upstream tools and security schemes a lock pins", () => {
    const billing = parseLock(textOf(fixtureRepo(), LOCK));
    const stripe = parseLock(textOf(fixtureRepo(), STRIPE_LOCK));
    if (!billing.ok || !stripe.ok) throw new Error("A fixture lock does not parse.");
    expect(lockedUpstreamTools(billing.value).map((tool) => tool.name)).toEqual([
      "cancel_refund",
      "create_refund",
      "get_charge",
      "get_refund",
      "list_charges",
      "list_refunds",
    ]);
    expect(lockedUpstreamTools(stripe.value).map((tool) => tool.name).sort()).toEqual(["create_refund", "list_charges"]);
    expect(Object.keys(lockedSecuritySchemes(billing.value))).toEqual(["oauth"]);
    expect(lockedSecuritySchemes(stripe.value)).toEqual({});
  });
});
