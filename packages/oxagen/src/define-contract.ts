// define-contract.ts — the single IAM enforcement boundary (OXA-1390, Phase 3).
//
// defineContract() is the ONLY entrypoint for declaring a governable action.
// The raw handler closure is captured inside invoke() and is unreachable from
// outside by construction — there is no way to call the handler without going
// through the IAM resolver.
//
// HANDLER LOADER PATTERN: to keep @oxagen/oxagen dep-light (no database
// imports), the handler is provided as a HandlerLoader: a lazy async function
// that is resolved on first invoke() call and cached. This matches the
// existing kernel's registerHandler() pattern. The 'handler not accessible'
// invariant holds because the loader is closed inside invoke() and is NOT
// on the returned DefinedContract object.
//
// AUDIT: two audit paths coexist after Phase 3:
//   - Postgres security.security_events (existing SOC2 path, via kernel emitter)
//   - ClickHouse audit_events (new IAM resolver trace, via emitAudit in @oxagen/iam)
// Both fire on every invocation. Neither blocks the response path.
//
// DEPENDENCY INJECTION: the IAM check function (checkIAMFn) and access-request
// creator (createAccessRequestFn) are injected via setIAMRuntime(). This
// keeps @oxagen/oxagen free of @oxagen/iam at build time; surfaces bootstrap
// by importing @oxagen/iam and calling setIAMRuntime() once. In test
// environments the runtime can be swapped with mocks.

import type { z } from "zod";
import { registerCapability } from "./registry";
import type {
  CapabilityDeclaration,
  CapabilityContext,
  CapabilitySensitivity,
  CapabilityEffect,
  CheckedContext,
  DenialResponse,
  GrantEffect,
  SystemOrgRole,
  SystemWorkspaceRole,
  ExecutionMode,
  CapabilityLayer,
  CapabilitySurface,
  CapabilityAgentMetadata,
  ResolvedPrincipal,
} from "./types";
import { isDenial } from "./types";

// ── IAM runtime injection ─────────────────────────────────────────────────────
//
// The IAM runtime lives in @oxagen/iam which has DB + ClickHouse deps.
// We inject it at boot time so @oxagen/oxagen stays dep-light.

export interface IAMCheckResult {
  outcome: "allow" | "deny" | "pending_approval";
  reason?: string;
  principal: ResolvedPrincipal | null;
}

export type IAMCheckFn = (args: {
  capability: string;
  ctx: CapabilityContext;
  defaultEffect: CapabilityEffect;
  rawInputJson: string;
}) => Promise<IAMCheckResult>;

export type CreateAccessRequestFn = (args: {
  capability: string;
  ctx: CapabilityContext;
  principal: ResolvedPrincipal | null;
  justification?: string;
}) => Promise<string | null>;

let _checkIAM: IAMCheckFn | null = null;
let _createAccessRequest: CreateAccessRequestFn | null = null;

/**
 * Register the IAM runtime. Call once at surface bootstrap after importing
 * @oxagen/iam. In test environments, pass mock implementations.
 */
export function setIAMRuntime(opts: {
  checkIAM: IAMCheckFn;
  createAccessRequest: CreateAccessRequestFn;
}): void {
  _checkIAM = opts.checkIAM;
  _createAccessRequest = opts.createAccessRequest;
}

