// The kernel seam (ARCHITECTURE.md §3.2): the only path from apps/app to the
// capability kernel's invoke(). A page reads through kernelRead and a server
// action writes through kernelWrite; both run one core:
//
//   0. the ctx must be an instance viewer.ts minted (OrgCtx.is / PretenantCtx.is
//      / InviteeCtx.is), or the call is refused as invalid_ctx;
//   1. both handler registries are loaded, once, before the first invoke();
//   2. the capability must be registered, and its registered declaration is
//      what the runtime checks read (a read must not mutate, a PretenantCtx
//      reaches only an unscoped contract, an InviteeCtx only the two
//      invitation writes);
//   3. the CapabilityContext carries surface "app" and no `opts.surface` is
//      passed, so a contract's surfaces allowlist never refuses the app;
//   4. the kernel enters the tenant scope itself from the ids this context
//      carries, so this module never does;
//   5. a write's input is parsed with the contract's own schema first;
//   6. the output is parsed with the contract's own schema;
//   7. a failure is classified by its `code` property alone, and the seam
//      reads what it records about it (failure-facts.ts, #3841): the rule
//      that refused it, the trace id, the region and the request id.
//
// The in-app agent's refusals have rows of their own (#3227). Before them,
// `engine_unavailable`, `insufficient_credits` and `assistant_spend_cap` fell
// through to `kernel_failure`, so every turn Stella could not answer read "could
// not be reached", whether the engine was down, the ledger refused the run, or
// the organization had no credit left, and the person had no way to tell which.
//
// A refusal that is a programming error (an unbranded ctx, an unregistered or
// wrongly typed contract, output that does not match its contract, a failure
// with no known code) is reported to telemetry exactly once.
import "server-only";
import {
  type CapabilityContext,
  type CapabilityDeclaration,
  capabilityMutates,
  getCapability,
  invoke,
  ORG_ONLY_WORKSPACE_ID,
} from "@oxagen/oxagen";
import type { orgMemberInviteAccept } from "@oxagen/oxagen/contracts/org.member_invite.accept";
import type { orgMemberInviteDecline } from "@oxagen/oxagen/contracts/org.member_invite.decline";
import { captureError } from "@oxagen/telemetry";
import { cache } from "react";
import {
  type DecidedBy,
  PAGE_FAILURES,
  type PageKey,
  type Read,
  type ReadFailureFacts,
  readError,
} from "@/data/read";
import { decidedByOf, failureFacts } from "./failure-facts";
import { InviteeCtx, OrgCtx, PretenantCtx, WsCtx } from "./viewer";

type SafeParse<T> =
  | { success: true; data: T }
  | {
      success: false;
      error: { issues: readonly { readonly path: readonly PropertyKey[] }[] };
    };

/**
 * An agent tool contract, structurally. The contracts are zod 3.25 in
 * @oxagen/oxagen and the app is zod 4; both lines carry `_input`/`_output` and
 * `safeParse`, so the seam never mixes schema objects across them.
 */
export type ToolContract<I, O> = {
  readonly name: string;
  readonly input: {
    readonly _input: I;
    safeParse(value: unknown): SafeParse<unknown>;
  };
  readonly output: {
    readonly _output: O;
    safeParse(value: unknown): SafeParse<O>;
  };
};
/** `registerCapability` keeps the boolean literal, so only a contract declaring `mutates: false` fits. */
export type ReadContract<I, O> = ToolContract<I, O> & {
  readonly mutates: false;
};
/** create_org, list_orgs, list_workspaces: the contracts declared `scoped: false`. */
export type UnscopedContract<I, O> = ToolContract<I, O> & {
  readonly scoped: false;
};
export type UnscopedReadContract<I, O> = ReadContract<I, O> &
  UnscopedContract<I, O>;
export type ContractOutput<C> = C extends { output: { _output: infer O } }
  ? O
  : never;
/** The two writes an invitee may make. A contract's `name` widens to string, so the overload names the declarations. */
type InvitationContract =
  | typeof orgMemberInviteAccept
  | typeof orgMemberInviteDecline;

