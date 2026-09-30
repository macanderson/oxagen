/**
 * The digest of the package a launch would run, which the local gateway
 * compares with the lock before it starts a server (mcp-studio-spec, Local
 * servers and Registry packages).
 *
 * The digest names the artifact itself. For npm it is the SHA-256 of the
 * tarball the registry serves, and for nuget the SHA-256 of the nupkg. For
 * pypi it is the SHA-256 of the one file the launch installs with
 * `uvx --from <url>`: the release's universal wheel, or its source
 * distribution (ADR-233). pickPypiFile chooses that file, and Oxagen chooses
 * it with the same function, so the two reads agree.
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

/** One file of a PyPI release: its file name, and the URL a launch installs it from. */
export interface PypiFile {
  name: string;
  url: string;
}

export interface PackageDigester {
  /** The digest of what the launch would run. Throws a LocalServerError with digest_unavailable when it cannot tell. */
  digest(
    pkg: LaunchPackage,
    launch: Pick<LaunchSpec, "command" | "args">,
    signal?: AbortSignal,
  ): Promise<Sha256Digest>;
  /**
   * The one file of a PyPI release a pin names (pickPypiFile), read from the
   * index. Null when the release has no such file, which only a new release
   * changes. Throws a LocalServerError with digest_unavailable when the index
   * does not answer, which a later read may.
   */
  pypiFile(pkg: Pick<LaunchPackage, "name" | "version">, signal?: AbortSignal): Promise<PypiFile | null>;
}

/** A failure the digester reports as the reason in digest_unavailable. */
class DigestProblem extends Error {}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A wheel that runs on every host: pure Python 3, no ABI, any platform. */
const UNIVERSAL_WHEEL = /-(?:py3|py2\.py3)-none-any\.whl$/;

/**
 * The one file of a PyPI release a pin names (ADR-233), from the index's
 * `urls` list: the release's universal wheel, or its source distribution
 * when it has none. A yanked file, and one served over anything but https,
 * is never picked. Undefined when the release has neither.
 */
export function pickPypiFile(urls: unknown): PypiFile | undefined {
  const files = (Array.isArray(urls) ? (urls as unknown[]) : []).flatMap((raw) => {
    const file = objectOf(raw);
    const name = file?.filename;
    const url = file?.url;
    if (typeof name !== "string" || typeof url !== "string" || !url.startsWith("https://")) return [];
    if (file?.yanked === true) return [];
    return [{ name, url, type: file?.packagetype }];
  });
  const pick =
    files.find((file) => file.type === "bdist_wheel" && UNIVERSAL_WHEEL.test(file.name)) ??
    files.find((file) => file.type === "sdist");
  return pick === undefined ? undefined : { name: pick.name, url: pick.url };
}

/** The URL a pypi launch installs from: the word after `--from`, when it is https. */
export function pypiFromUrl(args: readonly string[]): string | undefined {
  const at = args.indexOf("--from");
  const url = at < 0 ? undefined : args[at + 1];
  return url !== undefined && url.startsWith("https://") ? url : undefined;
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
  const files = new Map<string, Promise<Sha256Digest>>();

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

  async function releaseFile(
    pkg: Pick<LaunchPackage, "name" | "version">,
    signal: AbortSignal | undefined,
  ): Promise<PypiFile | null> {
    const url = `${REGISTRY_URLS.pypi}/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}/json`;
    const release = objectOf(await (await read(url, signal)).json());
    return pickPypiFile(release?.urls) ?? null;
  }

  /** The SHA-256 of the file at `url`. A published file never changes, so it is read once. */
  function fileDigest(url: string, signal: AbortSignal | undefined): Promise<Sha256Digest> {
    const known = files.get(url);
    if (known !== undefined) return known;
    const pending = bytesAt(url, signal);
    files.set(url, pending);
    pending.catch(() => files.delete(url));
    return pending;
  }

  async function nugetDigests(pkg: LaunchPackage, signal: AbortSignal | undefined): Promise<Sha256Digest[]> {
    const id = encodeURIComponent(pkg.name.toLowerCase());
    const version = encodeURIComponent(pkg.version.toLowerCase());
    return [await bytesAt(`${REGISTRY_URLS.nuget}/${id}/${version}/${id}.${version}.nupkg`, signal)];
  }

  function registryDigests(
    type: Exclude<RegistryType, "oci" | "pypi">,
    pkg: LaunchPackage,
    signal: AbortSignal | undefined,
  ): Promise<readonly Sha256Digest[]> {
    const key = `${type}:${pkg.name}@${pkg.version}`;
    const known = remembered.get(key);
    if (known !== undefined) return known;
    const readers = { npm: npmDigests, nuget: nugetDigests };
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
    if (type === "pypi") {
      // A release holds one file per host, and uvx name@version would pick
      // one. The launch names the one file the pin was made from.
      const url = pypiFromUrl(launch.args);
      if (url === undefined) {
        throw new DigestProblem("the launch does not install one pinned file with --from <url>");
      }
      return fileDigest(url, signal);
    }
    const digests = await registryDigests(type, pkg, signal);
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
    async pypiFile(pkg, signal) {
      try {
        return await releaseFile(pkg, signal);
      } catch (error) {
        const reason = error instanceof DigestProblem ? error.message : String(error);
        throw new LocalServerError(digestUnavailable(`${pkg.name}@${pkg.version}`, reason));
      }
    },
  };
}
