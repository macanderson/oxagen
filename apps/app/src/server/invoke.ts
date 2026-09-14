// invokeTool: every write in the app goes through here (plan §0.4, §4.6).
//
// One agent tool contract drives API, MCP, CLI and UI (spec §14.1), so a page
// write is a kernel `invoke()` of the same contract, never a hand-rolled query.
// Three rules this seam enforces:
//
//   1. The result is PARSED with the contract's own output schema, never cast.
//      A mismatch throws ContractOutputMismatch and the value never reaches the
//      caller.
//   2. In fixture mode the kernel is never reached. instrumentation.ts skips the
//      IAM, billing, entitlement and decision-rules bootstraps there (no
//      Postgres), so a kernel call would run with no IAM runtime and fall open.
//      The write goes to a registered fixture write adapter, which records it,
//      or it throws FixtureWriteRefused.
//   3. No `opts.surface` is claimed: app-side invokes are not surface-denied for
//      api-only contracts (dispatch_tacho_command). IAM still decides.
//
// The handler registry (`@oxagen/handlers/register`) is imported on the live
// path, once, before the first `invoke()`: forgetting it silently no-ops the
// handlers. It is not imported in fixture mode, which never invokes and has no
// stores for the handler packages to reach.
import "server-only";
import { type CapabilityContext, getCapability, invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  ContractOutputMismatch,
  FixtureWriteRefused,
  ToolInputInvalid,
  ToolNotRegistered,
} from "./errors";
import { isFixtureMode } from "./fixture-session";
import type { Viewer } from "./viewer-resolution";

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

/** A write the fixture adapter receives in place of a kernel call. */
export type FixtureWriteCall = {
  tool: string;
  /** The input after the contract's input schema accepted it. */
  input: unknown;
  userId: string;
  scope: Viewer["scope"];
};

/**
 * Records a fixture-mode write and returns what the tool would return. Its
 * return value is parsed with the contract's output schema like a kernel result.
 */
export type FixtureWriteAdapter = (call: FixtureWriteCall) => Promise<unknown>;

let fixtureWriteAdapter: FixtureWriteAdapter | null = null;

/**
 * Register (or clear, with null) the fixture write adapter. Consulted only
 * while isFixtureMode() is true, which a production build never is, so an
 * adapter registered by mistake in production is inert.
 */
export function setFixtureWriteAdapter(
  adapter: FixtureWriteAdapter | null,
): void {
  fixtureWriteAdapter = adapter;
}

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

async function invokeFixture<O>(
  viewer: Viewer,
  contract: ToolContract<unknown, O>,
  input: unknown,
): Promise<O> {
  const adapter = fixtureWriteAdapter;
  if (!adapter) throw new FixtureWriteRefused(contract.name);
  const accepted = contract.input.safeParse(input);
  if (!accepted.success)
    throw new ToolInputInvalid(contract.name, accepted.error.issues);
  const raw = await adapter({
    tool: contract.name,
    input: accepted.data,
    userId: viewer.userId,
    scope: viewer.scope,
  });
  return parseOutput(contract, raw);
}

export async function invokeTool<I, O>(
  viewer: Viewer,
  contract: ToolContract<I, O>,
  input: NoInfer<I>,
): Promise<O> {
  if (isFixtureMode()) return invokeFixture(viewer, contract, input);

  await registerHandlers();
  if (!getCapability(contract.name)) throw new ToolNotRegistered(contract.name);

  const ctx: CapabilityContext = {
    orgId: viewer.scope.orgId,
    workspaceId: viewer.scope.workspaceId,
    userId: viewer.userId,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
    surface: "app",
    messageId: null,
  };
  const raw = await runInTenantScope(viewer.scope, () =>
    invoke(contract.name, input, ctx),
  );
  return parseOutput(contract, raw);
}
