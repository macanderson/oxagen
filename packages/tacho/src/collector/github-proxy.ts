/** Repository-bound Git smart HTTP. Vendor tokens never leave this daemon. */
import { randomBytes, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";
import { evaluatePreToolUse, verifyBundle } from "../host/bundle";
import type { HostFile } from "../host/host-file";
import type { FetchLike } from "../host/control-client";
import type { SessionRecord, SessionRegistry } from "./registry";
import type { TachoEvent } from "../envelope";
import {
  TACHO_CREDENTIAL_BASIS_ATTR,
  TACHO_CREDENTIAL_GATEWAY_BROKERED,
  TACHO_RUN_TOKEN_ATTR,
  isWrappedHarness,
} from "../wire";

const LIFE_MS = 15 * 60_000;
const MAX_LEASES = 1024;
const MAX_REQUEST_BYTES = 128 * 1024 * 1024;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

interface Lease {
  id: string;
  repository: string;
  session: string;
  expires: number;
}
export interface GithubLeaseInput {
  repository?: unknown;
  cwd?: unknown;
  harness?: unknown;
}
export interface GithubProxyDeps {
  host(): HostFile;
  registry: SessionRegistry;
  controlFetch: FetchLike;
  fetch?: typeof globalThis.fetch;
  now(): number;
  record(events: readonly TachoEvent[]): void;
  log(line: string): void;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    "content-type": "text/plain",
    "cache-control": "no-store",
  });
  res.end(message);
}
function bearer(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  if (auth?.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon >= 0) return decoded.slice(colon + 1);
  }
  return undefined;
}

