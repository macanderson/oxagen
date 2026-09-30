import { describe, expect, it, vi } from "vitest";
import { digestBytes } from "../../digest";
import {
  createPackageDigester,
  npmNameSegment,
  pickPypiFile,
  platformPathSearch,
  pypiFromUrl,
  REGISTRY_URLS,
  whichOnPath,
  type DigestFetch,
  type DigestResponse,
  type PackageDigester,
  type PackageDigesterDeps,
} from "./digest";
import { digestUnavailable, LocalServerError, type LocalServerRefusal } from "./errors";
import { NPM_DIGEST, npmLaunch } from "./test-support";
import type { LaunchPackage } from "./wire";

const FILES = npmLaunch().package;
const FILES_WHAT = "@modelcontextprotocol/server-filesystem@2026.8.1";
const MANIFEST_URL = `${REGISTRY_URLS.npm}/@modelcontextprotocol%2Fserver-filesystem/2026.8.1`;
const TARBALL_URL = "https://registry.npmjs.org/@modelcontextprotocol/server-filesystem/-/server-filesystem-2026.8.1.tgz";

function bufferOf(text: string): ArrayBuffer {
  const view = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(view.byteLength);
  new Uint8Array(buffer).set(view);
  return buffer;
}

function digestOfText(text: string): string {
  return digestBytes(new TextEncoder().encode(text));
}

function jsonAnswer(body: unknown, status = 200): DigestResponse {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.reject(new Error("not bytes")),
  };
}

function bytesAnswer(text: string): DigestResponse {
  return {
    ok: true,
    status: 200,
    json: () => Promise.reject(new Error("not JSON")),
    arrayBuffer: () => Promise.resolve(bufferOf(text)),
  };
}

/** A registry that answers each URL from the table, and fails any other. */
function registry(routes: Record<string, DigestResponse | Error>) {
  return vi.fn<DigestFetch>((url) => {
    const route = routes[url];
    if (route === undefined) return Promise.reject(new Error(`no route for ${url}`));
    return route instanceof Error ? Promise.reject(route) : Promise.resolve(route);
  });
}

function npmRegistry() {
  return registry({
    [MANIFEST_URL]: jsonAnswer({ dist: { tarball: TARBALL_URL } }),
    [TARBALL_URL]: bytesAnswer("tarball bytes"),
  });
}

function digester(overrides: Partial<PackageDigesterDeps>): PackageDigester {
  return createPackageDigester({
    fetch: registry({}),
    readFile: () => Promise.reject(new Error("unexpected read")),
    realpath: (path) => Promise.resolve(path),
    which: () => Promise.resolve(undefined),
    env: {},
    ...overrides,
  });
}

async function refusalOf(promise: Promise<unknown>): Promise<LocalServerRefusal> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(LocalServerError);
  return (error as LocalServerError).refusal();
}

describe("npmNameSegment", () => {
  it("keeps a scoped name's @ and escapes its slash", () => {
    expect(npmNameSegment("@modelcontextprotocol/server-filesystem")).toBe("@modelcontextprotocol%2Fserver-filesystem");
  });

  it("leaves an unscoped name as it is", () => {
    expect(npmNameSegment("left-pad")).toBe("left-pad");
  });
});

describe("whichOnPath", () => {
  const unix = (executables: string[]) => platformPathSearch("linux", {}, (path) => Promise.resolve(executables.includes(path)));

  it("runs a command that names a Unix path from that path", async () => {
    expect(await whichOnPath("/opt/tools/notes", "/usr/bin", unix(["/opt/tools/notes"]))).toBe("/opt/tools/notes");
  });

  it("runs a command that names a Windows path from that path", async () => {
    expect(await whichOnPath("C:\\tools\\notes", "/usr/bin", unix(["C:\\tools\\notes"]))).toBe("C:\\tools\\notes");
  });

  it("finds a bare command in the first PATH entry that holds it, skipping empty entries", async () => {
    const isExecutable = vi.fn((path: string) => Promise.resolve(path === "/usr/local/bin/npx"));
    const search = platformPathSearch("darwin", {}, isExecutable);
    expect(await whichOnPath("npx", "/usr/bin::/usr/local/bin", search)).toBe("/usr/local/bin/npx");
    expect(isExecutable.mock.calls.map(([path]) => path)).toEqual(["/usr/bin/npx", "/usr/local/bin/npx"]);
  });

  it("tries each extension in order", async () => {
    const search = platformPathSearch("win32", { PATHEXT: ".EXE;.CMD" }, (path) =>
      Promise.resolve(path === "/opt/b/npx.CMD"),
    );
    expect(await whichOnPath("npx", "/opt/a;/opt/b", search)).toBe("/opt/b/npx.CMD");
  });

  it("finds nothing when the machine sets no PATH", async () => {
    expect(await whichOnPath("npx", undefined, unix(["/usr/bin/npx"]))).toBeUndefined();
  });

  it("finds nothing when no PATH entry holds the command", async () => {
    expect(await whichOnPath("npx", "/usr/bin", unix([]))).toBeUndefined();
  });
});