/**
 * What a failed write carries about its failure, each only when it was
 * recorded (#3841).
 */
type ActionFailureFacts = {
  /** The rule that refused a denied write, when the refusal named one. */
  decidedBy?: DecidedBy;
  /** The trace the failed write ran under, when a tracer recorded one. */
  traceId?: string;
  /** The region that answered, when the process knows it. */
  region?: string;
};

export type ActionResult<O> =
  | { ok: true; value: O }
  | ({
      ok: false;
      reason: "denied" | "invalid" | "not_found" | "conflict" | "unavailable";
      code: string;
      field?: string;
    } & ActionFailureFacts)
  | { ok: false; reason: "pending_approval"; accessRequestId: string }
  | {
      ok: false;
      reason: "exhausted";
      code:
        | "gau_exhausted"
        | "billing_suspended"
        | "budget_exceeded"
        | "insufficient_credits"
        | "assistant_spend_cap"
        | "assistant_model_key_limit";
    };

type ExhaustedCode = Extract<
  ActionResult<never>,
  { reason: "exhausted" }
>["code"];

/** One classified failure, rendered by kernelRead as a Read and by kernelWrite as an ActionResult. */
type FailureKind =
  | { kind: "denied"; code: string }
  | { kind: "pending_approval"; accessRequestId: string }
  | { kind: "invalid"; field?: string }
  | { kind: "not_found" | "conflict"; code: string }
  | { kind: "exhausted"; code: ExhaustedCode }
  | { kind: "unavailable"; code: string; status: number }
  | { kind: "unclassified" };

/**
 * A failure and what the seam recorded about it (#3841). `facts` is present
 * when the kernel ran and failed, and absent for a refusal the seam made
 * before it (an unbranded ctx, an unregistered contract). `decidedBy` is the
 * rule a denial names, null when it names none.
 */
type Failure = FailureKind & {
  facts?: ReadFailureFacts;
  decidedBy?: DecidedBy | null;
};

type Outcome<O> = { ok: true; value: O } | { ok: false; failure: Failure };

const EXHAUSTED_CODES: readonly string[] = [
  "gau_exhausted",
  "billing_suspended",
  "budget_exceeded",
  // The in-app agent's credit gate (`@oxagen/billing` turn-credit-gate.ts):
  // the organization's credit balance is empty, or it spent its monthly cap
  // of platform-paid agent tokens (ADR-053 §3).
  "insufficient_credits",
  "assistant_spend_cap",
  // The key Oxagen minted for the organization reached its daily ceiling
  // (`@oxagen/ai` assistant-model-key-limit.ts, ADR-131 §3).
  "assistant_model_key_limit",
] satisfies readonly ExhaustedCode[];

/**
 * The in-app agent's service failures (`@oxagen/agent`), with the status the
 * API gives each (`apps/api/src/middleware/error.ts`,
 * `ASSISTANT_TURN_ERROR_STATUS`). The engine is down or unconfigured, the
 * evidence ledger would not admit the turn as a run, or the model provider
 * failed the call: the service could not answer, and the code says which part
 * of it.
 */
const ASSISTANT_SERVICE_CODES: Readonly<Record<string, number>> = {
  engine_unavailable: 503,
  assistant_run_not_recorded: 503,
  // The model provider refused or failed a call the engine asked for
  // (`@oxagen/agent` governed-turn.ts, `ModelCallFailedError`).
  model_call_failed: 502,
};

const isExhaustedCode = (code: string): code is ExhaustedCode =>
  EXHAUSTED_CODES.includes(code);

const stringField = (value: object, key: string): string | null => {
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : null;
};

/**
 * The §3.2 table, keyed on the error's `code` property. A kernel module can be
 * evaluated twice in one process (RSC and SSR graphs, a test's fresh graph), so
 * no row uses `instanceof`, and no row reads message text.
 */
