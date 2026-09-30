// digests.test.ts: Oxagen reads a registry package's digest the way the
// machine does (ADR-233, #4756), with a fake fetch.
import { createHash } from "node:crypto";
import type { RegistryEntry, RegistrySource } from "@oxagen/mcp-studio";
import { describe, expect, it, vi } from "vitest";
import {
  PackagePinProblem,
  readPackagePin,
  registryDigests,
  type RegistryDigests,
} from "./digests";

const sha = (text: string) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

function answer(body: { json?: unknown; bytes?: string }, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body.json ?? {}),
    arrayBuffer: () =>
      Promise.resolve(new TextEncoder().encode(body.bytes ?? "").buffer),
  };
}

const TARBALL = "https://registry.npmjs.org/@acme/files-mcp/-/files-mcp-1.4.0.tgz";
const WHEEL = "https://files.pythonhosted.org/packages/ab/cd/acme_files-1.4.0-py3-none-any.whl";
const SDIST = "https://files.pythonhosted.org/packages/ef/01/acme_files-1.4.0.tar.gz";

describe("registryDigests", () => {
  it("hashes the tarball npm names for the version", async () => {
    const fetchFn = vi.fn((url: string) =>
      Promise.resolve(
        url === TARBALL
          ? answer({ bytes: "the 1.4.0 tarball" })
          : answer({ json: { dist: { tarball: TARBALL } } }),
      ),
    );
    const digest = await registryDigests(
      fetchFn as unknown as typeof fetch,
    ).digest(
      { name: "@acme/files-mcp", version: "1.4.0", registry_type: "npm" },
      { command: "npx", args: ["--yes", "@acme/files-mcp@1.4.0"] },
    );

    expect(digest).toBe(sha("the 1.4.0 tarball"));
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      "https://registry.npmjs.org/@acme%2Ffiles-mcp/1.4.0",
      TARBALL,
    ]);
  });

  it("picks a PyPI release's universal wheel, and hashes the file the launch installs (ADR-233)", async () => {
    const index = "https://pypi.org/pypi/acme-files/1.4.0/json";
    const fetchFn = vi.fn((url: string) =>
      Promise.resolve(
        url === index
          ? answer({
              json: {
                urls: [
                  { filename: "acme_files-1.4.0.tar.gz", url: SDIST, packagetype: "sdist" },
                  { filename: "acme_files-1.4.0-py3-none-any.whl", url: WHEEL, packagetype: "bdist_wheel" },
                ],
              },
            })
          : answer({ bytes: "the 1.4.0 wheel" }),
      ),
    );
    const digests = registryDigests(fetchFn as unknown as typeof fetch);
    const file = await digests.pypiFile({ name: "acme-files", version: "1.4.0" });
    expect(file).toStrictEqual({ name: "acme_files-1.4.0-py3-none-any.whl", url: WHEEL });

    const digest = await digests.digest(
      { name: "acme-files", version: "1.4.0", registry_type: "pypi" },
      { command: "uvx", args: ["--from", WHEEL, "acme-files"] },
    );
    expect(digest).toBe(sha("the 1.4.0 wheel"));
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([index, WHEEL]);
  });

  it("rejects with the registry's answer, and names no local gateway", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(answer({}, 503)));
    const read = registryDigests(fetchFn as unknown as typeof fetch).digest(
      { name: "@acme/files-mcp", version: "1.4.0", registry_type: "npm" },
      { command: "npx", args: ["--yes", "@acme/files-mcp@1.4.0"] },
    );

    await expect(read).rejects.toThrow(
      "the registry answered 503 for https://registry.npmjs.org/@acme%2Ffiles-mcp/1.4.0",
    );
    await expect(read).rejects.not.toThrow(/local gateway/);
  });

  it("reads no executable on a machine", async () => {
    const fetchFn = vi.fn();
    const read = registryDigests(fetchFn as unknown as typeof fetch).digest(
      { name: "files-mcp", version: "2.0.0" },
      { command: "files-mcp", args: [] },
    );

    await expect(read).rejects.toThrow("files-mcp is not on this machine's PATH");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ── readPackagePin ────────────────────────────────────────────────────────────

const SOURCE: RegistrySource = {
  type: "registry",
  registry: "https://registry.modelcontextprotocol.io",
  server: "io.github.acme/files",
  version: "1.4.0",
  machines: ["dev-laptops"],
  registry_type: "pypi",
};

function entryWith(registryType: string, identifier: string): RegistryEntry {
  return {
    server: {
      name: "io.github.acme/files",
      description: "Files on a build host.",
      version: "1.4.0",
      packages: [{ registryType, identifier, version: "1.4.0", transport: { type: "stdio" } }],
    },
  };
}

function fakeReader(fail?: Error) {
  const digest = vi.fn<RegistryDigests["digest"]>(() =>
    fail === undefined ? Promise.resolve(sha("pinned")) : Promise.reject(fail),
  );
  const pypiFile = vi.fn<RegistryDigests["pypiFile"]>(() =>
    Promise.resolve({ name: "acme_files-1.4.0-py3-none-any.whl", url: WHEEL }),
  );
  return { reader: { digest, pypiFile }, digest, pypiFile };
}

async function pinProblem(promise: Promise<unknown>): Promise<PackagePinProblem> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof PackagePinProblem)) throw new Error("expected a PackagePinProblem");
  return error;
}

