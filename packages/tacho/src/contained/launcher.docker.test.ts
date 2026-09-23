/**
 * The contained tier against a real Docker daemon (ADR-152). Skipped unless
 * `OXAGEN_CONTAINED_DOCKER_TEST=1`, because it builds an image and starts a
 * container: the `contained` workflow sets it on a Linux runner, as an
 * unprivileged user in the `docker` group, which is what the launcher
 * requires.
 *
 * The mandate denies `Bash(curl:*)`. The agent runs curl twice against a
 * vendor host: once plainly, which the hook refuses, and once as
 * `sh -c "curl ..."`, which the hook's command-prefix rule does not match.
 * The second is the case containment exists for. It runs, fails on the
 * network policy, and the record shows the attempt and its failure. The same
 * run's model call goes out through the bridge and succeeds.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import { handleHookEvent, type PolicyView } from "../collector/hook-handler";
import { SessionRegistry } from "../collector/registry";
import type { TachoEvent } from "../envelope";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import { startContainedBridge } from "./bridge";
import { containedConfiguration } from "./configuration";
import { launchContainedAgent } from "./launcher";
import type { ContainmentMeasurement } from "./profile";

const ENABLED = process.env["OXAGEN_CONTAINED_DOCKER_TEST"] === "1";
const REPO = resolve(__dirname, "../../../..");
const BASE_TAG = "oxagen-contained-base:docker-test";
const STUB_TAG = "oxagen-contained-stub:docker-test";

const CONTEXT: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.ci-runner",
    fleet_id: "wrk_1",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
    host_enrollment_id: TEST_ENROLLMENT,
  },
};

/** A build context holding only what the two Dockerfiles copy. */
function buildContext(): string {
  const context = mkdtempSync(join(tmpdir(), "oxagen-contained-context-"));
  for (const file of [
    "packages/tacho/container/Dockerfile",
    "packages/tacho/container/entry.mjs",
    "packages/tacho/container/hook.mjs",
    "packages/tacho/container/test/Dockerfile",
    "packages/tacho/container/test/claude-stub.mjs",
  ]) {
    mkdirSync(join(context, file, ".."), { recursive: true });
    cpSync(join(REPO, file), join(context, file));
  }
  return context;
}

