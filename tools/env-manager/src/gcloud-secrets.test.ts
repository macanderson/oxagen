import { describe, expect, it, vi } from "vitest";
import {
  accessValue,
  activeVersion,
  classifyGcloudFailure,
  fetchSecret,
  type GcloudRunner,
  listSecretNames,
} from "./gcloud-secrets";

/** A rejection shaped like the one promisified execFile gives on non-zero exit. */
function gcloudError(stderr: string): Error {
  return Object.assign(new Error("Command failed: gcloud"), { stderr });
}

const NOT_FOUND =
  "ERROR: (gcloud.secrets.versions.list) NOT_FOUND: Secret [projects/1/secrets/X] not found or has no versions.\n";
const PERMISSION_DENIED =
  "ERROR: (gcloud.secrets.versions.access) PERMISSION_DENIED: Permission 'secretmanager.versions.access' denied for resource 'projects/p/secrets/X/versions/3'.\n";

const VERSIONS_JSON = JSON.stringify([
  {
    name: "projects/p/secrets/X/versions/3",
    createTime: "2026-09-01T00:00:00Z",
    state: "ENABLED",
  },
]);

/** Routes `versions list` and `versions access` to separate outcomes. */
function runner(
  list: () => Promise<{ stdout: string }>,
  access: () => Promise<{ stdout: string }>,
): GcloudRunner {
  return vi.fn(async (args: string[]) =>
    args[2] === "access" ? access() : list(),
  );
}

describe("classifyGcloudFailure", () => {
  it("maps NOT_FOUND stderr to not_found", () => {
    expect(classifyGcloudFailure(gcloudError(NOT_FOUND))).toEqual({
      ok: false,
      reason: "not_found",
      message: NOT_FOUND.trim(),
    });
  });

  it("maps PERMISSION_DENIED stderr to error", () => {
    const r = classifyGcloudFailure(gcloudError(PERMISSION_DENIED));
    expect(r.reason).toBe("error");
    expect(r.message).toContain("PERMISSION_DENIED");
  });

  it("treats a failure with no stderr, such as a missing gcloud binary, as error", () => {
    const r = classifyGcloudFailure(new Error("spawn gcloud ENOENT"));
    expect(r).toEqual({
      ok: false,
      reason: "error",
      message: "spawn gcloud ENOENT",
    });
  });

  it("reads stderr delivered as a Buffer and keeps its first non-empty line", () => {
    const err = Object.assign(new Error("x"), {
      stderr: Buffer.from("\nERROR: UNAUTHENTICATED: reauth\nmore detail\n"),
    });
    expect(classifyGcloudFailure(err)).toEqual({
      ok: false,
      reason: "error",
      message: "ERROR: UNAUTHENTICATED: reauth",
    });
  });
});

describe("activeVersion", () => {
  it("returns the newest enabled version", async () => {
    const run = runner(
      async () => ({ stdout: VERSIONS_JSON }),
      async () => ({ stdout: "" }),
    );
    expect(await activeVersion("X", "p", run)).toEqual({
      ok: true,
      value: { version: "3", createTime: "2026-09-01T00:00:00Z" },
    });
    expect(run).toHaveBeenCalledWith(
      expect.arrayContaining(["versions", "list", "X", "--project", "p"]),
    );
  });

  it("reports not_found when no version is enabled", async () => {
    const run = runner(
      async () => ({ stdout: "[]" }),
      async () => ({ stdout: "" }),
    );
    expect(await activeVersion("X", "p", run)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("reports a permission failure as error, not as an absent secret", async () => {
    const run = runner(
      async () => {
        throw gcloudError(PERMISSION_DENIED);
      },
      async () => ({ stdout: "" }),
    );
    expect(await activeVersion("X", "p", run)).toMatchObject({
      ok: false,
      reason: "error",
    });
  });
});

describe("accessValue", () => {
  it("returns stdout as the value", async () => {
    const run = runner(
      async () => ({ stdout: "[]" }),
      async () => ({ stdout: "s3cret" }),
    );
    expect(await accessValue("X", "3", "p", run)).toEqual({
      ok: true,
      value: "s3cret",
    });
  });

  it("maps NOT_FOUND to not_found and PERMISSION_DENIED to error", async () => {
    const notFound = runner(
      async () => ({ stdout: "[]" }),
      async () => {
        throw gcloudError(NOT_FOUND);
      },
    );
    const denied = runner(
      async () => ({ stdout: "[]" }),
      async () => {
        throw gcloudError(PERMISSION_DENIED);
      },
    );
    expect(await accessValue("X", "3", "p", notFound)).toMatchObject({
      reason: "not_found",
    });
    expect(await accessValue("X", "3", "p", denied)).toMatchObject({
      reason: "error",
    });
  });
});

describe("fetchSecret", () => {
  it("returns the active version and value", async () => {
    const run = runner(
      async () => ({ stdout: VERSIONS_JSON }),
      async () => ({ stdout: "s3cret" }),
    );
    expect(await fetchSecret("X", "p", run)).toEqual({
      ok: true,
      active: { version: "3", createTime: "2026-09-01T00:00:00Z" },
      value: "s3cret",
    });
  });

  it("records a NOT_FOUND secret as missing", async () => {
    const run = runner(
      async () => {
        throw gcloudError(NOT_FOUND);
      },
      async () => ({ stdout: "" }),
    );
    expect(await fetchSecret("X", "p", run)).toEqual({
      ok: true,
      active: null,
      value: null,
    });
  });

  it("keeps the version when only the value is NOT_FOUND", async () => {
    const run = runner(
      async () => ({ stdout: VERSIONS_JSON }),
      async () => {
        throw gcloudError(NOT_FOUND);
      },
    );
    expect(await fetchSecret("X", "p", run)).toEqual({
      ok: true,
      active: { version: "3", createTime: "2026-09-01T00:00:00Z" },
      value: null,
    });
  });

  it("reports PERMISSION_DENIED on list instead of recording the secret as missing", async () => {
    const run = runner(
      async () => {
        throw gcloudError(PERMISSION_DENIED);
      },
      async () => ({ stdout: "" }),
    );
    const r = await fetchSecret("X", "p", run);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/^versions list: .*PERMISSION_DENIED/);
  });

  it("reports PERMISSION_DENIED on access instead of recording the secret as missing", async () => {
    const run = runner(
      async () => ({ stdout: VERSIONS_JSON }),
      async () => {
        throw gcloudError(PERMISSION_DENIED);
      },
    );
    const r = await fetchSecret("X", "p", run);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.message).toMatch(/^versions access: .*PERMISSION_DENIED/);
  });
});

describe("listSecretNames", () => {
  it("returns sorted short names", async () => {
    const run: GcloudRunner = async () => ({
      stdout: JSON.stringify([
        { name: "projects/p/secrets/b" },
        { name: "projects/p/secrets/a" },
      ]),
    });
    expect(await listSecretNames("p", run)).toEqual(["a", "b"]);
  });

  it("throws when gcloud fails, so the pull stops", async () => {
    const run: GcloudRunner = async () => {
      throw gcloudError(PERMISSION_DENIED);
    };
    await expect(listSecretNames("p", run)).rejects.toThrow();
  });
});
