/**
 * The digest of the package a launch would run, which the local gateway
 * compares with the lock before it starts a server (mcp-studio-spec, Local
 * servers and Registry packages).
 *
 * The digest names the artifact itself. For npm it is the SHA-256 of the
 * tarball the registry serves, and for nuget the SHA-256 of the nupkg. For
 * pypi it is the SHA-256 the index reports for one of the release's files.
 * For oci it is the image manifest digest the launch pins, which docker
 * enforces when it pulls by digest. For a local server it is the SHA-256 of
 * the executable the command resolves to on this machine.
 *
 * A registry artifact never changes under its version, so the digester
 * remembers each answer. A local executable can change at any time, so it
 * hashes that file on every call.
 */
import { join } from "node:path";
import { digestBytes, SHA256_DIGEST_PATTERN, type Sha256Digest } from "../../digest";
import { digestUnavailable, LocalServerError } from "./errors";
import type { MachineEnv } from "./launch";
import type { LaunchPackage, LaunchSpec, RegistryType } from "./wire";

/** Where the digester reads each registry. */
export const REGISTRY_URLS = {
  npm: "https://registry.npmjs.org",
  pypi: "https://pypi.org/pypi",
  nuget: "https://api.nuget.org/v3-flatcontainer",
} as const;

/** How long one registry read may take before the digester gives up. */
export const DEFAULT_DIGEST_TIMEOUT_MS = 60_000;

export interface DigestResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The subset of `fetch` the digester uses. */
export type DigestFetch = (url: string, init: { signal: AbortSignal }) => Promise<DigestResponse>;

export interface PackageDigesterDeps {
  fetch: DigestFetch;
  readFile(path: string): Promise<Uint8Array>;
  realpath(path: string): Promise<string>;
  /** The path a command runs from, found on `pathValue`, or undefined when it is on none of it. */
  which(command: string, pathValue: string | undefined): Promise<string | undefined>;
  env: MachineEnv;
  timeoutMs?: number;
}

export interface PackageDigester {
  /** The digest of what the launch would run. Throws a LocalServerError with digest_unavailable when it cannot tell. */
  digest(
    pkg: LaunchPackage,
    launch: Pick<LaunchSpec, "command" | "args">,
    signal?: AbortSignal,
  ): Promise<Sha256Digest>;
}

