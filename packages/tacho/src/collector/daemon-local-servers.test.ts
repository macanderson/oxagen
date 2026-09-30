/**
 * The daemon runs the local-server loop (#4773). An enrolled machine with a
 * gateway key pulls calls from the cloud route while the daemon runs, and
 * stops pulling when the daemon stops.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../host/control-client";
import { writeHostFile, type HostFile } from "../host/host-file";
import { bundleSigner, scratchPaths, testHostFile, unsignedBundle } from "../host/test-support";
import { type DaemonHandle, startDaemon } from "./daemon";

interface Pull {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
}

describe("the daemon's local-server loop", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  async function start(overrides: Partial<HostFile>): Promise<{ handle: DaemonHandle; pulls: Pull[] }> {
    const paths = scratchPaths();
    const signer = bundleSigner();
    writeHostFile(paths.hostFile, testHostFile(signer, signer.sign(unsignedBundle()), overrides));
    const pulls: Pull[] = [];
    // A pull waits like a long-poll with nothing queued: until the caller
    // hangs up. Every other request fails, as the control plane is not here.
    const fetch: FetchLike = (url, init) => {
      if (!url.endsWith("/v1/local-servers/next")) return Promise.reject(new Error("ECONNREFUSED"));
      pulls.push({ url, headers: init.headers, signal: init.signal });
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const handle = await startDaemon({
      paths,
      fetch,
      exec: () => ({ status: 128, stdout: "", stderr: "not a repository" }),
      log: () => {},
      listen: false,
      localServers: true,
      transcriptRoots: [`${paths.tachoDir}/no-transcripts`],
    });
    handles.push(handle);
    return { handle, pulls };
  }

  it("pulls with the gateway key while it runs, and hangs up when it stops", async () => {
    const { handle, pulls } = await start({ gateway_api_key: "oxk_gateway_secret" });
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    const [pull] = pulls;
    expect(pull!.url).toBe("https://mcp.example.test/v1/local-servers/next");
    expect(pull!.headers["Authorization"]).toBe("Bearer oxk_gateway_secret");
    expect(pull!.headers["X-Tacho-Host"]).toBe(handle.host().host_enrollment_id);
    await handle.stop();
    expect(pull!.signal?.aborted).toBe(true);
  });

  it("does not pull for a host with no gateway key", async () => {
    // testHostFile carries a gateway key by default, so this host drops it.
    const { pulls } = await start({ gateway_api_key: undefined, gateway_api_key_public_id: undefined });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pulls).toEqual([]);
  });

  it("does not pull for a suspended host", async () => {
    const { pulls } = await start({ gateway_api_key: "oxk_gateway_secret", host_status: "suspended" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pulls).toEqual([]);
  });
});