describe("platformPathSearch", () => {
  const isExecutable = () => Promise.resolve(true);

  it("splits PATH on colons and tries the bare name on Unix", () => {
    expect(platformPathSearch("linux", { PATHEXT: ".EXE" }, isExecutable)).toEqual({
      delimiter: ":",
      extensions: [""],
      isExecutable,
    });
  });

  it("splits PATH on semicolons and tries PATHEXT's entries on Windows", () => {
    expect(platformPathSearch("win32", { PATHEXT: ".EXE;.CMD;" }, isExecutable)).toEqual({
      delimiter: ";",
      extensions: ["", ".EXE", ".CMD"],
      isExecutable,
    });
  });

  it("uses Windows' default PATHEXT when the machine sets none", () => {
    expect(platformPathSearch("win32", {}, isExecutable).extensions).toEqual(["", ".COM", ".EXE", ".BAT", ".CMD"]);
  });
});

describe("createPackageDigester for npm", () => {
  it("hashes the tarball the registry serves for the version", async () => {
    const fetch = npmRegistry();
    expect(await digester({ fetch }).digest(FILES, npmLaunch())).toBe(digestOfText("tarball bytes"));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([MANIFEST_URL, TARBALL_URL]);
    const signal = fetch.mock.calls[0]?.[1].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("returns the lock's digest when the tarball matches it", async () => {
    const pkg = { ...FILES, digest: digestOfText("tarball bytes") };
    expect(await digester({ fetch: npmRegistry() }).digest(pkg, npmLaunch())).toBe(pkg.digest);
  });

  it("asks the registry once for a version it already read", async () => {
    const fetch = npmRegistry();
    const digests = digester({ fetch, timeoutMs: 1_000 });
    await digests.digest(FILES, npmLaunch());
    await digests.digest(FILES, npmLaunch());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops the registry read when the caller's signal aborts", async () => {
    const fetch = npmRegistry();
    const controller = new AbortController();
    await digester({ fetch }).digest(FILES, npmLaunch(), controller.signal);
    const signal = fetch.mock.calls[0]?.[1].signal;
    expect(signal).not.toBe(controller.signal);
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("refuses a manifest whose tarball is not on https", async () => {
    const fetch = registry({ [MANIFEST_URL]: jsonAnswer({ dist: { tarball: "http://registry.example/files.tgz" } }) });
    expect(await refusalOf(digester({ fetch }).digest(FILES, npmLaunch()))).toEqual(
      digestUnavailable(FILES_WHAT, "the registry's answer names no https tarball"),
    );
  });

  it.each([
    ["null", null],
    ["a list", [{ dist: { tarball: TARBALL_URL } }]],
    ["a manifest without dist", { name: "files" }],
  ])("refuses a manifest that is %s", async (_name, body) => {
    const fetch = registry({ [MANIFEST_URL]: jsonAnswer(body) });
    expect(await refusalOf(digester({ fetch }).digest(FILES, npmLaunch()))).toEqual(
      digestUnavailable(FILES_WHAT, "the registry's answer names no https tarball"),
    );
  });

  it("names the network error when the registry cannot be reached", async () => {
    const fetch = registry({ [MANIFEST_URL]: new Error("ECONNRESET") });
    expect(await refusalOf(digester({ fetch }).digest(FILES, npmLaunch()))).toEqual(
      digestUnavailable(FILES_WHAT, "the registry could not be reached (Error: ECONNRESET)"),
    );
  });

  it("names the status and URL when the registry answers with an error", async () => {
    const fetch = registry({ [MANIFEST_URL]: jsonAnswer({ error: "not found" }, 404) });
    expect(await refusalOf(digester({ fetch }).digest(FILES, npmLaunch()))).toEqual(
      digestUnavailable(FILES_WHAT, `the registry answered 404 for ${MANIFEST_URL}`),
    );
  });

  it("names any other error as it is", async () => {
    const broken: DigestResponse = {
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
      arrayBuffer: () => Promise.reject(new Error("not bytes")),
    };
    const fetch = registry({ [MANIFEST_URL]: broken });
    expect(await refusalOf(digester({ fetch }).digest(FILES, npmLaunch()))).toEqual(
      digestUnavailable(FILES_WHAT, "SyntaxError: Unexpected token"),
    );
  });

  it("forgets a failed read, so the next call asks the registry again", async () => {
    const fetch = npmRegistry();
    fetch.mockImplementationOnce(() => Promise.reject(new Error("ETIMEDOUT")));
    const digests = digester({ fetch });
    await refusalOf(digests.digest(FILES, npmLaunch()));
    expect(await digests.digest(FILES, npmLaunch())).toBe(digestOfText("tarball bytes"));
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("createPackageDigester for pypi (ADR-233)", () => {
  const locked = `sha256:${"e".repeat(64)}`;
  const pkg: LaunchPackage = { name: "mcp-server-git", version: "1.2.0", digest: locked, registry_type: "pypi" };
  const index = `${REGISTRY_URLS.pypi}/mcp-server-git/1.2.0/json`;
  const wheel = "https://files.pythonhosted.org/packages/ab/cd/mcp_server_git-1.2.0-py3-none-any.whl";
  const sdist = "https://files.pythonhosted.org/packages/ef/01/mcp_server_git-1.2.0.tar.gz";
  const file = (filename: string, url: string, packagetype: string, extra: Record<string, unknown> = {}) => ({
    filename,
    url,
    packagetype,
    ...extra,
  });

  it("hashes the one file the launch installs with --from, and reads it once", async () => {
    const fetch = registry({ [wheel]: bytesAnswer("wheel bytes") });
    const digests = digester({ fetch });
    const launch = { command: "uvx", args: ["--from", wheel, "mcp-server-git"] };
    expect(await digests.digest(pkg, launch)).toBe(digestOfText("wheel bytes"));
    expect(await digests.digest(pkg, launch)).toBe(digestOfText("wheel bytes"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a launch that lets uvx pick the file (negative)", async () => {
    const fetch = registry({});
    const launch = { command: "uvx", args: ["mcp-server-git@1.2.0"] };
    expect(await refusalOf(digester({ fetch }).digest(pkg, launch))).toEqual(
      digestUnavailable("mcp-server-git@1.2.0", "the launch does not install one pinned file with --from <url>"),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("picks the universal wheel over the source distribution and a platform wheel", async () => {
    const fetch = registry({
      [index]: jsonAnswer({
        urls: [
          file("mcp_server_git-1.2.0.tar.gz", sdist, "sdist"),
          file("mcp_server_git-1.2.0-cp312-cp312-manylinux_2_17_x86_64.whl", "https://files.pythonhosted.org/x.whl", "bdist_wheel"),
          file("mcp_server_git-1.2.0-py3-none-any.whl", wheel, "bdist_wheel"),
        ],
      }),
    });
    expect(await digester({ fetch }).pypiFile(pkg)).toStrictEqual({
      name: "mcp_server_git-1.2.0-py3-none-any.whl",
      url: wheel,
    });
  });

  it.each([
    ["a py2.py3 wheel", "mcp_server_git-1.2.0-py2.py3-none-any.whl", true],
    ["a py3 wheel", "mcp_server_git-1.2.0-py3-none-any.whl", true],
    ["a CPython wheel", "mcp_server_git-1.2.0-cp312-none-any.whl", false],
  ])("counts %s as universal: %s", (_what, filename, universal) => {
    const picked = pickPypiFile([
      file(filename, wheel, "bdist_wheel"),
      file("mcp_server_git-1.2.0.tar.gz", sdist, "sdist"),
    ]);
    expect(picked?.name).toBe(universal ? filename : "mcp_server_git-1.2.0.tar.gz");
  });

  it("skips a yanked file and a file served over http", () => {
    expect(
      pickPypiFile([
        file("mcp_server_git-1.2.0-py3-none-any.whl", wheel, "bdist_wheel", { yanked: true }),
        file("mcp_server_git-1.2.0.tar.gz", sdist.replace("https:", "http:"), "sdist"),
        "not a file",
        {},
      ]),
    ).toBeUndefined();
  });

  it.each([
    ["no urls list", { urls: "none" }],
    ["no release", null],
    ["no universal wheel and no source distribution", { urls: [file("x-cp312.whl", wheel, "bdist_wheel")] }],
  ])("answers no file for an index answer with %s, which only a new release changes (negative)", async (_name, body) => {
    const fetch = registry({ [index]: jsonAnswer(body) });
    expect(await digester({ fetch }).pypiFile(pkg)).toBeNull();
  });

  it("refuses when the index does not answer, which a later read may (negative)", async () => {
    const fetch = registry({ [index]: jsonAnswer({}, 503) });
    expect(await refusalOf(digester({ fetch }).pypiFile(pkg))).toEqual(
      digestUnavailable("mcp-server-git@1.2.0", `the registry answered 503 for ${index}`),
    );
  });

  it("reads the URL after --from, when it is https", () => {
    expect(pypiFromUrl(["--from", wheel, "mcp-server-git"])).toBe(wheel);
    expect(pypiFromUrl(["--from", wheel.replace("https:", "http:"), "mcp-server-git"])).toBeUndefined();
    expect(pypiFromUrl(["--from"])).toBeUndefined();
    expect(pypiFromUrl(["mcp-server-git@1.2.0"])).toBeUndefined();
  });
});

describe("createPackageDigester for nuget", () => {
  it("hashes the nupkg at the lowercased id and version", async () => {
    const pkg: LaunchPackage = {
      name: "Contoso.Mcp.Server",
      version: "2.0.0-Beta",
      digest: NPM_DIGEST,
      registry_type: "nuget",
    };
    const url = `${REGISTRY_URLS.nuget}/contoso.mcp.server/2.0.0-beta/contoso.mcp.server.2.0.0-beta.nupkg`;
    const fetch = registry({ [url]: bytesAnswer("nupkg bytes") });
    const launch = { command: "dnx", args: ["--yes", "Contoso.Mcp.Server@2.0.0-Beta"] };
    expect(await digester({ fetch }).digest(pkg, launch)).toBe(digestOfText("nupkg bytes"));
  });
});

describe("createPackageDigester for oci", () => {
  const image = `sha256:${"d".repeat(64)}`;
  const pkg: LaunchPackage = { name: "ghcr.io/github/github-mcp-server", version: "1.4.0", digest: image, registry_type: "oci" };

  it("reads the digest the launch pulls by, without a registry read", async () => {
    const fetch = registry({});
    const launch = { command: "docker", args: ["run", "--rm", "-i", `ghcr.io/github/github-mcp-server@${image}`] };
    expect(await digester({ fetch }).digest(pkg, launch)).toBe(image);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["does not name the image", ["run", "--rm", "-i"]],
    ["pulls the image by tag", ["run", "--rm", "-i", "ghcr.io/github/github-mcp-server@latest"]],
  ])("refuses a launch that %s", async (_name, args) => {
    expect(await refusalOf(digester({}).digest(pkg, { command: "docker", args }))).toEqual(
      digestUnavailable(
        "ghcr.io/github/github-mcp-server@1.4.0",
        "the launch does not pull ghcr.io/github/github-mcp-server by a sha256 digest",
      ),
    );
  });
});

describe("createPackageDigester for a local server", () => {
  const pkg: LaunchPackage = { name: "notes-server", version: "0.3.0", digest: NPM_DIGEST };
  const launch = { command: "notes-server", args: ["--root", "/work"] };

  it("hashes the file the command resolves to, on every call", async () => {
    const which = vi.fn(() => Promise.resolve<string | undefined>("/usr/local/bin/notes-server"));
    const realpath = vi.fn(() => Promise.resolve("/opt/notes/bin/server"));
    const readFile = vi.fn(() => Promise.resolve(new TextEncoder().encode("server bytes")));
    const digests = digester({ which, realpath, readFile, env: { PATH: "/usr/local/bin" } });
    expect(await digests.digest(pkg, launch)).toBe(digestOfText("server bytes"));
    await digests.digest(pkg, launch);
    expect(which).toHaveBeenCalledWith("notes-server", "/usr/local/bin");
    expect(realpath).toHaveBeenCalledWith("/usr/local/bin/notes-server");
    expect(readFile).toHaveBeenCalledWith("/opt/notes/bin/server");
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("refuses a command that is not on PATH", async () => {
    expect(await refusalOf(digester({}).digest(pkg, launch))).toEqual(
      digestUnavailable("notes-server@0.3.0", "notes-server is not on this machine's PATH"),
    );
  });

  it("refuses a file it cannot read", async () => {
    const which = () => Promise.resolve<string | undefined>("/usr/local/bin/notes-server");
    const readFile = () => Promise.reject(new Error("EACCES"));
    expect(await refusalOf(digester({ which, readFile }).digest(pkg, launch))).toEqual(
      digestUnavailable("notes-server@0.3.0", "/usr/local/bin/notes-server could not be read (Error: EACCES)"),
    );
  });
});