function classifyKernelFailure(err: unknown): FailureKind {
  if (typeof err !== "object" || err === null) return { kind: "unclassified" };
  const code = stringField(err, "code");
  switch (code) {
    case "authz_denied":
    case "capability_not_installed":
    case "no_handler":
      return { kind: "denied", code };
    // A workspace decision rule refused the call (@oxagen/rules). The app has
    // no approval channel for a rule, so one that wants a person refuses too.
    // Before these rows a rule's refusal read as the page's outage and was
    // reported to telemetry as unclassified (#3841).
    case "decision_rule_denied":
    case "decision_rule_approval_required":
      return { kind: "denied", code };
    case "pending_approval": {
      // The kernel still denies when it could not create the access request;
      // with no id there is nothing to wait on.
      const accessRequestId = stringField(err, "accessRequestId");
      return accessRequestId === null
        ? { kind: "denied", code }
        : { kind: "pending_approval", accessRequestId };
    }
    case "invalid_input":
      return { kind: "invalid" };
    case "invalid_output":
      return {
        kind: "unavailable",
        code: "contract_output_mismatch",
        status: 502,
      };
    // A HandlerError names the refusal in `reason` (last_owner, approval_expired).
    case "forbidden":
      return { kind: "denied", code: stringField(err, "reason") ?? code };
    case "not_found":
    case "conflict":
      return { kind: code, code: stringField(err, "reason") ?? code };
    // A turn the engine stopped before it answered: a per-turn budget stop
    // or a cancel. It conflicts with the state it was asked in.
    case "engine_aborted":
      return { kind: "conflict", code };
    case null:
      return { kind: "unclassified" };
    default: {
      if (isExhaustedCode(code)) return { kind: "exhausted", code };
      const status = ASSISTANT_SERVICE_CODES[code];
      return status === undefined
        ? { kind: "unclassified" }
        : { kind: "unavailable", code, status };
    }
  }
}

function report(error: unknown, capability: string): void {
  captureError({ error, source: "app", capability, context: "kernel seam" });
}

/** A programming error the core refuses before the kernel runs. */
function refuse(code: string, capability: string): RawOutcome {
  report(new Error(code), capability);
  return { ok: false, failure: { kind: "unavailable", code, status: 500 } };
}

type Viewer = OrgCtx | PretenantCtx | InviteeCtx;

function capabilityContext(ctx: Viewer): CapabilityContext {
  const base = {
    userId: ctx.userId,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
    surface: "app",
    messageId: null,
  } as const;
  if (PretenantCtx.is(ctx)) return { ...base, orgId: "", workspaceId: "" };
  return {
    ...base,
    orgId: ctx.orgId,
    // An OrgCtx names no workspace: the shared org-only sentinel (#3029).
    workspaceId: WsCtx.is(ctx) ? ctx.workspaceId : ORG_ONLY_WORKSPACE_ID,
  };
}

let registries: Promise<unknown> | null = null;

function loadRegistries(): Promise<unknown> {
  registries ??= Promise.all([
    import("@oxagen/handlers/register"),
    import("@oxagen/agent/register"),
  ]);
  return registries;
}

const INVITATION_TOOLS: readonly string[] = [
  "accept_member_invite",
  "decline_member_invite",
];

/** The runtime twin of the overloads: which registered contracts a ctx may reach. */
function contractRefusal(
  ctx: Viewer,
  cap: CapabilityDeclaration,
  side: "read" | "write",
): string | null {
  if (side === "read" && capabilityMutates(cap)) return "contract_mutates";
  if (PretenantCtx.is(ctx) && cap.scoped !== false) return "contract_scoped";
  if (InviteeCtx.is(ctx) && !INVITATION_TOOLS.includes(cap.name))
    return "contract_not_invitation";
  return null;
}

/**
 * What the kernel answered, before any contract has parsed it. The raw record
 * carries no type parameter, which is what lets one read be shared between
 * callers: each parses it with its own contract's output schema afterwards, so
 * the sharing never hands anyone a value its contract has not checked.
 */
type RawOutcome = { ok: true; raw: unknown } | { ok: false; failure: Failure };

