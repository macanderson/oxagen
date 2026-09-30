// pin.test.ts: what a Studio draft's listing pins before a machine starts it
// (ADR-233, #4756), with a fake registry catalog and a fake digest reader.
import { readFileSync } from "node:fs";
import type { RegistryEntry, ServerSource } from "@oxagen/mcp-studio";
import { describe, expect, it, vi } from "vitest";
import type { RegistryDigests } from "../discovery/digests";
import type { RegistryCatalog } from "../discovery/seams";
import { draftSource, pinListing, type PinDeps } from "./pin";

const DIGEST = `sha256:${"c3".repeat(32)}`;
const REGISTRY = "https://registry.modelcontextprotocol.io";

const LOCAL: ServerSource = {
  type: "local",
  command: "/usr/local/bin/files-mcp",
  args: ["--stdio"],
  machines: ["dev-laptops"],
};

const PACKAGE: ServerSource = {
  type: "registry",
  registry: REGISTRY,
  server: "io.github.acme/files",
  version: "1.4.0",
  machines: ["build-hosts"],
  registry_type: "npm",
};

function acmeEntry(packages: NonNullable<RegistryEntry["server"]["packages"]>): RegistryEntry {
  return {
    server: { name: "io.github.acme/files", description: "Files on a build host.", version: "1.4.0", packages },
  };
}

const NPM_ENTRY = acmeEntry([
  { registryType: "npm", identifier: "@acme/files-mcp", version: "1.4.0", transport: { type: "stdio" } },
]);

function deps(over: { entry?: RegistryCatalog["entry"]; digest?: RegistryDigests["digest"] } = {}) {
  const entry = vi.fn<RegistryCatalog["entry"]>(over.entry ?? (() => Promise.resolve(NPM_ENTRY)));
  const digest = vi.fn<RegistryDigests["digest"]>(over.digest ?? (() => Promise.resolve(DIGEST)));
  const pinDeps: PinDeps = { catalog: { entry }, digests: { digest }, signal: new AbortController().signal };
  return { entry, digest, pinDeps };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (error === undefined) throw new Error("expected a refusal");
  return error as { code: string; reason: string; message: string };
}

describe("pinListing for a local command", () => {
  it("pins the version and SHA-256 the person names, and reads no registry", async () => {
    const { entry, digest, pinDeps } = deps();
    const pinned = await pinListing("files", LOCAL, { version: "1.4.0", digest: DIGEST }, pinDeps);

    expect(pinned).toEqual({
      source: LOCAL,
      groups: ["dev-laptops"],
      lockSource: {
        type: "local",
        command: "/usr/local/bin/files-mcp",
        package: { name: "files-mcp", version: "1.4.0", digest: DIGEST },
      },
    });
    expect(entry).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
  });

  it("refuses a local command with no pin, since only the person can name it (negative)", async () => {
    const error = await refusal(pinListing("files", LOCAL, undefined, deps().pinDeps));
    expect(error).toMatchObject({ code: "conflict", reason: "pin_required" });
    expect(error.message).toMatch(/SHA-256 of the executable \/usr\/local\/bin\/files-mcp resolves to/);
  });
});