export function createGithubProxy(deps: GithubProxyDeps) {
  const leases = new Map<string, Lease>();
  const fetchUpstream = deps.fetch ?? globalThis.fetch;

  function live(lease: Lease): SessionRecord | undefined {
    const host = deps.host();
    if (
      host.github_broker_enabled !== true ||
      host.host_status !== "active" ||
      !Number.isFinite(Date.parse(host.expires_at)) ||
      Date.parse(host.expires_at) <= deps.now() ||
      lease.expires <= deps.now()
    )
      return undefined;
    const session = deps.registry.byUuid(lease.session);
    return session &&
      !session.sealed &&
      !session.pendingTerminal &&
      session.control.paused == null &&
      session.control.cancelled == null
      ? session
      : undefined;
  }

  function issue(input: GithubLeaseInput) {
    if (input === null || typeof input !== "object" || Array.isArray(input))
      return {
        status: 400,
        body: { error: "A GitHub lease request must be an object" },
      };
    for (const [key, lease] of leases) if (!live(lease)) leases.delete(key);
    const host = deps.host();
    if (host.github_broker_enabled !== true || host.host_status !== "active")
      return {
        status: 403,
        body: { error: "GitHub custody is not enabled on this host" },
      };
    if (
      typeof input.repository !== "string" ||
      !REPO.test(input.repository) ||
      [".", ".."].includes(input.repository.split("/")[1] ?? "") ||
      typeof input.cwd !== "string" ||
      typeof input.harness !== "string" ||
      !isWrappedHarness(input.harness)
    )
      return {
        status: 400,
        body: {
          error:
            "A repository, working directory, and wrapped harness are required",
        },
      };
    const matches = deps.registry
      .live()
      .filter(
        (s) =>
          !s.pendingTerminal &&
          s.cwd &&
          resolve(s.cwd) === resolve(input.cwd as string) &&
          deps.registry.agentOf(s).harness === input.harness,
      );
    if (matches.length !== 1 || leases.size >= MAX_LEASES)
      return {
        status: 409,
        body: {
          error:
            "GitHub custody needs exactly one live session in this working directory",
        },
      };
    const session = matches[0]!;
    const token = `oxgit_${randomBytes(32).toString("base64url")}`;
    const lease: Lease = {
      id: `rt_${randomBytes(10).toString("hex")}`,
      repository: input.repository.toLowerCase(),
      session: session.recorder.sessionUuid,
      expires: Math.min(deps.now() + LIFE_MS, Date.parse(host.expires_at)),
    };
    if (!live(lease))
      return {
        status: 403,
        body: { error: "The session or enrollment is not active" },
      };
    leases.set(hash(token), lease);
    return {
      status: 200,
      body: { token, expires_at: new Date(lease.expires).toISOString() },
    };
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const token = bearer(req);
    const lease = token ? leases.get(hash(token)) : undefined;
    if (!lease) {
      res.setHeader("www-authenticate", 'Basic realm="Oxagen GitHub proxy"');
      reply(res, 401, "A local GitHub run credential is required");
      return;
    }
    const session = live(lease);
    if (!session) {
      reply(
        res,
        403,
        "The GitHub run credential has expired or its session stopped",
      );
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const path =
      /^\/github\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\.git\/(info\/refs|git-receive-pack|git-upload-pack)$/.exec(
        url.pathname,
      );
    const service = url.searchParams.get("service");
    const discovery =
      path?.[3] === "info/refs" &&
      req.method === "GET" &&
      url.searchParams.size === 1 &&
      ["git-receive-pack", "git-upload-pack"].includes(service ?? "");
    const exchange =
      path?.[3] !== "info/refs" &&
      req.method === "POST" &&
      url.search === "" &&
      req.headers["content-type"] === `application/x-${path?.[3]}-request`;
    if (
      !path ||
      `${path[1]}/${path[2]}`.toLowerCase() !== lease.repository ||
      (!discovery && !exchange)
    ) {
      reply(
        res,
        403,
        "This credential permits only its repository's Git smart HTTP requests",
      );
      return;
    }
    const pushing = (service ?? path[3]) === "git-receive-pack";
    const host = deps.host();
    const verified = verifyBundle(host.bundle, host.bundle_public_key_pem).ok;
    if (!verified) {
      reply(res, 403, "The signed GitHub mandate did not verify");
      return;
    }
    const verdict = evaluatePreToolUse({
      bundle: host.bundle,
      bundleVerified: verified,
      hostStatus: host.host_status,
      session: session.control,
      latestDenyGeneration: host.deny_generation,
      controlReachable: true,
      mandateConfirmedAt: Date.parse(host.bundle_fetched_at),
      now: deps.now(),
      toolName: "Bash",
      toolInput: {
        command: `git ${pushing ? "push" : "fetch"} https://github.com/${lease.repository}.git`,
      },
    });
    if (verdict.decision !== "allow") {
      reply(res, 403, verdict.reason);
      return;
    }
    const controller = new AbortController();
    const monitor = setInterval(() => {
      if (!live(lease)) controller.abort();
    }, 250);
    const deadline = setTimeout(
      () => controller.abort(),
      Math.max(1, lease.expires - deps.now()),
    );
    const onClose = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.on("close", onClose);
    let installationToken: string | undefined;
    let status = 502;
    try {
      const minted = await deps.controlFetch(
        `${host.api_url.replace(/\/$/, "")}/v1/tacho/github-token`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${host.api_key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            host_enrollment_id: host.host_enrollment_id,
            owner: path[1],
            name: path[2],
            run_token_id: lease.id,
          }),
          signal: controller.signal,
        },
      );
      if (!minted.ok) {
        reply(
          res,
          minted.status === 404 ? 404 : 403,
          "Oxagen refused access to this repository",
        );
        return;
      }
      const value = JSON.parse(await minted.text()) as {
        token?: unknown;
        expires_at?: unknown;
      };
      if (
        typeof value.token !== "string" ||
        typeof value.expires_at !== "string" ||
        !Number.isFinite(Date.parse(value.expires_at)) ||
        Date.parse(value.expires_at) <= deps.now()
      )
        throw new Error("Invalid scoped credential response");
      installationToken = value.token;
      if (!live(lease)) {
        reply(res, 403, "The session stopped before forwarding");
        return;
      }
      const headers = new Headers({
        Authorization: `Basic ${Buffer.from(`x-access-token:${installationToken}`).toString("base64")}`,
      });
      for (const name of [
        "content-type",
        "content-encoding",
        "git-protocol",
        "user-agent",
      ]) {
        const value = req.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      let bytes = 0;
      async function* body() {
        for await (const chunk of req) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_REQUEST_BYTES)
            throw new Error("Git request exceeds 128 MiB");
          if (!lease || !live(lease))
            throw new Error("Session stopped during Git request");
          yield buffer;
        }
      }
      const init: RequestInit & { duplex?: "half" } = {
        method: req.method,
        headers,
        redirect: "manual",
        signal: controller.signal,
        ...(exchange
          ? {
              body: Readable.toWeb(
                Readable.from(body()),
              ) as ReadableStream<Uint8Array>,
              duplex: "half" as const,
            }
          : {}),
      };
      deps.record([
        session.recorder.sealCollectorEvent(
          "token_use",
          {
            tool_name: pushing ? "git push" : "git fetch",
            tool_target: lease.repository,
            policy_decision: "allow",
            policy_source: "bundle",
          },
          {
            attrs: {
              [TACHO_CREDENTIAL_BASIS_ATTR]: TACHO_CREDENTIAL_GATEWAY_BROKERED,
              [TACHO_RUN_TOKEN_ATTR]: lease.id,
              "oxagen.github.repository": lease.repository,
            },
          },
        ),
      ]);
      const upstream = await fetchUpstream(
        `https://github.com/${lease.repository}.git/${path[3]}${url.search}`,
        init,
      );
      status = upstream.status;
      if (status >= 300 && status < 400) {
        reply(
          res,
          502,
          "GitHub redirected the request. Refresh the repository binding.",
        );
        return;
      }
      res.writeHead(status, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      if (upstream.body)
        await pipeline(
          Readable.fromWeb(
            upstream.body as import("node:stream/web").ReadableStream,
          ),
          res,
        );
      else res.end();
    } catch (error) {
      deps.log(
        `GitHub proxy request failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
      if (!res.headersSent) reply(res, 502, "The GitHub proxy request failed");
      else res.destroy();
    } finally {
      clearTimeout(deadline);
      clearInterval(monitor);
      res.off("close", onClose);
      if (installationToken) {
        try {
          const revoked = await fetchUpstream(
            "https://api.github.com/installation/token",
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${installationToken}` },
              redirect: "manual",
              signal: AbortSignal.timeout(10_000),
            },
          );
          if (revoked.status !== 204 && revoked.status !== 401)
            deps.log("GitHub credential revocation failed");
        } catch {
          deps.log("GitHub credential revocation failed");
        }
      }
      if (!session.sealed && !session.pendingTerminal) {
        deps.record([
          session.recorder.sealCollectorEvent(
            "tool_call",
            {
              tool_name: pushing ? "git push" : "git fetch",
              tool_target: lease.repository,
            },
            {
              attrs: {
                [TACHO_CREDENTIAL_BASIS_ATTR]:
                  TACHO_CREDENTIAL_GATEWAY_BROKERED,
                [TACHO_RUN_TOKEN_ATTR]: lease.id,
                "oxagen.github.repository": lease.repository,
                "oxagen.github.http_status": String(status),
              },
            },
          ),
        ]);
      }
    }
  }
  return { issue, handle };
}