/** A failure the digester reports as the reason in digest_unavailable. */
class DigestProblem extends Error {}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** npm's URL form of a package name: a scoped name keeps its @ and escapes its slash. */
export function npmNameSegment(name: string): string {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

/** How a path search runs on this platform. */
export interface PathSearch {
  /** What separates PATH entries: ":" on Unix, ";" on Windows. */
  delimiter: string;
  /** The suffixes to try on each name: [""] on Unix, PATHEXT's entries on Windows. */
  extensions: readonly string[];
  isExecutable(path: string): Promise<boolean>;
}

/**
 * Find a command the way a shell does. A command that names a directory runs
 * from that path. Any other command runs from the first PATH entry that holds
 * an executable of that name.
 */
export async function whichOnPath(
  command: string,
  pathValue: string | undefined,
  search: PathSearch,
): Promise<string | undefined> {
  const candidates =
    command.includes("/") || command.includes("\\")
      ? [command]
      : (pathValue ?? "")
          .split(search.delimiter)
          .filter((dir) => dir.length > 0)
          .map((dir) => join(dir, command));
  for (const candidate of candidates) {
    for (const extension of search.extensions) {
      if (await search.isExecutable(candidate + extension)) return candidate + extension;
    }
  }
  return undefined;
}

/** The path search for the platform this process runs on. */
export function platformPathSearch(
  platform: NodeJS.Platform,
  env: MachineEnv,
  isExecutable: (path: string) => Promise<boolean>,
): PathSearch {
  if (platform !== "win32") return { delimiter: ":", extensions: [""], isExecutable };
  const pathExt = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return {
    delimiter: ";",
    extensions: ["", ...pathExt.split(";").filter((ext) => ext.length > 0)],
    isExecutable,
  };
}

export function createPackageDigester(deps: PackageDigesterDeps): PackageDigester {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_DIGEST_TIMEOUT_MS;
  const remembered = new Map<string, Promise<readonly Sha256Digest[]>>();

  async function read(url: string, signal: AbortSignal | undefined): Promise<DigestResponse> {
    const limit = AbortSignal.timeout(timeoutMs);
    let response: DigestResponse;
    try {
      response = await deps.fetch(url, {
        signal: signal === undefined ? limit : AbortSignal.any([signal, limit]),
      });
    } catch (error) {
      throw new DigestProblem(`the registry could not be reached (${String(error)})`);
    }
    if (!response.ok) throw new DigestProblem(`the registry answered ${response.status} for ${url}`);
    return response;
  }

  async function bytesAt(url: string, signal: AbortSignal | undefined): Promise<Sha256Digest> {
    const response = await read(url, signal);
    return digestBytes(new Uint8Array(await response.arrayBuffer()));
  }

  async function npmDigests(pkg: LaunchPackage, signal: AbortSignal | undefined): Promise<Sha256Digest[]> {
    const url = `${REGISTRY_URLS.npm}/${npmNameSegment(pkg.name)}/${encodeURIComponent(pkg.version)}`;
    const manifest = objectOf(await (await read(url, signal)).json());
    const tarball = objectOf(manifest?.dist)?.tarball;
    if (typeof tarball !== "string" || !tarball.startsWith("https://")) {
      throw new DigestProblem("the registry's answer names no https tarball");
    }
    return [await bytesAt(tarball, signal)];
  }

  async function pypiDigests(pkg: LaunchPackage, signal: AbortSignal | undefined): Promise<Sha256Digest[]> {
    const url = `${REGISTRY_URLS.pypi}/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}/json`;
    const release = objectOf(await (await read(url, signal)).json());
    const urls = release?.urls;
    const files = Array.isArray(urls) ? (urls as unknown[]) : [];
    const digests = files
      .map((file) => objectOf(objectOf(file)?.digests)?.sha256)
      .filter(isSha256Hex)
      .map((hex): Sha256Digest => `sha256:${hex}`);
    if (digests.length === 0) throw new DigestProblem("the index lists no file with a sha256 digest");
    return digests;
  }

  async function nugetDigests(pkg: LaunchPackage, signal: AbortSignal | undefined): Promise<Sha256Digest[]> {
    const id = encodeURIComponent(pkg.name.toLowerCase());
    const version = encodeURIComponent(pkg.version.toLowerCase());
    return [await bytesAt(`${REGISTRY_URLS.nuget}/${id}/${version}/${id}.${version}.nupkg`, signal)];
  }

  function registryDigests(
    type: Exclude<RegistryType, "oci">,
    pkg: LaunchPackage,
    signal: AbortSignal | undefined,
  ): Promise<readonly Sha256Digest[]> {
    const key = `${type}:${pkg.name}@${pkg.version}`;
    const known = remembered.get(key);
    if (known !== undefined) return known;
    const readers = { npm: npmDigests, pypi: pypiDigests, nuget: nugetDigests };
    const pending = readers[type](pkg, signal);
    remembered.set(key, pending);
    // A failed read is forgotten, so the next call asks the registry again.
    pending.catch(() => remembered.delete(key));
    return pending;
  }

  function ociDigest(pkg: LaunchPackage, args: readonly string[]): Sha256Digest {
    const prefix = `${pkg.name}@`;
    const pinned = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
    if (pinned === undefined || !SHA256_DIGEST_PATTERN.test(pinned)) {
      throw new DigestProblem(`the launch does not pull ${pkg.name} by a sha256 digest`);
    }
    return pinned as Sha256Digest;
  }

  async function localDigest(command: string): Promise<Sha256Digest> {
    const found = await deps.which(command, deps.env.PATH);
    if (found === undefined) throw new DigestProblem(`${command} is not on this machine's PATH`);
    try {
      return digestBytes(await deps.readFile(await deps.realpath(found)));
    } catch (error) {
      throw new DigestProblem(`${found} could not be read (${String(error)})`);
    }
  }

  async function digestOf(
    pkg: LaunchPackage,
    launch: Pick<LaunchSpec, "command" | "args">,
    signal: AbortSignal | undefined,
  ): Promise<Sha256Digest> {
    const type = pkg.registry_type;
    if (type === undefined) return localDigest(launch.command);
    if (type === "oci") return ociDigest(pkg, launch.args);
    const digests = await registryDigests(type, pkg, signal);
    // A pypi release carries several files, and uvx picks one. The lock pins
    // the file it was made from, so any file with that digest is a match.
    const locked = pkg.digest as Sha256Digest;
    return digests.includes(locked) ? locked : (digests[0] as Sha256Digest);
  }

  return {
    async digest(pkg, launch, signal) {
      try {
        return await digestOf(pkg, launch, signal);
      } catch (error) {
        const reason = error instanceof DigestProblem ? error.message : String(error);
        throw new LocalServerError(digestUnavailable(`${pkg.name}@${pkg.version}`, reason));
      }
    },
  };
}
