// pin.ts: what a Studio draft's listing pins before any machine starts it
// (ADR-233, #4756).
//
// The machine only ever checks a digest. It never supplies one. So the pin
// comes from the person or from Oxagen before the listing is asked:
//   - A local command pins the version and SHA-256 the person names: the
//     executable the command resolves to on the machine.
//   - A registry package on machines pins the SHA-256 Oxagen reads from the
//     public registry with the digester the machine uses (npm, NuGet, PyPI).
//     A PyPI release pins one file: its universal wheel, or its source
//     distribution. readPackagePin reads the pin, the path discovery's
//     version move takes too.
//   - An OCI image is refused, as discovery refuses it: the catalog carries
//     no image digest (ADR-233, #4756).
// A server with no machine groups runs nowhere, and a server that runs
// remotely imports its tools with Connect, so both are refused too.
import { HandlerError } from "@oxagen/oxagen";
import {
  parseServerToml,
  registryLockSource,
  type McpLockSource,
  type ServerSource,
} from "@oxagen/mcp-studio";
import {
  type PackagePin,
  PackagePinProblem,
  readPackagePin,
  type RegistryDigests,
} from "../discovery/digests";
import type { RegistryCatalog } from "../discovery/seams";
import { machineGroupsOf } from "../local-calls/launch";

/** A local command's pin, as the person names it. */
export interface PersonPin {
  version: string;
  digest: string;
}

/** What the listing pinned: the lock source the machine checks, and where it may run. */
export interface ListingPin {
  source: ServerSource;
  lockSource: McpLockSource;
  groups: readonly string[];
}

export interface PinDeps {
  catalog: RegistryCatalog;
  digests: RegistryDigests;
  signal: AbortSignal;
}

function refuse(reason: string, message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

/** The name a local command's lock records: the executable's file name. */
function commandName(command: string): string {
  const last = command.split(/[\\/]/).filter((part) => part !== "").pop();
  return (last ?? command).slice(0, 214);
}

/** The draft's source, read from its server.toml. */
export function draftSource(server: string, serverToml: string | null): ServerSource {
  if (serverToml === null) {
    throw refuse(
      "server_toml_missing",
      `The draft for ${server} holds no server.toml. Set up the server, save the draft, then list its tools.`,
    );
  }
  const read = parseServerToml(serverToml);
  if (!read.ok) {
    const first = read.issues[0];
    throw refuse(
      "server_toml_invalid",
      `The draft's server.toml for ${server} does not read${first ? `: ${first.message}` : ""}. Fix it, save the draft, then list its tools.`,
    );
  }
  return read.value.source;
}

/**
 * Pin the draft's server for a listing. Refuses with `conflict` when the
 * server does not run on machines, runs nowhere, or cannot be pinned yet.
 */
export async function pinListing(
  server: string,
  source: ServerSource,
  pin: PersonPin | undefined,
  deps: PinDeps,
): Promise<ListingPin> {
  const groups = machineGroupsOf(source);
  if (source.type !== "local" && source.type !== "registry") {
    throw refuse(
      "listing_not_machine_run",
      `${server} runs remotely, so Studio imports its tools with Connect. A listing is for a server that runs on machines.`,
    );
  }
  if (source.type === "registry" && source.machines === undefined) {
    throw refuse(
      "listing_not_machine_run",
      `${server} runs at the registry entry's endpoint, so Studio imports its tools with Connect. Set source.machines to run its package on machines.`,
    );
  }
  if (groups.length === 0) {
    throw refuse(
      "machines_required",
      `${server} names no machine groups in source.machines, so no machine may run it. Add a group, save the draft, then list its tools.`,
    );
  }

  if (source.type === "local") {
    if (pin === undefined) {
      throw refuse(
        "pin_required",
        `${server} is a local command, so name the version you run and the SHA-256 of the executable ${source.command} resolves to on the machine.`,
      );
    }
    return {
      source,
      groups,
      lockSource: {
        type: "local",
        command: source.command,
        package: {
          name: commandName(source.command),
          version: pin.version,
          digest: pin.digest,
        },
      },
    };
  }

  if (pin !== undefined) {
    throw refuse(
      "pin_not_accepted",
      `${server} is a registry package, so Oxagen reads its SHA-256 from the registry. Send no pin.`,
    );
  }
  if (source.registry_type === "oci") {
    throw refuse(
      "needs_digest",
      `${server} is an OCI image, and the catalog carries no image digest, so Oxagen cannot pin it yet.`,
    );
  }
  let entry;
  try {
    entry = await deps.catalog.entry(source.registry, source.server, source.version, deps.signal);
  } catch (error) {
    throw refuse(
      "registry_unreachable",
      `Oxagen could not read ${source.server} ${source.version} from the registry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let pin: PackagePin;
  try {
    pin = await readPackagePin(deps.digests, source, entry, deps.signal);
  } catch (error) {
    if (!(error instanceof PackagePinProblem)) throw error;
    // A registry that did not answer may answer a retry. Anything else is
    // the entry's to fix.
    throw refuse(error.retriable ? "registry_unreachable" : "source_invalid", error.message);
  }
  let lockSource: McpLockSource;
  try {
    // The server reports its version only when it starts, so the claim adds it.
    lockSource = registryLockSource({
      source,
      entry,
      digest: pin.digest,
      ...(pin.file === undefined ? {} : { file: pin.file }),
      server_version: undefined,
    });
  } catch (error) {
    throw refuse("source_invalid", error instanceof Error ? error.message : String(error));
  }
  return { source, groups, lockSource };
}
