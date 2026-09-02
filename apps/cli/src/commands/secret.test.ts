/**
 * `oxagen secret …` handlers — pins the wire contract of every subcommand:
 * which API routes are hit with which exact bodies (through the apiPost seam),
 * how slugs/key names become ids (through the resolve seam), what lands on
 * stdout vs stderr (values on stdout, audit warnings on stderr), and the
 * file-vs-stdin input and file-vs-stdout output branches of import/export.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const {
  apiPost,
  printTable,
  resolveEnvironmentId,
  resolveSecretKeyId,
  readFileSync,
  writeFileSync,
} = vi.hoisted(() => ({
  apiPost: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  printTable: vi.fn(),
  resolveEnvironmentId: vi.fn<(slugOrId: string) => Promise<string>>(),
  resolveSecretKeyId: vi.fn<(nameOrId: string) => Promise<string>>(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("../lib/api.js", () => ({ apiPost, printTable }));
vi.mock("../lib/resolve.js", () => ({
  resolveEnvironmentId,
  resolveSecretKeyId,
}));
vi.mock("fs", () => ({ readFileSync, writeFileSync }));

import {
  handleSecretList,
  handleSecretSet,
  handleSecretRemove,
  handleSecretReveal,
  handleSecretImport,
  handleSecretExport,
} from "./secret";

let out: string[];
let errOut: string[];

beforeEach(() => {
  out = [];
  errOut = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errOut.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("secret list", () => {
  const keys = [
    {
      id: "sk_1",
      key: "API_KEY",
      sensitive: true,
      memo: null,
      hasDefault: true,
      overrideEnvironmentIds: ["env_1", "env_2"],
    },
    {
      id: "sk_2",
      key: "PUBLIC_URL",
      sensitive: false,
      memo: "not secret",
      hasDefault: false,
      overrideEnvironmentIds: [],
    },
  ];

  it("renders a table row per key — sensitivity dots, default marker, override count, empty memo", async () => {
    apiPost.mockResolvedValue({ keys });
    await handleSecretList({});
    expect(apiPost).toHaveBeenCalledWith("secret/key/list", {});
    expect(printTable).toHaveBeenCalledWith(
      ["KEY", "SENS", "DEFAULT", "OVERRIDES", "MEMO"],
      [
        ["API_KEY", "●", "yes", "2", ""],
        ["PUBLIC_URL", "○", "—", "0", "not secret"],
      ],
    );
  });

  it("--json emits the raw key summaries and skips the table", async () => {
    apiPost.mockResolvedValue({ keys });
    await handleSecretList({ json: true });
    expect(JSON.parse(out.join(""))).toEqual(keys);
    expect(printTable).not.toHaveBeenCalled();
  });
});

describe("secret set", () => {
  it("without --env upserts the key with the value as default (sensitive by default)", async () => {
    apiPost.mockResolvedValue({ id: "sk_1" });
    await handleSecretSet("API_KEY", "v1", {});
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith("secret/key/upsert", {
      key: "API_KEY",
      sensitive: true,
      defaultValue: "v1",
    });
    expect(resolveSecretKeyId).not.toHaveBeenCalled();
    expect(out.join("")).toBe(
      "✓ key API_KEY (sensitive) · default value set\n",
    );
  });

  it("with --env upserts the key without a default, then sets an override on the resolved ids", async () => {
    apiPost.mockImplementation(async (path) =>
      path === "secret/key/upsert" ? { id: "sk_9" } : { ok: true },
    );
    resolveSecretKeyId.mockResolvedValue("sk_9");
    resolveEnvironmentId.mockResolvedValue("env_7");
    await handleSecretSet("API_KEY", "v2", { env: "prod", sensitive: false });
    expect(apiPost).toHaveBeenNthCalledWith(1, "secret/key/upsert", {
      key: "API_KEY",
      sensitive: false,
    });
    expect(resolveSecretKeyId).toHaveBeenCalledWith("API_KEY");
    expect(resolveEnvironmentId).toHaveBeenCalledWith("prod");
    expect(apiPost).toHaveBeenNthCalledWith(2, "secret/value/set", {
      keyId: "sk_9",
      environmentId: "env_7",
      value: "v2",
    });
    expect(out.join("")).toBe(
      "✓ key API_KEY (plain) · override set for prod\n",
    );
  });
});

describe("secret remove", () => {
  it("without --env deletes the whole key", async () => {
    apiPost.mockResolvedValue({ ok: true });
    resolveSecretKeyId.mockResolvedValue("sk_3");
    await handleSecretRemove("OLD_KEY", {});
    expect(apiPost).toHaveBeenCalledWith("secret/key/delete", {
      keyId: "sk_3",
    });
    expect(out.join("")).toBe("✓ removed key OLD_KEY\n");
  });

  it("with --env unsets only that environment's override", async () => {
    apiPost.mockResolvedValue({ ok: true });
    resolveSecretKeyId.mockResolvedValue("sk_3");
    resolveEnvironmentId.mockResolvedValue("env_5");
    await handleSecretRemove("OLD_KEY", { env: "staging" });
    expect(apiPost).toHaveBeenCalledWith("secret/value/unset", {
      keyId: "sk_3",
      environmentId: "env_5",
    });
    expect(out.join("")).toBe("✓ removed override of OLD_KEY for staging\n");
  });
});

describe("secret reveal", () => {
  it("prints the value on stdout and the access-recorded warning on stderr", async () => {
    apiPost.mockResolvedValue({
      key: "API_KEY",
      value: "s3cret",
      source: "default",
    });
    resolveSecretKeyId.mockResolvedValue("sk_1");
    await handleSecretReveal("API_KEY", {});
    expect(apiPost).toHaveBeenCalledWith("secret/reveal", {
      keyId: "sk_1",
      environmentId: null,
    });
    expect(out.join("")).toBe("s3cret\n");
    expect(errOut.join("")).toBe("⚠ access recorded (actor, time)\n");
  });

  it("with --env resolves the environment; an unset value renders ‹unset› plus the explanation", async () => {
    apiPost.mockResolvedValue({ key: "API_KEY", value: null, source: "unset" });
    resolveSecretKeyId.mockResolvedValue("sk_1");
    resolveEnvironmentId.mockResolvedValue("env_2");
    await handleSecretReveal("API_KEY", { env: "prod" });
    expect(apiPost).toHaveBeenCalledWith("secret/reveal", {
      keyId: "sk_1",
      environmentId: "env_2",
    });
    expect(out.join("")).toBe("‹unset›\n");
    expect(errOut.join("")).toBe(
      "⚠ access recorded (actor, time)\n(no override and no default)\n",
    );
  });
});

describe("secret import", () => {
  const rows = [
    {
      key: "NEW_KEY",
      isNewKey: true,
      sensitive: true,
      target: "default",
      willOverride: false,
    },
    {
      key: "OVERRIDDEN",
      isNewKey: false,
      sensitive: false,
      target: "override",
      willOverride: true,
    },
    {
      key: "PLAIN_SET",
      isNewKey: false,
      sensitive: true,
      target: "default",
      willOverride: false,
    },
  ];

  it("--file previews without commit, counts new vs existing, and points at --yes", async () => {
    readFileSync.mockReturnValue("NEW_KEY=1\nOVERRIDDEN=2\nPLAIN_SET=3\n");
    apiPost.mockResolvedValue({ rows, committed: false });
    await handleSecretImport({ file: ".env.local" });
    expect(readFileSync).toHaveBeenCalledWith(".env.local", "utf8");
    expect(apiPost).toHaveBeenCalledWith("secret/import-env", {
      text: "NEW_KEY=1\nOVERRIDDEN=2\nPLAIN_SET=3\n",
      environmentId: null,
      commit: false,
    });
    expect(out.join("")).toContain("preview — 3 parsed (1 new, 2 existing):");
    expect(out.join("")).toContain("rerun with --yes to apply");
    expect(printTable).toHaveBeenCalledWith(
      ["", "KEY", "TARGET", "SENS", "STATE"],
      [
        ["+", "NEW_KEY", "default", "●", "new"],
        ["~", "OVERRIDDEN", "override", "○", "override"],
        ["~", "PLAIN_SET", "default", "●", "set"],
      ],
    );
  });

  it("--yes with --env reads stdin, commits against the resolved environment, and drops the rerun hint", async () => {
    async function* stdin() {
      yield Buffer.from("NEW_");
      yield Buffer.from("KEY=1\n");
    }
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      stdin() as unknown as typeof process.stdin,
    );
    resolveEnvironmentId.mockResolvedValue("env_4");
    apiPost.mockResolvedValue({ rows: [rows[0]], committed: true });
    await handleSecretImport({ env: "prod", yes: true });
    expect(readFileSync).not.toHaveBeenCalled();
    expect(apiPost).toHaveBeenCalledWith("secret/import-env", {
      text: "NEW_KEY=1\n",
      environmentId: "env_4",
      commit: true,
    });
    expect(out.join("")).toContain("imported — 1 parsed (1 new, 0 existing):");
    expect(out.join("")).not.toContain("rerun with --yes");
  });
});

describe("secret export", () => {
  const payload = { dotenv: "A=1\nB=2\n", env: [{ key: "A" }, { key: "B" }] };

  it("streams the dotenv text to stdout and warns on stderr", async () => {
    apiPost.mockResolvedValue(payload);
    await handleSecretExport({});
    expect(apiPost).toHaveBeenCalledWith("secret/export", {
      environmentId: null,
    });
    expect(out.join("")).toBe("A=1\nB=2\n");
    expect(errOut.join("")).toBe("⚠ access recorded (actor, time)\n");
  });

  it("--out with --env writes the file instead and reports the key count", async () => {
    apiPost.mockResolvedValue(payload);
    resolveEnvironmentId.mockResolvedValue("env_9");
    await handleSecretExport({ env: "prod", out: ".env.prod" });
    expect(apiPost).toHaveBeenCalledWith("secret/export", {
      environmentId: "env_9",
    });
    expect(writeFileSync).toHaveBeenCalledWith(
      ".env.prod",
      "A=1\nB=2\n",
      "utf8",
    );
    expect(out.join("")).toBe("✓ wrote 2 key(s) to .env.prod\n");
  });
});