describe.skipIf(!ENABLED)("the contained launcher under Docker", () => {
  let context: string | undefined;
  let workspace = "";

  beforeAll(() => {
    const built = buildContext();
    context = built;
    // A runner behind an egress proxy passes it to the build, so apt and
    // npm inside the image reach their mirrors the way the host does.
    // A proxy on the runner's loopback is reachable from the build only on
    // the host's network.
    const proxy = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"].flatMap((name) =>
      process.env[name] !== undefined
        ? ["--build-arg", `${name}=${process.env[name]}`]
        : [],
    );
    if (
      /\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env["HTTPS_PROXY"] ?? "")
    )
      proxy.push("--network", "host");
    const docker = (args: string[]) =>
      execFileSync("docker", args, { stdio: "inherit", timeout: 600_000 });
    // A runner that cannot reach the Debian mirrors may prebuild the base
    // stage and name it here; everything above the base is still built.
    const base = process.env["OXAGEN_CONTAINED_TEST_BASE"] ?? BASE_TAG;
    if (base === BASE_TAG)
      docker([
        "build",
        ...proxy,
        "--target",
        "base",
        "-f",
        join(built, "packages/tacho/container/Dockerfile"),
        "-t",
        BASE_TAG,
        built,
      ]);
    docker([
      "build",
      "--build-arg",
      `BASE=${base}`,
      "-f",
      join(built, "packages/tacho/container/test/Dockerfile"),
      "-t",
      STUB_TAG,
      built,
    ]);
    workspace = mkdtempSync(join(tmpdir(), "oxagen-contained-repo-"));
    execFileSync("git", ["init", "-q", workspace]);
    writeFileSync(join(workspace, "README.md"), "contained test\n");
  }, 900_000);

  afterAll(() => {
    for (const dir of [context, workspace])
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it("fails curl to an external host on the network policy and records the attempt", async () => {
    const signer = bundleSigner();
    const bundle = signer.sign(
      unsignedBundle({
        mode: "enforce",
        containment: { required: true },
        permissions: { allow: [], deny: ["Bash(curl:*)"], ask: [] },
      }),
    );
    const registry = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: Date.now,
    });
    let launched: string | undefined;
    const view: PolicyView = {
      bundle,
      verified: true,
      hostStatus: "active",
      denyGeneration: bundle.deny_generation,
      controlReachable: true,
      mandateConfirmedAt: Date.now(),
      launchedContained: (id) => id === launched,
    };
    const events: TachoEvent[] = [];
    const refused: string[] = [];
    const modelCalls: string[] = [];
    let measurement: ContainmentMeasurement | undefined;
    let stdout = "";

    const result = await launchContainedAgent({
      image: STUB_TAG,
      request: { workspace, harness: "claude-code", args: ["-p", "probe"] },
      output: (stream, text) => {
        if (stream === "stdout") stdout += text;
      },
      prepare: async ({ sessionId, directory }) => {
        launched = sessionId;
        const bridge = await startContainedBridge({
          socketPath: join(directory, "bridge.sock"),
          sessionId,
          workspace,
          harness: "claude-code",
          modelPort: 1,
          issueCredential: () => "run-token-held-outside",
          model: (request, response) => {
            modelCalls.push(
              `${request.url} ${String(request.headers["x-api-key"])}`,
            );
            response.writeHead(200, { "content-type": "application/json" });
            response.end("{}");
          },
          hook: async ({ payload }) => {
            const outcome = await handleHookEvent(
              payload,
              {},
              {
                registry,
                policy: () => view,
                now: Date.now,
              },
            );
            events.push(...outcome.events);
            return outcome.response;
          },
          mcp: async () => ({ status: 404, body: {} }),
          refused: (path) => refused.push(path),
        });
        return {
          files: containedConfiguration("claude-code"),
          close: bridge.close,
        };
      },
      measured: async (_sessionId, measured) => {
        measurement = measured;
      },
      sealed: async () => undefined,
    });

    // The launcher measured the container before anything ran in it.
    expect(measurement).toMatchObject({
      profile: "oxagen-linux-docker-v1",
      gatewayOnlyEgress: true,
      workspaceOnlyWrites: true,
      readOnlyHooks: true,
    });
    expect(result.exitCode).toBe(0);

    // The plain curl never ran: the mandate's rule refused it at the hook.
    expect(stdout).toMatch(/DENIED 1: /);
    // The wrapped curl got past the prefix rule and died on the network.
    expect(stdout).toMatch(/FAILED 2 \(\d+\): curl: \(\d+\) /);
    // The model call left through the bridge, with a credential the sandbox
    // never held.
    expect(stdout).toMatch(/MODEL 200/);
    expect(modelCalls).toEqual([
      "/anthropic/v1/messages run-token-held-outside",
    ]);

    const body = (event: TachoEvent) => event.body as Record<string, unknown>;
    const first = events.filter(
      (event) => body(event)["tool_use_id"] === "toolu_stub_1",
    );
    expect(first.map(body)).toContainEqual(
      expect.objectContaining({
        policy_decision: "deny",
        tool_name: "Bash",
      }),
    );
    const second = events.filter(
      (event) => body(event)["tool_use_id"] === "toolu_stub_2",
    );
    expect(second.map(body)).toContainEqual(
      expect.objectContaining({ tool_name: "Bash", tool_status: "error" }),
    );
    // Every hook event was pinned to the launcher's own session.
    expect(new Set(events.map((event) => event.session_uuid)).size).toBe(1);
  }, 300_000);
});