/** Everything up to and including invoke(): the guards, then the kernel. */
async function invokeKernel(
  ctx: unknown,
  contract: ToolContract<unknown, unknown>,
  input: unknown,
  side: "read" | "write",
): Promise<RawOutcome> {
  const minted =
    OrgCtx.is(ctx) ||
    PretenantCtx.is(ctx) ||
    (side === "write" && InviteeCtx.is(ctx));
  if (!minted) return refuse("invalid_ctx", contract.name);

  await loadRegistries();
  const cap = getCapability(contract.name);
  if (!cap) return refuse("tool_not_registered", contract.name);
  const refusal = contractRefusal(ctx, cap, side);
  if (refusal !== null) return refuse(refusal, contract.name);

  if (side === "write") {
    const parsed = contract.input.safeParse(input);
    if (!parsed.success) {
      const field = parsed.error.issues.at(0)?.path.map(String).join(".") ?? "";
      return { ok: false, failure: { kind: "invalid", field } };
    }
  }

  const context = capabilityContext(ctx);
  try {
    return {
      ok: true,
      raw: await invoke(contract.name, input, context),
    };
  } catch (err) {
    const kind = classifyKernelFailure(err);
    if (kind.kind === "unavailable" || kind.kind === "unclassified")
      report(err, contract.name);
    // Read now, inside the request that failed, while its trace is active.
    const failure: Failure = {
      ...kind,
      facts: failureFacts(context.requestId),
      ...(kind.kind === "denied" ? { decidedBy: decidedByOf(err) } : {}),
    };
    return { ok: false, failure };
  }
}

async function run<O>(
  ctx: unknown,
  contract: ToolContract<unknown, O>,
  input: unknown,
  side: "read" | "write",
): Promise<Outcome<O>> {
  const outcome =
    side === "read"
      ? await sharedInvoke(ctx, contract, input)
      : await invokeKernel(ctx, contract, input, side);
  if (!outcome.ok) return outcome;

  const output = contract.output.safeParse(outcome.raw);
  if (!output.success) {
    report(output.error, contract.name);
    return {
      ok: false,
      failure: {
        kind: "unavailable",
        code: "contract_output_mismatch",
        status: 502,
      },
    };
  }
  return { ok: true, value: output.data };
}

/**
 * The kinds `toRead` folds into a `ReadError`, keyed by the status it gives each.
 *
 * `Read` has four variants and none of them is `not_found`, `conflict` or
 * `invalid`: a page renders all three the same way, as an error with a status.
 * So `toRead` keeps the handler's reason in `code` (`github_not_connected`,
 * `branch_not_found`) and the kind survives only in the status. A converter
 * that read `reason` alone would call a missing row unavailable, which tells a
 * person to come back for something that was never there and hides a 404
 * behind a 503; one that keyed on `code` would drop the reason the page's
 * failure sentences are written for.
 */
const READ_REASON_BY_STATUS: Record<
  number,
  "not_found" | "conflict" | "invalid"
> = {
  404: "not_found",
  409: "conflict",
  400: "invalid",
};

/**
 * A read's refusal in a write's shape.
 *
 * INV-19 has every exported function of a `"use server"` module answer with an
 * `ActionResult`, so an action that reads has to carry its `Read` across.
 * `denied` keeps the permission its page failure names, and an error keeps its
 * code plus, through the table above, the kind that code encodes.
 *
 * It lives here, beside `toRead` which produces the value, because the two are
 * one encoding read from both ends. It was written out separately in
 * `account-actions.ts` and the Workspace settings actions (now
 * `features/repositories/actions.ts`), and both copies
 * collapsed every error to `unavailable`.
 */
