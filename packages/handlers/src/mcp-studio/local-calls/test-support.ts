// test-support.ts: shared builders for the local-calls tests. Nothing in
// production imports this file.
import { generateKeyPairSync } from "node:crypto";
import { deliverySchema, type Delivery, type LaunchSpec } from "@oxagen/tacho/local-servers";
import type { MachineGroupReader, MachineScope } from "./machines";
import { localCallSignerFromPem, type LocalCallSigner } from "./signer";

export const SCOPE: MachineScope = {
  orgId: "0192a8f0-0000-7000-8000-000000000001",
  workspaceId: "0192a8f0-0000-7000-8000-000000000002",
};

export const MACHINE = "tch_laptop01";

/** The files fixture's package, as M0's registry/package-entry.json and tools.lock.json pin it. */
export const FILES_DIGEST = "sha256:0d4c7a91e5b3f8260c1e9a7d4b2f6e8039a5c1d7e4b9f2a6083c5e1d7a4b9f26";

export const FILES_LAUNCH: LaunchSpec = {
  server: "files",
  command: "npx",
  args: ["--yes", "@modelcontextprotocol/server-filesystem@2026.8.1", "${WORK_DIR}"],
  env: ["WORK_DIR"],
  package: {
    name: "@modelcontextprotocol/server-filesystem",
    version: "2026.8.1",
    digest: FILES_DIGEST,
    registry_type: "npm",
  },
};

export const DEFINITION_HASH = `sha256:${"a".repeat(64)}`;

export function testSigner(): LocalCallSigner {
  const { privateKey } = generateKeyPairSync("ed25519");
  return localCallSignerFromPem(privateKey.export({ type: "pkcs8", format: "pem" }).toString());
}

/**
 * A reader that puts each machine in the listed groups. A machine in
 * `suspended` is in none, as the Postgres reader answers (#4554).
 */
export function readerOf(
  groups: Record<string, readonly string[]>,
  suspended: readonly string[] = [],
): MachineGroupReader {
  const isSuspended = (machine: string): boolean => suspended.includes(machine);
  return {
    groupsOf: (_scope, machine) => Promise.resolve(isSuspended(machine) ? [] : (groups[machine] ?? [])),
    isSuspended: (_scope, machine) => Promise.resolve(isSuspended(machine)),
  };
}

/** A delivery as a machine's cloud link reads it off the wire, parsed by tacho's own schema. */
export function deliveryOffTheWire(text: string): Delivery {
  return deliverySchema.parse(JSON.parse(text));
}
