/**
 * The local-server loop for an enrolled machine (#4773).
 *
 * The daemon holds one of these for its whole life. `sync` starts the loop
 * while host.json lets this machine pull calls, and stops it when host.json
 * stops letting it: the host is revoked or suspended, or it has no gateway
 * key. The cloud route refuses a pull in each of those cases, so a loop left
 * running would only fail and back off.
 *
 * The loop pulls from the MCP origin, the same host the local gateway proxies
 * to, with the gateway key. It never falls back to `api_key` (ADR-078).
 *
 * The daemon imports this file directly. The index leaves it out, because the
 * cloud gateway imports the index and has no use for a child process.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { access, constants, readFile, realpath, stat } from "node:fs/promises";

import { mcpEndpointFor, type HostFile } from "../../host/host-file";
import { createCloudLink, type CloudFetch, type CloudLink } from "./cloud-link";
import {
  createPackageDigester,
  platformPathSearch,
  whichOnPath,
  type DigestFetch,
  type PackageDigester,
} from "./digest";
import type { MachineEnv } from "./launch";
import { createLocalServers, type LocalServers, type LocalServersOptions } from "./local-servers";
import type { StdioSpawn } from "./stdio-client";

/** The host file fields the loop reads. */
export type MachineHost = Pick<
  HostFile,
  | "host_enrollment_id"
  | "gateway_api_key"
  | "bundle_public_key_pem"
  | "api_url"
  | "endpoints"
  | "mcp_endpoint_override"
  | "host_status"
  | "revoked_at"
>;

/** Why the loop does not run, or undefined when it may. */
export function machineParked(host: MachineHost): string | undefined {
  if (host.revoked_at !== null || host.host_status === "revoked") return "the enrollment is revoked";
  if (host.host_status === "suspended") return "the host is suspended";
  if (host.gateway_api_key === undefined) return "host.json holds no gateway key; enroll again to get one";
  return undefined;
}

/** The origin the loop pulls from: the MCP endpoint's scheme, host and port. */
export function machineOrigin(host: MachineHost, env: MachineEnv): string {
  return new URL(mcpEndpointFor(host, env)).origin;
}

/** The link to the cloud route for this machine. The host must not be parked. */
export function createMachineLink(host: MachineHost, fetch: CloudFetch, env: MachineEnv): CloudLink {
  if (host.gateway_api_key === undefined) throw new Error("host.json holds no gateway key");
  return createCloudLink({
    baseUrl: machineOrigin(host, env),
    apiKey: host.gateway_api_key,
    machine: host.host_enrollment_id,
    fetch,
  });
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The digester that reads this machine's files and the package registries. */
export function machineDigester(fetch: DigestFetch, env: MachineEnv, platform: NodeJS.Platform): PackageDigester {
  const search = platformPathSearch(platform, env, isExecutable);
  return createPackageDigester({
    fetch,
    readFile: (path) => readFile(path),
    realpath: (path) => realpath(path),
    which: (command, pathValue) => whichOnPath(command, pathValue, search),
    env,
  });
}

const spawnServer: StdioSpawn = (command, args, options) => nodeSpawn(command, args, options);

export interface MachineLoopOptions {
  /** The host file as the daemon holds it now. */
  host: () => MachineHost;
  /** Reaches the cloud route. */
  fetch: CloudFetch;
  /** Reaches the package registries. Defaults to the global fetch. */
  digestFetch?: DigestFetch;
  log(line: string): void;
  /** The environment servers start from. Defaults to process.env. */
  env?: MachineEnv;
  platform?: NodeJS.Platform;
  spawn?: StdioSpawn;
  /** Builds the loop. Tests pass a fake. */
  create?: (options: LocalServersOptions) => LocalServers;
}

export interface MachineLoop {
  /** Start the loop when host.json lets the machine pull, and stop it when it does not. */
  sync(): void;
  /** Stop the loop and wait for the replies in flight. */
  stop(): Promise<void>;
}

/** What a running loop was built from. A change to any of it restarts the loop. */
function signatureOf(host: MachineHost, env: MachineEnv): string {
  return [host.host_enrollment_id, host.gateway_api_key, host.bundle_public_key_pem, machineOrigin(host, env)].join(
    "\n",
  );
}

export function createMachineLoop(options: MachineLoopOptions): MachineLoop {
  const env = options.env ?? process.env;
  const create = options.create ?? createLocalServers;
  const stopping = new Set<Promise<void>>();
  let running: { servers: LocalServers; signature: string } | undefined;
  let parkedFor: string | undefined;

  function halt(reason: string): void {
    if (running === undefined) return;
    const { servers } = running;
    running = undefined;
    options.log(`local servers: stopped pulling calls, because ${reason}`);
    const done: Promise<void> = servers.stop().finally(() => stopping.delete(done));
    stopping.add(done);
  }

  return {
    sync() {
      const host = options.host();
      const parked = machineParked(host);
      if (parked !== undefined) {
        halt(parked);
        if (parkedFor !== parked) options.log(`local servers: not pulling calls, because ${parked}`);
        parkedFor = parked;
        return;
      }
      parkedFor = undefined;
      const signature = signatureOf(host, env);
      if (running?.signature === signature) return;
      halt("the enrollment changed");
      const servers = create({
        machine: host.host_enrollment_id,
        publicKeyPem: host.bundle_public_key_pem,
        link: createMachineLink(host, options.fetch, env),
        spawn: options.spawn ?? spawnServer,
        env,
        digester: machineDigester(options.digestFetch ?? globalThis.fetch, env, options.platform ?? process.platform),
        log: options.log,
      });
      servers.start();
      running = { servers, signature };
      options.log(`local servers: pulling calls from ${machineOrigin(host, env)}`);
    },
    async stop() {
      halt("the daemon is stopping");
      await Promise.all(stopping);
    },
  };
}