export function readToActionResult<T>(read: Read<T>): ActionResult<T> {
  if (read.ok) return read;
  switch (read.reason) {
    case "denied":
      return {
        ok: false,
        reason: "denied",
        code: read.permission,
        ...(read.decidedBy ? { decidedBy: read.decidedBy } : {}),
      };
    case "pending_approval":
      return {
        ok: false,
        reason: "pending_approval",
        accessRequestId: read.accessRequestId,
      };
    case "error":
      return {
        ok: false,
        reason: READ_REASON_BY_STATUS[read.status] ?? "unavailable",
        code: read.code,
        ...(read.traceId ? { traceId: read.traceId } : {}),
        ...(read.region ? { region: read.region } : {}),
      };
  }
}

function toRead<O>(outcome: Outcome<O>, page: PageKey): Read<O> {
  if (outcome.ok) return outcome;
  const { failure } = outcome;
  // The facts ride every denial and error the kernel answered (#3841).
  const facts = failure.facts;
  switch (failure.kind) {
    case "denied":
      return {
        ok: false,
        reason: "denied",
        permission: PAGE_FAILURES[page].permission,
        ...(facts === undefined
          ? {}
          : { decidedBy: failure.decidedBy ?? null, ...facts }),
      };
    case "pending_approval":
      return {
        ok: false,
        reason: "pending_approval",
        accessRequestId: failure.accessRequestId,
      };
    case "invalid":
      return readError("invalid_input", 400, facts);
    // The handler's reason rides in `code`; the status carries the kind.
    case "not_found":
      return readError(failure.code, 404, facts);
    case "conflict":
      return readError(failure.code, 409, facts);
    case "unavailable":
      return readError(failure.code, failure.status, facts);
    // No read the app binds can be refused for GAUs (every one is noBillingGate).
    case "exhausted":
    case "unclassified":
      return readError(
        PAGE_FAILURES[page].error.code,
        PAGE_FAILURES[page].error.status,
        facts,
      );
  }
}

/**
 * The facts a write's failure carries: only those recorded. An action result
 * crosses to the browser, and a field that says "not recorded" helps no
 * toast, so a null fact is left out rather than sent (#3841).
 */
function recordedFacts(failure: Failure): ActionFailureFacts {
  const decidedBy = failure.decidedBy ?? null;
  const traceId = failure.facts?.traceId ?? null;
  const region = failure.facts?.region ?? null;
  return {
    ...(decidedBy === null ? {} : { decidedBy }),
    ...(traceId === null ? {} : { traceId }),
    ...(region === null ? {} : { region }),
  };
}

function toActionResult<O>(outcome: Outcome<O>): ActionResult<O> {
  if (outcome.ok) return outcome;
  const { failure } = outcome;
  switch (failure.kind) {
    case "denied":
    case "not_found":
    case "conflict":
      return {
        ok: false,
        reason: failure.kind,
        code: failure.code,
        ...recordedFacts(failure),
      };
    case "exhausted":
      return { ok: false, reason: "exhausted", code: failure.code };
    case "pending_approval":
      return {
        ok: false,
        reason: "pending_approval",
        accessRequestId: failure.accessRequestId,
      };
    case "invalid":
      return {
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        ...(failure.field === undefined ? {} : { field: failure.field }),
      };
    case "unavailable":
      return {
        ok: false,
        reason: "unavailable",
        code: failure.code,
        ...recordedFacts(failure),
      };
    case "unclassified":
      return {
        ok: false,
        reason: "unavailable",
        code: "kernel_failure",
        ...recordedFacts(failure),
      };
  }
}

/**
 * The reads already served in this request, keyed by `readKey`.
 *
 * `cache` gives one table per request, the way session.ts and viewer.ts hold
 * the session and the viewer; outside a request React hands back a fresh table
 * on every call, so nothing is shared between tests or across requests.
 *
 * A read is pure for the length of one render, so a page that reads the same
 * record twice should pay for it once. The Billing page is the case that
 * forced it: the plan card and the usage credit balance are two mappings of
 * one `get_subscription` record, whose handler aggregates token usage over
 * ClickHouse on every invocation, and INV-06 requires each port method under
 * src/data/live to make its own `kernelRead` call — so the adapter cannot
 * dedup and the seam is the layer that can (§3.2, §3.9).
 *
 * What is shared is the RawOutcome, before any contract has parsed it: every
 * caller still parses the record with its own output schema, so sharing never
 * skips a contract check. The promise is held rather than the value, so two
 * reads in flight at once share one invoke, and a refusal is shared the same
 * way — `invokeKernel` resolves rather than rejects, so nothing poisons it.
 */