describe("pinListing for a registry package", () => {
  it("pins the SHA-256 Oxagen reads from the registry, and the launch registryLaunch builds", async () => {
    const { entry, digest, pinDeps } = deps();
    const pinned = await pinListing("files", PACKAGE, undefined, pinDeps);

    expect(entry).toHaveBeenCalledWith(REGISTRY, "io.github.acme/files", "1.4.0", pinDeps.signal);
    expect(digest).toHaveBeenCalledWith(
      { name: "@acme/files-mcp", version: "1.4.0", registry_type: "npm" },
      { command: "npx", args: ["--yes", "@acme/files-mcp@1.4.0"] },
      pinDeps.signal,
    );
    expect(pinned.groups).toEqual(["build-hosts"]);
    expect(pinned.lockSource).toMatchObject({
      type: "registry",
      server: "io.github.acme/files",
      version: "1.4.0",
      package: { name: "@acme/files-mcp", version: "1.4.0", digest: DIGEST, registry_type: "npm" },
      command: "npx",
      args: ["--yes", "@acme/files-mcp@1.4.0"],
    });
  });

  it("refuses a pin the person sends, since Oxagen reads the registry's (negative)", async () => {
    const error = await refusal(pinListing("files", PACKAGE, { version: "1.4.0", digest: DIGEST }, deps().pinDeps));
    expect(error).toMatchObject({ code: "conflict", reason: "pin_not_accepted" });
  });

  it("stops an OCI image and a PyPI release at needs_digest, before any registry read (negative)", async () => {
    for (const registry_type of ["oci", "pypi"] as const) {
      const { entry, pinDeps } = deps();
      const error = await refusal(pinListing("files", { ...PACKAGE, registry_type }, undefined, pinDeps));
      expect(error).toMatchObject({ code: "conflict", reason: "needs_digest" });
      expect(entry).not.toHaveBeenCalled();
    }
  });

  it("refuses when the registry does not answer the entry or the digest (negative)", async () => {
    const noEntry = await refusal(
      pinListing("files", PACKAGE, undefined, deps({ entry: () => Promise.reject(new Error("503")) }).pinDeps),
    );
    expect(noEntry).toMatchObject({ reason: "registry_unreachable" });
    expect(noEntry.message).toBe("Oxagen could not read io.github.acme/files 1.4.0 from the registry: 503");

    const noDigest = await refusal(
      pinListing("files", PACKAGE, undefined, deps({ digest: () => Promise.reject(new Error("the registry answered 404")) }).pinDeps),
    );
    expect(noDigest).toMatchObject({ reason: "registry_unreachable" });
    expect(noDigest.message).toBe("Oxagen could not read the digest of @acme/files-mcp@1.4.0: the registry answered 404");
  });

  it("refuses an entry that lists no package of the source's type (negative)", async () => {
    const { digest, pinDeps } = deps({ entry: () => Promise.resolve(acmeEntry([])) });
    const error = await refusal(pinListing("files", PACKAGE, undefined, pinDeps));
    expect(error).toMatchObject({ reason: "source_invalid" });
    expect(error.message).toMatch(/^io\.github\.acme\/files 1\.4\.0 cannot run on a machine: /);
    expect(digest).not.toHaveBeenCalled();
  });
});

describe("pinListing refuses a server that does not run on machines", () => {
  it("refuses a remote server and a registry server on its endpoint (negative)", async () => {
    const remote: ServerSource = { type: "remote", url: "https://mcp.acme.test/mcp", transport: "http" };
    expect(await refusal(pinListing("files", remote, undefined, deps().pinDeps))).toMatchObject({
      reason: "listing_not_machine_run",
    });
    const { machines: _machines, ...onEndpoint } = PACKAGE as Extract<ServerSource, { type: "registry" }>;
    expect(await refusal(pinListing("files", onEndpoint, undefined, deps().pinDeps))).toMatchObject({
      reason: "listing_not_machine_run",
    });
  });

  it("refuses a server whose source.machines names no group (negative)", async () => {
    const error = await refusal(
      pinListing("files", { ...LOCAL, machines: [] }, { version: "1.4.0", digest: DIGEST }, deps().pinDeps),
    );
    expect(error).toMatchObject({ reason: "machines_required" });
  });
});

describe("draftSource", () => {
  it("reads the source from the draft's server.toml", () => {
    const text = readFileSync(
      new URL("../../../../mcp-studio/fixtures/servers/files/server.toml", import.meta.url),
      "utf8",
    );
    expect(draftSource("files", text)).toMatchObject({
      type: "registry",
      server: "io.github.modelcontextprotocol/server-filesystem",
      machines: ["dev-laptops"],
    });
  });

  it("refuses a draft with no server.toml, and one that does not read (negative)", () => {
    const thrown = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error;
      }
      throw new Error("expected a refusal");
    };
    expect(thrown(() => draftSource("files", null))).toMatchObject({ reason: "server_toml_missing" });
    expect(thrown(() => draftSource("files", 'name = "files"\n'))).toMatchObject({
      reason: "server_toml_invalid",
    });
  });
});
