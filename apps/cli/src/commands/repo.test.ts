/**
 * `oxagen repo …` output-discipline tests. Mocks the shared API client so no
 * network is needed; pins the route and body each subcommand sends, `--json`
 * as the exact contract payload, the pretty table with its role, full name,
 * default ref, binding id and connection state columns, the argument checks
 * that refuse before a request leaves the process (exit 2), and API failures
 * on stderr (exit 1).
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { CommandWriter } from "../lib/capture-writer.js";

const apiMock = vi.hoisted(() => {
  /** Mirror of lib/api.js's ApiError, a real class so `instanceof` holds. */
  class ApiError extends Error {
    readonly status: number;
    constructor(message: string, status = 0) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }
  return {
    apiGetOrThrow: vi.fn(),
    apiPostOrThrow: vi.fn(),
    printTable: vi.fn(
      (
        headers: string[],
        rows: string[][],
        writer: { write(l: string): void },
      ) => {
        writer.write(headers.join(" | "));
        for (const row of rows) writer.write(row.join(" | "));
      },
    ),
    ApiError,
  };
});
vi.mock("../lib/api.js", () => apiMock);

import {
  parseRepositoryRef,
  repoLink,
  repoList,
  repoUnlink,
  type RepositoryLinkResult,
  type RepositoryListResult,
  type RepositoryUnlinkResult,
} from "./repo.js";
import { apiGetOrThrow, apiPostOrThrow } from "../lib/api.js";

function memoryWriter(): {
  writer: CommandWriter;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: {
      write: (line) => {
        out.push(line);
      },
      writeErr: (line) => {
        err.push(line);
      },
    },
    out,
    err,
  };
}

const LIST: RepositoryListResult = {
  repositories: [
    {
      bindingId: "rpb_main",
      role: "main",
      owner: "acme",
      name: "control",
      fullName: "acme/control",
      defaultRef: "main",
      htmlUrl: "https://github.com/acme/control",
      boundAt: "2026-09-18T00:00:00.000Z",
      connectionLive: true,
    },
    {
      bindingId: "rpb_linked",
      role: "linked",
      owner: "acme",
      name: "billing",
      fullName: "acme/billing",
      defaultRef: "release",
      htmlUrl: "https://github.com/acme/billing",
      boundAt: "2026-09-18T01:00:00.000Z",
      connectionLive: false,
    },
  ],
};

const LINKED: RepositoryLinkResult = {
  bindingId: "rpb_new",
  connectionId: "con_1",
  fullName: "acme/billing",
  defaultRef: "release",
  role: "linked",
  linkedAt: "2026-09-18T02:00:00.000Z",
};

const UNLINKED: RepositoryUnlinkResult = {
  bindingId: "rpb_linked",
  fullName: "acme/billing",
  unlinkedAt: "2026-09-18T03:00:00.000Z",
};