const readsThisRequest = cache(
  (): Map<string, Promise<RawOutcome>> => new Map(),
);

/**
 * The key two reads must share to be the same read: same viewer, same
 * contract, same input.
 *
 * `page` is not part of it: it selects the wording of a refusal, not the
 * record, and the record is what is shared. The input is compared by its JSON,
 * so the match is conservative — a value that will not serialise, or one input
 * spelled with its keys in another order, reads again rather than sharing.
 * Missing a share costs what the app does today; a wrong share would hand one
 * caller another's record, so the comparison never widens.
 */
function readKey(
  ctx: OrgCtx | PretenantCtx,
  contract: { name: string },
  input: unknown,
): string | null {
  let serialised: string;
  try {
    serialised = JSON.stringify(input);
  } catch {
    // An input with a cycle or a bigint in it is simply not shared.
    return null;
  }
  const viewer = PretenantCtx.is(ctx)
    ? `pretenant:${ctx.userId}`
    : `${ctx.userId}:${ctx.orgId}:${WsCtx.is(ctx) ? ctx.workspaceId : ""}`;
  return [viewer, contract.name, serialised].join("\u0000");
}

/** `invokeKernel` for a read, served once per request when it can be keyed. */
async function sharedInvoke(
  ctx: unknown,
  contract: ToolContract<unknown, unknown>,
  input: unknown,
): Promise<RawOutcome> {
  const keyable = OrgCtx.is(ctx) || PretenantCtx.is(ctx);
  const key = keyable ? readKey(ctx, contract, input) : null;
  if (key === null) return invokeKernel(ctx, contract, input, "read");

  const served = readsThisRequest();
  const inFlight = served.get(key);
  if (inFlight !== undefined) return inFlight;

  const pending = invokeKernel(ctx, contract, input, "read");
  served.set(key, pending);
  return pending;
}

export function kernelRead<I, O>(
  ctx: OrgCtx | WsCtx,
  call: { contract: ReadContract<I, O>; input: NoInfer<I>; page: PageKey },
): Promise<Read<O>>;
/** Pre-tenant reads: only contracts declared `scoped: false` (list_orgs, list_workspaces). */
export function kernelRead<I, O>(
  ctx: PretenantCtx,
  call: {
    contract: UnscopedReadContract<I, O>;
    input: NoInfer<I>;
    page: PageKey;
  },
): Promise<Read<O>>;
export async function kernelRead<I, O>(
  ctx: OrgCtx | PretenantCtx,
  read: { contract: ReadContract<I, O>; input: I; page: PageKey },
): Promise<Read<O>> {
  return toRead(await run(ctx, read.contract, read.input, "read"), read.page);
}

export function kernelWrite<I, O>(
  ctx: OrgCtx | WsCtx,
  contract: ToolContract<I, O>,
  input: NoInfer<I>,
): Promise<ActionResult<O>>;
/** Pre-tenant writes: only contracts declared `scoped: false` (create_org). */
export function kernelWrite<I, O>(
  ctx: PretenantCtx,
  contract: UnscopedContract<I, O>,
  input: NoInfer<I>,
): Promise<ActionResult<O>>;
/** An invitee reaches accept_member_invite and decline_member_invite alone. */
export function kernelWrite<C extends InvitationContract>(
  ctx: InviteeCtx,
  contract: C,
  input: NoInfer<C["input"]["_input"]>,
): Promise<ActionResult<ContractOutput<C>>>;
export async function kernelWrite<I, O>(
  ctx: Viewer,
  contract: ToolContract<I, O>,
  input: I,
): Promise<ActionResult<O>> {
  return toActionResult(await run(ctx, contract, input, "write"));
}
