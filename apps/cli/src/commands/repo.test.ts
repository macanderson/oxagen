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

const fsMock = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock("node:fs/promises", () => fsMock);

import {
  draftGovernanceToml,
  parseRepositoryRef,
  repoBranch,
  repoInit,
  repoLink,
  repoList,
  repoTree,
  repoUnlink,
  type InitPrResult,
  type ProductionBranchResult,
  type RepositoryTreeResult,
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
      events: "installed",
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
      events: "retired",
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
      "ROLE | REPOSITORY | DEFAULT REF | BINDING | CONNECTION | EVENTS",
    );
    expect(out[1]).toBe(
      "main | acme/control | main | rpb_main | live | installed",
    );
    expect(out[2]).toBe(
      "linked | acme/billing | release | rpb_linked | retired | retired",
    );
    expect(out.slice(3)).toEqual([
      "",
      "1 of 2 sit on a retired GitHub connection and do not resolve. Reconnect GitHub from the Repositories page.",
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

const TREE: RepositoryTreeResult = {
  bindingId: "rpb_main",
  role: "main",
  fullName: "acme/control",
  productionBranch: "main",
  githubDefaultBranch: "trunk",
  head: "abc123",
  oxagen: {
    present: true,
    files: [".oxagen/rules/governance.toml", ".oxagen/workspace.toml"],
  },
  workspaceToml: 'schema = "oxagen-workspace/v0.1"\n',
  governanceToml: 'mode = "team"\n',
  governanceMode: "team",
  initPullRequest: null,
  readAt: "2026-09-19T00:00:00.000Z",
};

describe("oxagen repo tree", () => {
  it("POSTs repository/tree and emits the exact payload with --json", async () => {
    (apiPostOrThrow as Mock).mockResolvedValueOnce(TREE);
    const { writer, out } = memoryWriter();
    await repoTree("rpb_main", { json: true }, writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith("repository/tree", {
      bindingId: "rpb_main",
    });
    expect(out).toEqual([JSON.stringify(TREE)]);
  });

  it("prints the head, a moved GitHub default, the mode and every file", async () => {
    (apiPostOrThrow as Mock).mockResolvedValueOnce(TREE);
    const { writer, out } = memoryWriter();
    await repoTree("rpb_main", {}, writer);
    expect(out).toEqual([
      "acme/control · main · main at abc123",
      "GitHub's default branch is trunk. The production branch stays main until you change it with `oxagen repo branch`.",
      "governance mode: team",
      "  .oxagen/rules/governance.toml",
      "  .oxagen/workspace.toml",
    ]);
  });

  it("points at init when there is no tree, and at the open pull request when one waits", async () => {
    const bare = {
      ...TREE,
      githubDefaultBranch: "main",
      head: null,
      oxagen: { present: false, files: [] },
    };
    (apiPostOrThrow as Mock).mockResolvedValueOnce(bare);
    const first = memoryWriter();
    await repoTree("rpb_main", {}, first.writer);
    expect(first.out).toEqual([
      "acme/control · main · main at (branch not found)",
      "No .oxagen/ on the production branch. Add it with `oxagen repo init`.",
    ]);
    (apiPostOrThrow as Mock).mockResolvedValueOnce({
      ...bare,
      initPullRequest: {
        number: 7,
        htmlUrl: "https://github.com/acme/control/pull/7",
      },
    });
    const second = memoryWriter();
    await repoTree("rpb_main", {}, second.writer);
    expect(second.out[1]).toBe(
      "No .oxagen/ yet. The init pull request is open: https://github.com/acme/control/pull/7",
    );
  });

  it("refuses an empty id before any request, exit 2", async () => {
    const { writer, err } = memoryWriter();
    await repoTree(" ", {}, writer);
    expect(apiPostOrThrow).not.toHaveBeenCalled();
    expect(err[0]).toBe("error: a binding id is required");
    expect(process.exitCode).toBe(2);
  });

  it("routes an API failure to stderr and exits 1", async () => {
    (apiPostOrThrow as Mock).mockRejectedValueOnce(
      new apiMock.ApiError("github_not_connected", 409),
    );
    const { writer, err } = memoryWriter();
    await repoTree("rpb_main", {}, writer);
    expect(err).toEqual(["✗ github_not_connected"]);
    expect(process.exitCode).toBe(1);
  });
});

describe("oxagen repo branch", () => {
  const SET: ProductionBranchResult = {
    bindingId: "rpb_next",
    fullName: "acme/control",
    productionBranch: "release",
    previousBranch: "main",
    changed: true,
    setAt: "2026-09-19T00:00:00.000Z",
  };

  it("POSTs repository/production-branch and prints the move", async () => {
    (apiPostOrThrow as Mock).mockResolvedValueOnce(SET);
    const { writer, out } = memoryWriter();
    await repoBranch("rpb_main", " release ", {}, writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "repository/production-branch",
      { bindingId: "rpb_main", branch: "release" },
    );
    expect(out).toEqual([
      "acme/control: production branch main → release · rpb_next",
    ]);
  });

  it("says nothing was written when the branch was already the production branch", async () => {
    (apiPostOrThrow as Mock).mockResolvedValueOnce({
      ...SET,
      productionBranch: "main",
      changed: false,
    });
    const { writer, out } = memoryWriter();
    await repoBranch("rpb_main", "main", {}, writer);
    expect(out[0]).toMatch(/already main; nothing was written/);
  });

  it("emits the exact payload with --json", async () => {
    (apiPostOrThrow as Mock).mockResolvedValueOnce(SET);
    const { writer, out } = memoryWriter();
    await repoBranch("rpb_main", "release", { json: true }, writer);
    expect(out).toEqual([JSON.stringify(SET)]);
  });

  it("refuses a missing branch before any request, exit 2", async () => {
    const { writer, err } = memoryWriter();
    await repoBranch("rpb_main", "", {}, writer);
    expect(apiPostOrThrow).not.toHaveBeenCalled();
    expect(err[0]).toBe("error: a binding id and a branch are required");
    expect(process.exitCode).toBe(2);
  });

  it("routes a refusal to stderr and exits 1", async () => {
    (apiPostOrThrow as Mock).mockRejectedValueOnce(
      new apiMock.ApiError("acme/control has no branch named nope", 404),
    );
    const { writer, err } = memoryWriter();
    await repoBranch("rpb_main", "nope", {}, writer);
    expect(err).toEqual(["✗ acme/control has no branch named nope"]);
    expect(process.exitCode).toBe(1);
  });
});

describe("oxagen repo init", () => {
  const OPENED: InitPrResult = {
    bindingId: "rpb_main",
    fullName: "acme/control",
    branch: "oxagen/init",
    base: "main",
    pullRequest: {
      number: 12,
      htmlUrl: "https://github.com/acme/control/pull/12",
    },
    files: [".oxagen/workspace.toml", ".oxagen/rules/governance.toml"],
    reused: false,
    openedAt: "2026-09-19T00:00:00.000Z",
  };

  it("drafts governance.toml from the mode and POSTs repository/init-pr", async () => {
    fsMock.readFile.mockResolvedValueOnce('schema = "oxagen-workspace/v0.1"\n');
    (apiPostOrThrow as Mock).mockResolvedValueOnce(OPENED);
    const { writer, out } = memoryWriter();
    await repoInit(
      "rpb_main",
      { mode: "regulated", workspaceToml: "ws.toml" },
      writer,
    );
    expect(fsMock.readFile).toHaveBeenCalledWith("ws.toml", "utf8");
    expect(apiPostOrThrow).toHaveBeenCalledWith("repository/init-pr", {
      bindingId: "rpb_main",
      governanceMode: "regulated",
      workspaceToml: 'schema = "oxagen-workspace/v0.1"\n',
      governanceToml: draftGovernanceToml("regulated"),
    });
    expect(out).toEqual([
      "Opened https://github.com/acme/control/pull/12 on acme/control: oxagen/init → main, 2 files",
      "Nothing reaches the production branch until a person merges it.",
    ]);
  });

  it("reads governance.toml from a file when one is given, and says when a pull request was already open", async () => {
    fsMock.readFile
      .mockResolvedValueOnce("ws")
      .mockResolvedValueOnce('mode = "solo"\n');
    (apiPostOrThrow as Mock).mockResolvedValueOnce({ ...OPENED, reused: true });
    const { writer, out } = memoryWriter();
    await repoInit(
      "rpb_main",
      { mode: "solo", workspaceToml: "ws.toml", governanceToml: "gov.toml" },
      writer,
    );
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "repository/init-pr",
      expect.objectContaining({ governanceToml: 'mode = "solo"\n' }),
    );
    expect(out[0]).toMatch(/already open on acme\/control/);
  });

  it("refuses an unknown mode, a missing workspace.toml and an unreadable file before any request", async () => {
    const a = memoryWriter();
    await repoInit("rpb_main", { mode: "lax", workspaceToml: "x" }, a.writer);
    expect(a.err[0]).toMatch(/expected a mode of solo, team or regulated/);
    const b = memoryWriter();
    await repoInit("rpb_main", {}, b.writer);
    expect(b.err[0]).toBe("error: --workspace-toml is required");
    fsMock.readFile.mockRejectedValueOnce(new Error("ENOENT"));
    const c = memoryWriter();
    await repoInit("rpb_main", { workspaceToml: "missing.toml" }, c.writer);
    expect(c.err[0]).toBe("error: could not read a file: ENOENT");
    const d = memoryWriter();
    await repoInit("  ", {}, d.writer);
    expect(d.err[0]).toBe("error: a binding id is required");
    expect(apiPostOrThrow).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it("routes a refusal to stderr and exits 1", async () => {
    fsMock.readFile.mockResolvedValueOnce("ws");
    (apiPostOrThrow as Mock).mockRejectedValueOnce(
      new apiMock.ApiError("acme/control already has .oxagen/", 409),
    );
    const { writer, err } = memoryWriter();
    await repoInit("rpb_main", { workspaceToml: "ws.toml" }, writer);
    expect(err).toEqual(["✗ acme/control already has .oxagen/"]);
    expect(process.exitCode).toBe(1);
  });
});

describe("draftGovernanceToml", () => {
  it("declares the mode and turns separation of duties on only for regulated", () => {
    expect(draftGovernanceToml("team")).toContain('mode = "team"');
    expect(draftGovernanceToml("team")).toContain(
      "separation_of_duties = false",
    );
    expect(draftGovernanceToml("regulated")).toContain(
      "separation_of_duties = true",
    );
  });
});
