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
//   7. a failure is classified by its `code` property alone.
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
import { PAGE_FAILURES, type PageKey, type Read, readError } from "@/data/read";
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

export type ActionResult<O> =
  | { ok: true; value: O }
  | {
      ok: false;
      reason: "denied" | "invalid" | "not_found" | "conflict" | "unavailable";
      code: string;
      field?: string;
    }
  | { ok: false; reason: "pending_approval"; accessRequestId: string }
  | {
      ok: false;
      reason: "exhausted";
      code: "gau_exhausted" | "billing_suspended" | "budget_exceeded";
    };

type ExhaustedCode = Extract<
  ActionResult<never>,
  { reason: "exhausted" }
>["code"];

/** One classified failure, rendered by kernelRead as a Read and by kernelWrite as an ActionResult. */
type Failure =
  | { kind: "denied"; code: string }
  | { kind: "pending_approval"; accessRequestId: string }
  | { kind: "invalid"; field?: string }
  | { kind: "not_found" | "conflict"; code: string }
  | { kind: "exhausted"; code: ExhaustedCode }
  | { kind: "unavailable"; code: string; status: number }
  | { kind: "unclassified" };

type Outcome<O> = { ok: true; value: O } | { ok: false; failure: Failure };


const EXHAUSTED_CODES: readonly string[] = [
  "gau_exhausted",
  "billing_suspended",
  "budget_exceeded",
] satisfies readonly ExhaustedCode[];

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
function classifyKernelFailure(err: unknown): Failure {
  if (typeof err !== "object" || err === null) return { kind: "unclassified" };
  const code = stringField(err, "code");
  switch (code) {
    case "authz_denied":
    case "capability_not_installed":
    case "no_handler":
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
    case null:
      return { kind: "unclassified" };
    default:
      return isExhaustedCode(code)
        ? { kind: "exhausted", code }
        : { kind: "unclassified" };
  }
}

function report(error: unknown, capability: string): void {
  captureError({ error, source: "app", capability, context: "kernel seam" });
}

/** A programming error the core refuses before the kernel runs. */
function refuse<O>(code: string, capability: string): Outcome<O> {
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

async function run<O>(
  ctx: unknown,
  contract: ToolContract<unknown, O>,
  input: unknown,
  side: "read" | "write",
): Promise<Outcome<O>> {
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

  let raw: unknown;
  try {
    raw = await invoke(contract.name, input, capabilityContext(ctx));
  } catch (err) {
    const failure = classifyKernelFailure(err);
    if (failure.kind === "unavailable" || failure.kind === "unclassified")
      report(err, contract.name);
    return { ok: false, failure };
  }

  const output = contract.output.safeParse(raw);
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

function toRead<O>(outcome: Outcome<O>, page: PageKey): Read<O> {
  if (outcome.ok) return outcome;
  const { failure } = outcome;
  switch (failure.kind) {
    case "denied":
      return {
        ok: false,
        reason: "denied",
        permission: PAGE_FAILURES[page].permission,
      };
    case "pending_approval":
      return {
        ok: false,
        reason: "pending_approval",
        accessRequestId: failure.accessRequestId,
      };
    case "invalid":
      return readError("invalid_input", 400);
    case "not_found":
      return readError("not_found", 404);
    case "conflict":
      return readError("conflict", 409);
    case "unavailable":
      return readError(failure.code, failure.status);
    // No read the app binds can be refused for GAUs (every one is noBillingGate).
    case "exhausted":
    case "unclassified":
      return readError(
        PAGE_FAILURES[page].error.code,
        PAGE_FAILURES[page].error.status,
      );
  }
}

function toActionResult<O>(outcome: Outcome<O>): ActionResult<O> {
  if (outcome.ok) return outcome;
  const { failure } = outcome;
  switch (failure.kind) {
    case "denied":
    case "not_found":
    case "conflict":
      return { ok: false, reason: failure.kind, code: failure.code };
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
      return { ok: false, reason: "unavailable", code: failure.code };
    case "unclassified":
      return { ok: false, reason: "unavailable", code: "kernel_failure" };
  }
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
  call: { contract: ReadContract<I, O>; input: I; page: PageKey },
): Promise<Read<O>> {
  return toRead(await run(ctx, call.contract, call.input, "read"), call.page);
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
