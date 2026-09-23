import { join } from "node:path";
import { z } from "zod";
import type { HostFile } from "../host/host-file";
import { mcpEndpointFor } from "../host/host-file";
import type { FetchLike } from "../host/control-client";
import type { SessionRegistry } from "../collector/registry";
import type { HookEnvelope } from "../collector/server";
import type { ModelProxy } from "../collector/model-proxy";
import { createMcpGateway } from "../collector/mcp-gateway";
import type { IssueRunTokenAnswer } from "../collector/credential-issuer";
import type { TachoEvent } from "../envelope";
import { containedConfiguration } from "./configuration";
import { startContainedBridge } from "./bridge";
import { launchContainedAgent, type ContainedRunResult } from "./launcher";

export const containedRunRequestSchema = z
  .object({
    workspace: z.string().min(1).max(4096),
    harness: z.enum(["claude-code", "codex"]),
    args: z.array(z.string().max(65536)).max(128),
    image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9/_.:@-]{0,255}$/),
  })
  .strict();

export interface ContainedRunnerOptions {
  host: () => HostFile;
  registry: SessionRegistry;
  genesis: (sessionUuid: string) => string | undefined;
  hook: (envelope: HookEnvelope) => Promise<Record<string, unknown>>;
  record: (events: readonly TachoEvent[]) => void;
  model: ModelProxy;
  modelPort: () => number;
  issueCredential: (harness: string) => IssueRunTokenAnswer;
  fetch: FetchLike;
  log: (line: string) => void;
}

export function createContainedRunner(options: ContainedRunnerOptions) {
  const measurements = new Set<string>();
  const active = new Map<string, AbortController>();
  return {
    attested: (uuid: string) => measurements.has(uuid),
    stop: (uuid: string) => active.get(uuid)?.abort(),
    stopAll: () => {
      for (const controller of active.values()) controller.abort();
    },
    run: async (
      raw: unknown,
      output: (stream: "stdout" | "stderr", text: string) => void,
      signal?: AbortSignal,
    ): Promise<ContainedRunResult> => {
      const input = containedRunRequestSchema.parse(raw);
      const host = options.host();
      if (
        host.host_status !== "active" ||
        host.revoked_at !== null ||
        Date.parse(host.expires_at) <= Date.now()
      )
        throw new Error("This enrollment cannot start a contained run");
      if (!host.gateway_api_key)
        throw new Error(
          "Re-enroll this runner to obtain a daemon gateway credential",
        );
      const credential = options.issueCredential(input.harness);
      if (credential.status !== 200)
        throw new Error(
          "The daemon must hold this harness's model credential before containment can start",
        );
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      let sessionUuid: string | undefined;
      const session = (id: string) => {
        const found = options.registry.get(id);
        if (!found) throw new Error("Contained session was not recorded");
        return found;
      };
      try {
        return await launchContainedAgent({
          image: input.image,
          request: input,
          output,
          signal: controller.signal,
          prepare: async ({ sessionId, directory, workspace }) => {
            await options.hook({
              harness: input.harness,
              payload: {
                hook_event_name: "SessionStart",
                session_id: sessionId,
                cwd: workspace,
                source: "startup",
              },
            });
            const started = session(sessionId);
            sessionUuid = started.recorder.sessionUuid;
            active.set(sessionUuid, controller);
            const gateway = createMcpGateway({
              attribution: () => {
                const current = options.host();
                if (
                  current.host_status !== "active" ||
                  !current.gateway_api_key
                )
                  return undefined;
                return {
                  organizationId: current.organization_id,
                  workspaceId: current.workspace_id,
                  orgSlug: current.org_slug,
                  workspaceSlug: current.workspace_slug,
                  apiKey: current.gateway_api_key,
                  hostEnrollmentId: current.host_enrollment_id,
                  chainSessionUuid: started.recorder.sessionUuid,
                  chainGenesisHash: options.genesis(
                    started.recorder.sessionUuid,
                  ),
                };
              },
              endpoint: mcpEndpointFor(options.host()),
              fetch: options.fetch,
              bundle: () => options.host().bundle,
              log: options.log,
              record: (call) =>
                options.record([
                  started.recorder.sealCollectorEvent("tool_call", {
                    tool_name: call.toolName,
                    tool_source: "mcp",
                    tool_status: call.status,
                    tool_duration_ms: call.durationMs,
                  }),
                ]),
            });
            const bridge = await startContainedBridge({
              socketPath: join(directory, "bridge.sock"),
              sessionId,
              workspace,
              harness: input.harness,
              modelPort: options.modelPort(),
              issueCredential: () => {
                const answer = options.issueCredential(input.harness);
                if (answer.status !== 200)
                  throw new Error("Credential custody unavailable");
                return answer.body.token;
              },
              model: (request, response) =>
                options.model.handle(request, response),
              hook: options.hook,
              mcp: (body) =>
                gateway.handle(body, {
                  sessionId,
                  enrollmentId: options.host().host_enrollment_id,
                }),
              refused: (path) =>
                options.record([
                  started.recorder.sealCollectorEvent("policy_decision", {
                    policy_decision: "deny",
                    policy_source: "bundle",
                    policy_reason: "contained_gateway_route",
                    tool_name: path.split("?")[0]?.slice(0, 256) ?? "unknown",
                  }),
                ]),
            });
            return {
              files: containedConfiguration(input.harness),
              close: bridge.close,
            };
          },
          measured: async (sessionId, measurement) => {
            const started = session(sessionId);
            const genesis = options.genesis(started.recorder.sessionUuid);
            if (!genesis)
              throw new Error("Contained session has no recorded genesis");
            const current = options.host();
            const endpoint = new URL(current.api_url);
            endpoint.pathname = `/v1/${encodeURIComponent(current.org_slug)}/${encodeURIComponent(current.workspace_slug)}/tacho/contained-launch`;
            const response = await options.fetch(endpoint.href, {
              method: "POST",
              headers: {
                authorization: `Bearer ${current.gateway_api_key}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                host_enrollment_id: current.host_enrollment_id,
                session_uuid: started.recorder.sessionUuid,
                genesis_hash: genesis,
                measurement,
              }),
              signal: AbortSignal.timeout(30_000),
            });
            if (!response.ok)
              throw new Error(
                `Contained launch registration failed (${response.status}); the agent was not started`,
              );
            measurements.add(started.recorder.sessionUuid);
            options.record([
              started.recorder.sealCollectorEvent(
                "policy_decision",
                {
                  policy_decision: "allow",
                  policy_source: "kernel",
                  policy_reason: "contained_launch_registered",
                },
                {
                  attrs: {
                    "oxagen.containment.profile": measurement.profile,
                    "oxagen.containment.image": measurement.imageDigest,
                    "oxagen.containment.configuration":
                      measurement.configurationDigest,
                  },
                },
              ),
            ]);
          },
          sealed: async (sessionId, exitCode) => {
            await options.hook({
              harness: input.harness,
              payload: {
                hook_event_name: "SessionEnd",
                session_id: sessionId,
                cwd: input.workspace,
                reason: "other",
                exit_code: exitCode,
              },
            });
          },
        });
      } finally {
        signal?.removeEventListener("abort", abort);
        if (sessionUuid) active.delete(sessionUuid);
      }
    },
  };
}
