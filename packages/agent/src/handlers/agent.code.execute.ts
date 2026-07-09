import pino from "pino";
import { getSandbox, isSandboxAvailable } from "@oxagen/sandbox";
import { validateWorkspaceFiles } from "@oxagen/sandbox/workspace";
import { insertEvents } from "@oxagen/telemetry";
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
  const network = template ? driverNetworkForMode(template.network.mode) : input.network;

  // Sanitize the untrusted caller env and merge, lowest→highest: template
  // literal_env → vault secrets (filtered by the template's selection) → caller.
  // The contract no longer transforms env at parse time so this handler owns the
  // whole boundary — see _environment-env.ts for the trust rationale. Reserved
  // caller keys are reported back as warnings rather than silently dropped.
  const secretEnvironmentId = template ? resolved!.environment.id : input.environmentId;
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

  // Template resources override the request defaults where set; the template's
  // provider selects the driver per run (SANDBOX_DRIVER stays the fallback), and
  // its runtime becomes the custom image ref.
  const sandbox = getSandbox(template?.provider);
  const result = await sandbox.run({
    language: input.language,
    code: input.code,
    stdin: input.stdin,
    env,
    files,
    timeoutMs: template?.resources.timeoutMs ?? input.timeoutMs,
    memoryMb: template?.resources.memoryMb ?? input.memoryMb,
    network,
    ...(template?.runtime ? { imageRef: template.runtime } : {}),
    ...(template?.resources.vcpu !== undefined ? { vcpu: template.resources.vcpu } : {}),
    ...(template?.resources.diskMb !== undefined ? { diskMb: template.resources.diskMb } : {}),
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
  });

  // Meter sandbox runtime cost → ClickHouse (shared analytics package). Sandbox
  // execution does NOT pass through the @oxagen/ai metering chokepoint, so
  // without this its infra cost — driven by `language` and wall-clock duration —
  // is unpriced. Distinct event_type from tool_invocations, so it never
  // double-counts the materialize-tools row. Best-effort: a telemetry write
  // must never fail a code run.
  await emitRunTelemetry(ctx, input, result);

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
  result: { exitCode: number; durationMs: number; timedOut: boolean; oomKilled: boolean },
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
          network: input.network,
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