describe("readPackagePin", () => {
  it("pins a PyPI package to one file, and reads the digest of the launch that installs it", async () => {
    const { reader, digest, pypiFile } = fakeReader();
    const pin = await readPackagePin(reader, SOURCE, entryWith("pypi", "acme-files"));

    expect(pin).toStrictEqual({
      digest: sha("pinned"),
      file: { name: "acme_files-1.4.0-py3-none-any.whl", url: WHEEL },
    });
    expect(pypiFile).toHaveBeenCalledWith({ name: "acme-files", version: "1.4.0" }, undefined);
    expect(digest).toHaveBeenCalledWith(
      { name: "acme-files", version: "1.4.0", registry_type: "pypi" },
      { command: "uvx", args: ["--from", WHEEL, "acme-files"] },
      undefined,
    );
  });

  it("pins an npm package by its digest alone", async () => {
    const { reader, pypiFile } = fakeReader();
    const pin = await readPackagePin(
      reader,
      { ...SOURCE, registry_type: "npm" },
      entryWith("npm", "@acme/files-mcp"),
    );
    expect(pin).toStrictEqual({ digest: sha("pinned") });
    expect(pypiFile).not.toHaveBeenCalled();
  });

  it("refuses a package the entry does not list, for a person to fix (negative)", async () => {
    const { reader } = fakeReader();
    const problem = await pinProblem(readPackagePin(reader, SOURCE, entryWith("npm", "@acme/files-mcp")));
    expect(problem.retriable).toBe(false);
    expect(problem.message).toBe(
      "io.github.acme/files 1.4.0 cannot run on a machine: source.registry_type: the entry lists no pypi package",
    );
  });

  it("refuses an OCI image, whose digest the catalog does not carry (negative)", async () => {
    const { reader, digest } = fakeReader();
    const problem = await pinProblem(
      readPackagePin(reader, { ...SOURCE, registry_type: "oci" }, entryWith("oci", "ghcr.io/acme/files")),
    );
    expect(problem.retriable).toBe(false);
    expect(digest).not.toHaveBeenCalled();
  });

  it("names a registry that did not answer as worth a retry (negative)", async () => {
    const { reader } = fakeReader(new Error("the registry answered 503"));
    const problem = await pinProblem(readPackagePin(reader, SOURCE, entryWith("pypi", "acme-files")));
    expect(problem.retriable).toBe(true);
    expect(problem.message).toBe("Oxagen could not read the digest of acme-files@1.4.0: the registry answered 503");
  });
});