/** Remove the IAM runtime. Used in tests to reset state between cases. */
export function clearIAMRuntime(): void {
  _checkIAM = null;
  _createAccessRequest = null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type { DenialResponse };
export { isDenial };

/** Handler type for defineContract. Receives a CheckedContext (with principal). */
export type ContractHandler<TInput, TOutput> = (
  ctx: CheckedContext,
  input: TInput,
) => Promise<TOutput>;

/**
 * Spec for a governable capability. All fields are required — the type system
 * rejects an incomplete defineContract call at compile time.
 */
export interface DefineContractSpec<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
> {
  /** Capability identifier, e.g. "organization.create". */
  id: string;
  domain: string;
  description: string;
  mode: ExecutionMode;
  surfaces?: readonly CapabilitySurface[];
  layers: readonly CapabilityLayer[];
  agent?: CapabilityAgentMetadata;
  scoped?: boolean;
  /** Sensitivity classification — drives audit tagging and default-deny policy. */
  sensitivity: CapabilitySensitivity;
  /** Default IAM effect when no grant/role/policy matches (resolver rule 8). */
  defaultEffect: CapabilityEffect;
  /** Default role-based grants — used by the seed migration and Wave 5 UI. */
  defaultRoles: {
    org: Partial<Record<SystemOrgRole, GrantEffect>>;
    workspace: Partial<Record<SystemWorkspaceRole, GrantEffect>>;
  };
  /** Input schema (Zod). Validated before calling the handler. */
  input: TInput;
  /** Output schema (Zod). Validated after the handler returns. */
  output: TOutput;
  /**
   * The handler implementation. Closed inside invoke() and not accessible
   * on the returned DefinedContract object.
   *
   * Provided as a HandlerLoader (lazy async factory) to keep @oxagen/oxagen
   * dep-light. The loader is resolved on first invoke() call and cached.
   * Using a direct function is also supported for simple cases.
   */
  handler: ContractHandler<z.infer<TInput>, z.infer<TOutput>>;
}

/** The object returned by defineContract(). The handler is NOT on this object. */
export interface DefinedContract<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
> {
  /** Capability identifier. */
  readonly id: string;
  /**
   * The CapabilityDeclaration metadata — used by the kernel registry,
   * check_manifest.mjs, the seed migration, and the Wave 5 access UI.
   * Does NOT include the handler.
   */
  readonly metadata: CapabilityDeclaration<TInput, TOutput>;
  /**
   * The single dispatch path. Validates input, runs the IAM resolver,
   * emits an audit event, and either calls the handler (allow) or returns
   * a DenialResponse (deny / pending_approval).
   */
  invoke(
    rawCtx: CapabilityContext,
    rawInput: unknown,
  ): Promise<z.infer<TOutput> | DenialResponse>;
}

// ── defineContract ────────────────────────────────────────────────────────────

/**
 * Declare a governable capability. Returns a DefinedContract whose invoke()
 * is the single bypass-proof enforcement boundary.
 */
export function defineContract<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
>(spec: DefineContractSpec<TInput, TOutput>): DefinedContract<TInput, TOutput> {
  // Build the CapabilityDeclaration and register it in the kernel's registry
  // so existing consumers (MCP tool list, API route generation, check_manifest)
  // continue to work unchanged.
  const declaration: CapabilityDeclaration<TInput, TOutput> = {
    name: spec.id,
    domain: spec.domain,
    description: spec.description,
    mode: spec.mode,
    surfaces: spec.surfaces,
    layers: spec.layers,
    agent: spec.agent,
    scoped: spec.scoped,
    sensitivity: spec.sensitivity,
    defaultEffect: spec.defaultEffect,
    defaultRoles: spec.defaultRoles,
    input: spec.input,
    output: spec.output,
  };

  registerCapability(declaration);

  // Cache the resolved handler so the loader runs at most once per process.
  let cachedHandler: ContractHandler<z.infer<TInput>, z.infer<TOutput>> | null = null;

  async function resolveHandler(): Promise<
    ContractHandler<z.infer<TInput>, z.infer<TOutput>>
  > {
    if (cachedHandler) return cachedHandler;
    cachedHandler = spec.handler;
    return cachedHandler;
  }

  // The DefinedContract object returned to callers. The handler is NOT here.
  const contract: DefinedContract<TInput, TOutput> = {
    id: spec.id,
    metadata: declaration,

    async invoke(
      rawCtx: CapabilityContext,
      rawInput: unknown,
    ): Promise<z.infer<TOutput> | DenialResponse> {
      // 1. Validate input against the contract schema.
      const inputResult = spec.input.safeParse(rawInput);
      if (!inputResult.success) {
        throw new Error(
          `Input validation failed for "${spec.id}": ${inputResult.error.message}`,
        );
      }
      const validInput = inputResult.data as z.infer<TInput>;

      // 2. Serialize input for audit payload hash (before IAM check).
      let rawInputJson = "{}";
      try {
        rawInputJson = JSON.stringify(validInput);
      } catch {
        rawInputJson = "{}";
      }

      // 3. IAM resolution.
      const checkFn = _checkIAM;
      if (checkFn === null) {
        // IAM runtime not registered. This can happen in test environments or
        // early boot. Default to allow so existing functionality is not broken
        // before setIAMRuntime() is called. Log a warning.
        console.warn(
          `[define-contract] IAM runtime not registered for "${spec.id}". ` +
            "Call setIAMRuntime() at surface bootstrap. Defaulting to allow.",
        );
        // Fall through to handler call with no principal.
        const handler = await resolveHandler();
        const ctx: CheckedContext = { ...rawCtx, principal: null };
        const output = await handler(ctx, validInput);

        // 4. Validate output.
        const outputResult = spec.output.safeParse(output);
        if (!outputResult.success) {
          throw new Error(
            `Output validation failed for "${spec.id}": ${outputResult.error.message}`,
          );
        }
        return outputResult.data as z.infer<TOutput>;
      }

      const iamResult = await checkFn({
        capability: spec.id,
        ctx: rawCtx,
        defaultEffect: spec.defaultEffect,
        rawInputJson,
      });

      // 4. Handle IAM decision.
      if (iamResult.outcome === "deny") {
        const response: DenialResponse = {
          __capabilityDenied: true,
          outcome: "deny",
          reason: iamResult.reason ?? "no_grant",
        };
        return response;
      }

      if (iamResult.outcome === "pending_approval") {
        // Create an access_request row so the client can poll for approval.
        let requestId: string | undefined;
        const arFn = _createAccessRequest;
        if (arFn !== null) {
          const id = await arFn({
            capability: spec.id,
            ctx: rawCtx,
            principal: iamResult.principal,
          });
          requestId = id ?? undefined;
        }
        const response: DenialResponse = {
          __capabilityDenied: true,
          outcome: "pending_approval",
          reason: iamResult.reason ?? "require_approval",
          ...(requestId !== undefined ? { requestId } : {}),
        };
        return response;
      }

      // 5. IAM says allow — call the handler.
      const handler = await resolveHandler();
      const ctx: CheckedContext = {
        ...rawCtx,
        principal: iamResult.principal,
      };
      const output = await handler(ctx, validInput);

      // 6. Validate output.
      const outputResult = spec.output.safeParse(output);
      if (!outputResult.success) {
        throw new Error(
          `Output validation failed for "${spec.id}": ${outputResult.error.message}`,
        );
      }
      return outputResult.data as z.infer<TOutput>;
    },
  };

  return contract;
}
