import pino from "pino";
import {
  getSandbox,
  isSandboxAvailable,
  DEFAULT_POLICY,
  type SandboxPolicy,
  type SandboxResult,
} from "@oxagen/sandbox";
import { validateWorkspaceFiles } from "@oxagen/sandbox/workspace";
import { insertEvents } from "@oxagen/telemetry";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { agentCodeExecute } from "@oxagen/oxagen/contracts/agent.code.execute";
import type { CapabilityContext } from "../types";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "execute_code" },
});
import type {
  AgentCodeExecuteInput,
  AgentCodeExecuteOutput,
} from "@oxagen/oxagen/contracts/agent.code.execute";
import { injectEnvironmentSecrets } from "./_environment-env";
import { driverNetworkForMode, resolveRunTemplate } from "./_sandbox-template";

export type { AgentCodeExecuteInput, AgentCodeExecuteOutput };

export async function agentCodeExecuteHandler(
  input: AgentCodeExecuteInput,
  ctx: CapabilityContext,
): Promise<AgentCodeExecuteOutput> {
  if (!isSandboxAvailable()) {
    throw new Error(
      "Code execution is not available. Set SANDBOX_ENABLED=true and configure a sandbox driver.",
    );
  }

  // Resolve an optional sandbox template. When present it governs the provider,
  // runtime image, resources, network mode, and vault secret selection + literal
  // env; its OWN environment supplies the secrets. Absent, behavior is unchanged
  // (input.environmentId still injects vault secrets, no template applied).
  const resolved = await resolveRunTemplate(ctx, input.sandboxTemplateId);
  const template = resolved?.template;

  // Map the template's rich network mode to the driver flag BEFORE any
  // provisioning — a not-yet-implemented mode fails fast here, never silently
  // degrading to public egress.
  const network = template
    ? driverNetworkForMode(template.network.mode)
    : input.network;

  // Sanitize the untrusted caller env and merge, lowest→highest: template
  // literal_env → vault secrets (filtered by the template's selection) → caller.
  // The contract no longer transforms env at parse time so this handler owns the
  // whole boundary — see _environment-env.ts for the trust rationale. Reserved
  // caller keys are reported back as warnings rather than silently dropped.
  const secretEnvironmentId = template
    ? resolved!.environment.id
    : input.environmentId;
  const { env, strippedKeys, injectedKeys, missingRequiredKeys } =
    await injectEnvironmentSecrets(ctx, secretEnvironmentId, input.env, {
      selection: template?.secretSelection,
      literalEnv: template?.literalEnv,
    });
  // Log injected vault KEY NAMES only — never values (the whole point of the
  // vault is that values never leave it in plaintext logs).
  if (injectedKeys.length > 0 || missingRequiredKeys.length > 0) {
    logger.info(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        environmentId: secretEnvironmentId,
        sandboxTemplateId: input.sandboxTemplateId,
        injectedKeys,
        missingRequiredKeys,
      },
      "agent.code.execute: injected environment secrets",
    );
  }
  const files = input.files ? validateWorkspaceFiles(input.files) : undefined;

  // Effective sandbox policy for this run. The model-supplied language / network
  // / timeout / memory fields are untrusted, so the request is validated and
  // clamped at the dispatch seam (getSandbox → applyPolicy) before any driver
  // sees it. A template is trusted, workspace-governed config whose declared
  // resources are contract-bounded (≤8 GB / ≤300 s) and may legitimately exceed
  // DEFAULT_POLICY, so when one is present we thread its limits in as the
  // effective ceiling instead of clamping to the conservative defaults. Absent a
  // template, DEFAULT_POLICY applies (30 s / 512 MB / no network / node·python·shell)
  // — a model that asks for egress with no governing template is refused, not
  // silently granted network access.
  const effectivePolicy: SandboxPolicy | undefined = template
    ? {
        allowedLanguages: DEFAULT_POLICY.allowedLanguages,
        maxTimeoutMs:
          template.resources.timeoutMs ?? DEFAULT_POLICY.maxTimeoutMs,
        maxMemoryMb: template.resources.memoryMb ?? DEFAULT_POLICY.maxMemoryMb,
        allowNetwork: network === "allow",
      }
    : undefined;

  // Template resources override the request defaults where set; the template's
  // provider selects the driver per run (SANDBOX_DRIVER stays the fallback), and
  // its runtime becomes the custom image ref.
  const sandbox = getSandbox(template?.provider, effectivePolicy);
  let result: SandboxResult;
  try {
    result = await sandbox.run({
      language: input.language,
      code: input.code,
      stdin: input.stdin,
      env,
      files,
      timeoutMs: template?.resources.timeoutMs ?? input.timeoutMs,
      memoryMb: template?.resources.memoryMb ?? input.memoryMb,
      network,
      ...(template?.runtime ? { imageRef: template.runtime } : {}),
      ...(template?.resources.vcpu !== undefined
        ? { vcpu: template.resources.vcpu }
        : {}),
      ...(template?.resources.diskMb !== undefined
        ? { diskMb: template.resources.diskMb }
        : {}),
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    });
  } catch (err) {
    // A hard policy boundary (disallowed language / network) throws
    // SandboxPolicyError at the seam. Re-surface it as a structured capability
    // error (→ 400 invalid_input via the API error middleware) rather than a
    // leaked 500, matching how the sibling sandbox handlers turn low-level
    // failures into typed, user-visible errors. Over-ceiling resources are
    // clamped silently by applyPolicy and never reach here. Duck-typed on the
    // stable `code` so we never value-import the infra error class.
    if (
      err instanceof Error &&
      (err as { code?: unknown }).code === "sandbox_policy_violation"
    ) {
      throw new CapabilityError(
        agentCodeExecute.name,
        "invalid_input",
        err.message,
      );
    }
    throw err;
  }

  // Meter sandbox runtime cost → ClickHouse (shared analytics package). Sandbox
  // execution does NOT pass through the @oxagen/ai metering chokepoint, so
  // without this its infra cost — driven by `language` and wall-clock duration —
  // is unpriced. Distinct event_type from tool_invocations, so it never
  // double-counts the materialize-tools row. Best-effort: a telemetry write
  // must never fail a code run.
  // Report the EFFECTIVE network flag, not input.network — a template governs
  // egress, so recording the caller's request would misattribute every
  // template-provisioned run in the cost/egress analytics.
  await emitRunTelemetry(ctx, input, network, result);

  const warnings: string[] = [];
  if (strippedKeys.length > 0) {
    warnings.push(`reserved env key stripped: ${strippedKeys.join(", ")}`);
  }
  if (missingRequiredKeys.length > 0) {
    warnings.push(
      `required template secret(s) unset in the vault: ${missingRequiredKeys.join(", ")}`,
    );
  }

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    executionMs: result.durationMs,
    timedOut: result.timedOut,
    oomKilled: result.oomKilled,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

async function emitRunTelemetry(
  ctx: CapabilityContext,
  input: AgentCodeExecuteInput,
  network: AgentCodeExecuteInput["network"],
  result: {
    exitCode: number;
    durationMs: number;
    timedOut: boolean;
    oomKilled: boolean;
  },
): Promise<void> {
  try {
    await insertEvents([
      {
        event_id: crypto.randomUUID(),
        org_id: ctx.orgId,
        workspace_id: ctx.workspaceId,
        event_type: "agent.code.execute.ran",
        source_system: `handler:${ctx.surface}`,
        stream_offset: null,
        payload: JSON.stringify({
          capability: "execute_code",
          language: input.language,
          network,
          durationMs: result.durationMs,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          oomKilled: result.oomKilled,
          requestId: ctx.requestId,
        }),
        emitted_at: new Date().toISOString(),
      },
    ]);
  } catch {
    // Telemetry is best-effort; never fail a code run on an analytics write.
  }
}
