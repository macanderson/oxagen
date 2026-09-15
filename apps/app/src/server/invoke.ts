// invokeTool: the invitation writes go through here until WL-11 replaces this
// module with src/server/kernel.ts (plan §0.4, §4.6).
//
// One agent tool contract drives API, MCP, CLI and UI (spec §14.1), so a page
// write is a kernel `invoke()` of the same contract, never a hand-rolled query.
// Two rules this seam enforces:
//
//   1. The result is PARSED with the contract's own output schema, never cast.
//      A mismatch throws ContractOutputMismatch and the value never reaches the
//      caller.
//   2. No `opts.surface` is claimed: app-side invokes are not surface-denied for
//      api-only contracts (dispatch_tacho_command). IAM still decides.
//
// The handler registry (`@oxagen/handlers/register`) is imported once, before
// the first `invoke()`: forgetting it silently no-ops the handlers.
import "server-only";
import { type CapabilityContext, getCapability, invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import { ContractOutputMismatch, ToolNotRegistered } from "./errors";
import type { InviteeCtx } from "./viewer";

/**
 * The workspace id an organization-level invoke runs under. Organization-scoped
 * tables (`org_only` under RLS) ignore the workspace GUC; the sentinel keeps
 * `runInTenantScope`'s UUID assertion satisfied without naming a real workspace.
 */
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: readonly unknown[] } };

/**
 * An agent tool contract, structurally. `registerCapability()` returns the
 * declaration itself, whose schemas are zod 3.25 in @oxagen/oxagen; the app is
 * on zod 4. Both lines carry `_input`/`_output` and `safeParse`, so the seam
 * never has to agree on a zod version or mix schema objects across them.
 */
export type ToolContract<I, O> = {
  readonly name: string;
  readonly input: {
    readonly _input: I;
    safeParse(value: unknown): SafeParseResult<unknown>;
  };
  readonly output: {
    readonly _output: O;
    safeParse(value: unknown): SafeParseResult<O>;
  };
};

let handlersRegistered: Promise<unknown> | null = null;

function registerHandlers(): Promise<unknown> {
  handlersRegistered ??= import("@oxagen/handlers/register");
  return handlersRegistered;
}

function parseOutput<O>(contract: ToolContract<unknown, O>, raw: unknown): O {
  const parsed = contract.output.safeParse(raw);
  if (!parsed.success)
    throw new ContractOutputMismatch(contract.name, parsed.error.issues);
  return parsed.data;
}

export async function invokeTool<I, O>(
  viewer: InviteeCtx,
  contract: ToolContract<I, O>,
  input: NoInfer<I>,
): Promise<O> {
  await registerHandlers();
  if (!getCapability(contract.name)) throw new ToolNotRegistered(contract.name);

  const scope = { orgId: viewer.orgId, workspaceId: ORG_ONLY_WS };
  const ctx: CapabilityContext = {
    ...scope,
    userId: viewer.userId,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
    surface: "app",
    messageId: null,
  };
  const raw = await runInTenantScope(scope, () =>
    invoke(contract.name, input, ctx),
  );
  return parseOutput(contract, raw);
}
