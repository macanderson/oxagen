// digests.ts: the digest a registry package pins, read by Oxagen from the
// public registry the way a machine reads it (ADR-233, #4756).
//
// The local gateway compares the digest of what it would run with the lock
// before it starts anything, through @oxagen/recorder's digester. Oxagen reads
// with the same digester, so the two reads agree by construction: npm's
// tarball hashed, the NuGet package hashed, and one PyPI file hashed. The
// machine only checks a digest and never supplies one. An OCI image pins its
// digest in the image reference, which the catalog does not carry, so Oxagen
// reads none for it.
//
// A PyPI release holds one file per host, and uvx name@version would install
// the host's. So the pin names one file: the release's universal wheel, or
// its source distribution. The digester picks it the way the machine would
// read it, the launch installs it with `uvx --from <url>`, and the lock
// records it (ADR-233).
import {
  registryLaunch,
  type PypiLockFile,
  type RegistryEntry,
  type RegistrySource,
} from "@oxagen/mcp-studio";
import {
  createPackageDigester,
  type LaunchPackage,
} from "@oxagen/recorder/local-servers";

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
  /**
   * The one file of a PyPI release a pin names: its universal wheel, or its
   * source distribution. Null when the release has neither, which only a new
   * release changes. It rejects with the index's reason when the index does
   * not answer.
   */
  pypiFile(
    pkg: Pick<LaunchPackage, "name" | "version">,
    signal?: AbortSignal,
  ): Promise<PypiLockFile | null>;
}

/** The digest the digester is handed before one is known. It never matches a real artifact. */
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
    pypiFile: (pkg, signal) =>
      digester.pypiFile(pkg, signal).catch((error: unknown) => {
        throw new Error(reasonOf(error));
      }),
  };
}

/**
 * Why a registry package on machines cannot be pinned. `retriable` is true
 * when the registry did not answer, so a later read may.
 */
export class PackagePinProblem extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
  ) {
    super(message);
    this.name = "PackagePinProblem";
  }
}

/** A registry package's pin: its digest, and for PyPI the one file it names. */
export interface PackagePin {
  digest: string;
  file?: PypiLockFile;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the pin of `source`'s package on machines at `entry`, the one path a
 * first listing and a version move both take (ADR-233). It builds the
 * launch, picks the PyPI file when the package is one, and reads the digest
 * of what that launch would run. An OCI image has no digest to read here,
 * so the caller refuses it first.
 */
export async function readPackagePin(
  reader: RegistryDigests,
  source: RegistrySource,
  entry: RegistryEntry,
  signal?: AbortSignal,
): Promise<PackagePin> {
  const unpinned = registryLaunch({ source, entry, digest: "" });
  if (!unpinned.ok) {
    throw new PackagePinProblem(
      `${source.server} ${source.version} cannot run on a machine: ${unpinned.problems.map((problem) => `${problem.field}: ${problem.message}`).join("; ")}`,
      false,
    );
  }
  const { name, version, registry_type } = unpinned.package;
  if (registry_type === "oci") {
    throw new PackagePinProblem(
      `${name}@${version} is an OCI image, and the catalog carries no image digest`,
      false,
    );
  }
  let launch = { command: unpinned.command, args: unpinned.args };
  let file: PypiLockFile | undefined;
  if (registry_type === "pypi") {
    let picked: PypiLockFile | null;
    try {
      picked = await reader.pypiFile({ name, version }, signal);
    } catch (error) {
      throw new PackagePinProblem(
        `Oxagen could not read the digest of ${name}@${version}: ${messageOf(error)}`,
        true,
      );
    }
    // Retrying cannot help: only a new release adds a file Oxagen can pin.
    if (picked === null) {
      throw new PackagePinProblem(
        `${name}@${version} is a PyPI release with no py3-none-any wheel and no source distribution, so Oxagen cannot pin one file of it`,
        false,
      );
    }
    file = picked;
    const named = registryLaunch({ source, entry, digest: "", file });
    // The same entry and source launched a moment ago, so this holds.
    if (named.ok) launch = { command: named.command, args: named.args };
  }
  try {
    const digest = await reader.digest(
      { name, version, registry_type },
      launch,
      signal,
    );
    return file === undefined ? { digest } : { digest, file };
  } catch (error) {
    throw new PackagePinProblem(
      `Oxagen could not read the digest of ${name}@${version}: ${messageOf(error)}`,
      true,
    );
  }
}