beforeEach(() => {
  process.exitCode = undefined;
  vi.clearAllMocks();
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("parseRepositoryRef", () => {
  it("splits owner/name", () => {
    expect(parseRepositoryRef("acme/billing")).toEqual({
      owner: "acme",
      name: "billing",
    });
    expect(parseRepositoryRef("  acme/billing ")).toEqual({
      owner: "acme",
      name: "billing",
    });
  });

  it("refuses anything that is not exactly owner/name", () => {
    expect(parseRepositoryRef("billing")).toBeNull();
    expect(parseRepositoryRef("acme/")).toBeNull();
    expect(parseRepositoryRef("/billing")).toBeNull();
    expect(parseRepositoryRef("a/b/c")).toBeNull();
    expect(parseRepositoryRef("")).toBeNull();
  });
});

describe("oxagen repo list", () => {
  it("GETs repositories and emits the exact payload with --json", async () => {
    (apiGetOrThrow as Mock).mockResolvedValueOnce(LIST);
    const { writer, out, err } = memoryWriter();
    await repoList({ json: true }, writer);
    expect(apiGetOrThrow).toHaveBeenCalledWith("repositories");
    expect(out).toEqual([JSON.stringify(LIST)]);
    expect(err).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints role, repository, default ref, binding id and connection state", async () => {
    (apiGetOrThrow as Mock).mockResolvedValueOnce(LIST);
    const { writer, out, err } = memoryWriter();
    await repoList({}, writer);
    expect(out[0]).toBe(
      "ROLE | REPOSITORY | DEFAULT REF | BINDING | CONNECTION",
    );
    expect(out[1]).toBe("main | acme/control | main | rpb_main | live");
    expect(out[2]).toBe(
      "linked | acme/billing | release | rpb_linked | retired",
    );
    expect(out.slice(3)).toEqual([
      "",
      "1 of 2 sit on a retired GitHub connection and do not resolve. Reconnect GitHub from the workspace's settings.",
    ]);
    expect(err).toEqual([]);
  });

  it("says so when the workspace binds nothing, and adds no retired note", async () => {
    (apiGetOrThrow as Mock).mockResolvedValueOnce({ repositories: [] });
    const { writer, out } = memoryWriter();
    await repoList({}, writer);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/No repositories are bound/);
    expect(apiMock.printTable).not.toHaveBeenCalled();
  });

  it("prints no retired note when every connection is live", async () => {
    (apiGetOrThrow as Mock).mockResolvedValueOnce({
      repositories: [LIST.repositories[0]],
    });
    const { writer, out } = memoryWriter();
    await repoList({}, writer);
    expect(out).toHaveLength(2);
  });

  it("routes an API failure to stderr and exits 1", async () => {
    (apiGetOrThrow as Mock).mockRejectedValueOnce(
      new apiMock.ApiError("forbidden", 403),
    );
    const { writer, out, err } = memoryWriter();
    await repoList({}, writer);
    expect(out).toEqual([]);
    expect(err).toEqual(["✗ forbidden"]);
    expect(process.exitCode).toBe(1);
  });

  it("emits a json error line in --json mode", async () => {
    (apiGetOrThrow as Mock).mockRejectedValueOnce(
      new apiMock.ApiError("boom", 500),
    );
    const { writer, err } = memoryWriter();
    await repoList({ json: true }, writer);
    expect(JSON.parse(err[0]!)).toEqual({
      type: "error",
      code: "api",
      message: "boom",
    });
    expect(process.exitCode).toBe(1);
  });
});

describe("oxagen repo link", () => {
  it("POSTs repository/link with provider, owner and name", async () => {
    (apiPostOrThrow as Mock).mockResolvedValueOnce(LINKED);
    const { writer, out, err } = memoryWriter();
    await repoLink("acme/billing", { json: true }, writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith("repository/link", {
      provider: "github",
      owner: "acme",
      name: "billing",
    });
    expect(out).toEqual([JSON.stringify(LINKED)]);
    expect(err).toEqual([]);
  });

  it("prints the linked repository, its default ref and binding id", async () => {
    (apiPostOrThrow as Mock).mockResolvedValueOnce(LINKED);
    const { writer, out } = memoryWriter();
    await repoLink("acme/billing", {}, writer);
    expect(out[0]).toBe("linked acme/billing · release · rpb_new");
    expect(out[1]).toMatch(/oxagen repo unlink <bindingId>/);
  });

  it("refuses a malformed reference before any request, exit 2", async () => {
    const { writer, out, err } = memoryWriter();
    await repoLink("billing", {}, writer);
    expect(apiPostOrThrow).not.toHaveBeenCalled();
    expect(out).toEqual([]);
    expect(err[0]).toBe('error: expected <owner/name>, got "billing"');
    expect(err[1]).toBe("usage: oxagen repo link <owner/name> [--json]");
    expect(process.exitCode).toBe(2);
  });

  it("routes a refusal to stderr and exits 1", async () => {
    (apiPostOrThrow as Mock).mockRejectedValueOnce(
      new apiMock.ApiError(
        "acme/billing is the main repository of another workspace",
        409,
      ),
    );
    const { writer, out, err } = memoryWriter();
    await repoLink("acme/billing", {}, writer);
    expect(out).toEqual([]);
    expect(err).toEqual([
      "✗ acme/billing is the main repository of another workspace",
    ]);
    expect(process.exitCode).toBe(1);
  });
});

describe("oxagen repo unlink", () => {
  it("POSTs repository/unlink with the binding id", async () => {
    (apiPostOrThrow as Mock).mockResolvedValueOnce(UNLINKED);
    const { writer, out, err } = memoryWriter();
    await repoUnlink("rpb_linked", { json: true }, writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith("repository/unlink", {
      bindingId: "rpb_linked",
    });
    expect(out).toEqual([JSON.stringify(UNLINKED)]);
    expect(err).toEqual([]);
  });

  it("trims the id and prints what was unlinked", async () => {
    (apiPostOrThrow as Mock).mockResolvedValueOnce(UNLINKED);
    const { writer, out } = memoryWriter();
    await repoUnlink("  rpb_linked ", {}, writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith("repository/unlink", {
      bindingId: "rpb_linked",
    });
    expect(out[0]).toBe("unlinked acme/billing · rpb_linked");
    expect(out[1]).toMatch(/binding versions stay/);
  });

  it("refuses an empty id before any request, exit 2", async () => {
    const { writer, err } = memoryWriter();
    await repoUnlink("   ", {}, writer);
    expect(apiPostOrThrow).not.toHaveBeenCalled();
    expect(err[0]).toBe("error: a binding id is required");
    expect(err[1]).toBe("usage: oxagen repo unlink <bindingId> [--json]");
    expect(process.exitCode).toBe(2);
  });

  it("routes the main-repository refusal to stderr and exits 1", async () => {
    (apiPostOrThrow as Mock).mockRejectedValueOnce(
      new apiMock.ApiError(
        "acme/control is this workspace's main repository and cannot be unlinked",
        409,
      ),
    );
    const { writer, out, err } = memoryWriter();
    await repoUnlink("rpb_main", {}, writer);
    expect(out).toEqual([]);
    expect(err[0]).toMatch(/cannot be unlinked/);
    expect(process.exitCode).toBe(1);
  });
});
