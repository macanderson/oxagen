// digests.ts: the digest a registry package pins, read by Oxagen from the
// public registry the way a machine reads it (ADR-233, #4756).
//
// The local gateway compares the digest of what it would run with the lock
// before it starts anything, through @oxagen/tacho's digester. Oxagen reads
// with the same digester, so the two reads agree by construction: npm's
// tarball hashed, the SHA-256 the PyPI index publishes, and the NuGet package
// hashed. The machine only checks a digest and never supplies one. An OCI
// image pins its digest in the image reference, which the catalog does not
// carry, so Oxagen reads none for it.
import {
  createPackageDigester,
  type LaunchPackage,
} from "@oxagen/tacho/local-servers";

/** Reads the digest a registry package's launch would run. */
export interface RegistryDigests {
  /**
   * The SHA-256 of the artifact `launch` would run, as `sha256:<hex>`. It
   * rejects with the registry's reason when the registry does not answer.
   */
  digest(
    pkg: Omit<LaunchPackage, "digest">,
    launch: { command: string; args: readonly string[] },
    signal?: AbortSignal,
  ): Promise<string>;
}

/**
 * The digest the digester is handed before one is known. It never matches a
 * real artifact, so for a PyPI release the digester answers the first file's.
 */
const UNPINNED = `sha256:${"0".repeat(64)}`;

/**
 * The digester's refusal names the local gateway, which reads on a machine.
 * Oxagen keeps only the reason, and the caller names who read it.
 */
const GATEWAY_PREFIX = /^The local gateway could not compute the digest of [^:]+: /;

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(GATEWAY_PREFIX, "").replace(/\.$/, "");
}

/** The digester over the public registries, through `fetchFn`. */
export function registryDigests(
  fetchFn: typeof fetch = globalThis.fetch,
): RegistryDigests {
  const digester = createPackageDigester({
    fetch: (url, init) => fetchFn(url, init),
    // A registry package is read from its registry. Oxagen reads no
    // executable on a machine: a person names that digest (ADR-233).
    readFile: () =>
      Promise.reject(new Error("Oxagen reads no executable on a machine.")),
    realpath: (path) => Promise.resolve(path),
    which: () => Promise.resolve(undefined),
    env: {},
  });
  return {
    digest: (pkg, launch, signal) =>
      digester
        .digest(
          { ...pkg, digest: UNPINNED },
          { command: launch.command, args: [...launch.args] },
          signal,
        )
        .catch((error: unknown) => {
          throw new Error(reasonOf(error));
        }),
  };
}
