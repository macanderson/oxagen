/**
 * `oxagen sandbox template …` output-discipline + wiring tests (ADR-023 §4).
 *
 * --json emits one single-line JSON value on stdout; pretty prints a summary or
 * table; usage errors (bad flags, missing required, bad JSON) exit 2 with NO
 * API call; API failures route to a uniform stderr error (exit 1). Slug handles
 * resolve to public ids via the list endpoints; `import` never writes without
 * `--yes` (preview-then-commit, like `oxagen secret import`).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CommandWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api.js")>();
  return { ...actual, apiPostOrThrow: vi.fn(), apiGetOrThrow: vi.fn() };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, readFileSync: vi.fn(), writeFileSync: vi.fn() };
});

import {
  handleTemplateList,
  handleTemplateGet,
  handleTemplateCreate,
  handleTemplateRemove,
  handleTemplateSetDefault,
  handleTemplateExport,
  handleTemplateImport,
} from "../sandbox-template.js";
import { apiPostOrThrow, ApiError } from "../../lib/api.js";
import { readFileSync, writeFileSync } from "fs";

const mockPost = apiPostOrThrow as unknown as Mock;
const mockRead = readFileSync as unknown as Mock;
const mockWrite = writeFileSync as unknown as Mock;

function makeWriter(): { writer: CommandWriter; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: { write: (l) => void out.push(l), writeErr: (l) => void err.push(l) },
    out,
    err,
  };
}

const TEMPLATE = {
  id: "sbx_abc",
  environmentId: "env_1",
  name: "SWE-bench prewarmed",
  slug: "swe-bench-prewarmed",
  description: "Pre-optimized eval sandbox",
  isDefault: true,
  isActive: true,
  provider: "modal",
  runtime: "ghcr.io/acme/img@sha256:deadbeef",
  resources: { vcpu: 2, memoryMb: 4096 },
  network: { mode: "public" },
  secretSelection: "all" as const,
  literalEnv: { SWEBENCH_SPLIT: "verified" },
  tools: [{ id: "sbt_1", kind: "capability" as const, ref: "agent.code.execute", config: {} }],
};

let prevExit: typeof process.exitCode;

beforeEach(() => {
  prevExit = process.exitCode;
  process.exitCode = 0;
  mockPost.mockReset();
  mockRead.mockReset();
  mockWrite.mockReset();
});

afterEach(() => {
  process.exitCode = prevExit;
});

describe("handleTemplateList", () => {
  it("emits one single-line JSON array on stdout in --json mode", async () => {
    mockPost.mockResolvedValueOnce({ templates: [TEMPLATE] });
    const { writer, out, err } = makeWriter();
    await handleTemplateList({ json: true }, writer);
    expect(out).toEqual([JSON.stringify([TEMPLATE])]);
    expect(err).toEqual([]);
    expect(mockPost).toHaveBeenCalledWith("sandbox/template/list", {});
  });

  it("renders a table with the template name in pretty mode", async () => {
    mockPost.mockResolvedValueOnce({ templates: [TEMPLATE] });
    const { writer, out } = makeWriter();
    await handleTemplateList({}, writer);
    expect(out.join("\n")).toContain("swe-bench-prewarmed");
    expect(out.join("\n")).toContain("★");
  });

  it("resolves --env slug to an env id and filters the list", async () => {
    mockPost
      .mockResolvedValueOnce({ environments: [{ id: "env_9", slug: "staging" }] })
      .mockResolvedValueOnce({ templates: [] });
    const { writer, out } = makeWriter();
    await handleTemplateList({ env: "staging" }, writer);
    expect(mockPost).toHaveBeenNthCalledWith(1, "environment/list", {});
    expect(mockPost).toHaveBeenNthCalledWith(2, "sandbox/template/list", { environmentId: "env_9" });
    expect(out.join("\n")).toContain("(no templates)");
  });

  it("routes an API failure to a uniform stderr error (exit 1)", async () => {
    mockPost.mockRejectedValueOnce(new ApiError("boom", 500));
    const { writer, out, err } = makeWriter();
    await handleTemplateList({}, writer);
    expect(out).toEqual([]);
    expect(err[0]).toContain("✗ boom");
    expect(process.exitCode).toBe(1);
  });
});

describe("handleTemplateGet", () => {
  it("passes a sbx_ id straight through (no list lookup)", async () => {
    mockPost.mockResolvedValueOnce({ template: TEMPLATE });
    const { writer } = makeWriter();
    await handleTemplateGet("sbx_abc", { json: true }, writer);
    expect(mockPost).toHaveBeenCalledOnce();
    expect(mockPost).toHaveBeenCalledWith("sandbox/template/get", { templateId: "sbx_abc" });
  });

  it("resolves a slug to its id via the list endpoint", async () => {
    mockPost
      .mockResolvedValueOnce({ templates: [TEMPLATE] })
      .mockResolvedValueOnce({ template: TEMPLATE });
    const { writer, out } = makeWriter();
    await handleTemplateGet("swe-bench-prewarmed", {}, writer);
    expect(mockPost).toHaveBeenNthCalledWith(1, "sandbox/template/list", {});
    expect(mockPost).toHaveBeenNthCalledWith(2, "sandbox/template/get", { templateId: "sbx_abc" });
    expect(out.join("\n")).toContain("SWE-bench prewarmed");
    expect(out.join("\n")).toContain("★ default");
  });

  it("fails cleanly when the slug is unknown (exit 1, no get call)", async () => {
    mockPost.mockResolvedValueOnce({ templates: [] });
    const { writer, err } = makeWriter();
    await handleTemplateGet("ghost", {}, writer);
    expect(err[0]).toContain("No sandbox template with slug 'ghost'");
    expect(process.exitCode).toBe(1);
    expect(mockPost).toHaveBeenCalledOnce();
  });
});

describe("handleTemplateCreate", () => {
  it("rejects missing --name as a usage error (exit 2, no API call)", async () => {
    const { writer, err } = makeWriter();
    await handleTemplateCreate({ env: "staging", slug: "x" }, writer);
    expect(err[0]).toContain("requires --name");
    expect(process.exitCode).toBe(2);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("rejects an invalid --provider (exit 2, no API call)", async () => {
    const { writer, err } = makeWriter();
    await handleTemplateCreate({ env: "s", name: "n", slug: "x", provider: "aws" }, writer);
    expect(err[0]).toContain('Invalid --provider "aws"');
    expect(process.exitCode).toBe(2);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("rejects an invalid --network-mode (exit 2, no API call)", async () => {
    const { writer, err } = makeWriter();
    await handleTemplateCreate({ env: "s", name: "n", slug: "x", networkMode: "vpc" }, writer);
    expect(err[0]).toContain('Invalid --network-mode "vpc"');
    expect(process.exitCode).toBe(2);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("rejects a non-integer --vcpu (exit 2, no API call)", async () => {
    const { writer, err } = makeWriter();
    await handleTemplateCreate({ env: "s", name: "n", slug: "x", vcpu: "2.5" }, writer);
    expect(err[0]).toContain('Invalid --vcpu "2.5"');
    expect(process.exitCode).toBe(2);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("rejects a malformed --env-var (exit 2, no API call)", async () => {
    const { writer, err } = makeWriter();
    await handleTemplateCreate({ env: "s", name: "n", slug: "x", envVar: ["NOEQUALS"] }, writer);
    expect(err[0]).toContain('Invalid --env-var "NOEQUALS"');
    expect(process.exitCode).toBe(2);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("assembles the create body from flags (resources, network, literalEnv, default)", async () => {
    mockPost
      .mockResolvedValueOnce({ environments: [{ id: "env_7", slug: "staging" }] })
      .mockResolvedValueOnce({ template: TEMPLATE });
    const { writer, out } = makeWriter();
    await handleTemplateCreate(
      {
        env: "staging",
        name: "SWE-bench prewarmed",
        slug: "swe-bench-prewarmed",
        provider: "modal",
        runtime: "ghcr.io/acme/img@sha256:deadbeef",
        vcpu: "2",
        memoryMb: "4096",
        networkMode: "public",
        envVar: ["SWEBENCH_SPLIT=verified", "TZ=UTC"],
        setDefault: true,
      },
      writer,
    );
    expect(mockPost).toHaveBeenNthCalledWith(2, "sandbox/template/create", {
      environmentId: "env_7",
      name: "SWE-bench prewarmed",
      slug: "swe-bench-prewarmed",
      provider: "modal",
      runtime: "ghcr.io/acme/img@sha256:deadbeef",
      resources: { vcpu: 2, memoryMb: 4096 },
      network: { mode: "public" },
      literalEnv: { SWEBENCH_SPLIT: "verified", TZ: "UTC" },
      setAsDefault: true,
    });
    expect(out.join("\n")).toContain("✓ created template");
  });
});

describe("handleTemplateRemove", () => {
  it("previews without --yes and makes no API call", async () => {
    const { writer, out, err } = makeWriter();
    await handleTemplateRemove("swe-bench-prewarmed", {}, writer);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("Rerun with --yes");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("soft-deletes on --yes after resolving the slug", async () => {
    mockPost
      .mockResolvedValueOnce({ templates: [TEMPLATE] })
      .mockResolvedValueOnce({ ok: true });
    const { writer, out } = makeWriter();
    await handleTemplateRemove("swe-bench-prewarmed", { yes: true }, writer);
    expect(mockPost).toHaveBeenNthCalledWith(2, "sandbox/template/delete", { templateId: "sbx_abc" });
    expect(out.join("\n")).toContain("✓ removed template");
  });
});

describe("handleTemplateSetDefault", () => {
  it("promotes a template to default", async () => {
    mockPost.mockResolvedValueOnce({ template: TEMPLATE });
    const { writer, out } = makeWriter();
    await handleTemplateSetDefault("sbx_abc", {}, writer);
    expect(mockPost).toHaveBeenCalledWith("sandbox/template/set-default", { templateId: "sbx_abc" });
    expect(out.join("\n")).toContain("✓ default template:");
  });
});

describe("handleTemplateExport", () => {
  const MANIFEST = {
    kind: "oxagen.sandbox-template",
    version: 1,
    name: "SWE-bench prewarmed",
    slug: "swe-bench-prewarmed",
    provider: "modal",
    tools: [],
    secretKeys: [],
  };

  it("prints the manifest to stdout by default", async () => {
    mockPost.mockResolvedValueOnce({ manifest: MANIFEST });
    const { writer, out } = makeWriter();
    await handleTemplateExport("sbx_abc", {}, writer);
    expect(out.join("\n")).toContain('"kind": "oxagen.sandbox-template"');
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("writes to a file with -o and reports it on stderr", async () => {
    mockPost.mockResolvedValueOnce({ manifest: MANIFEST });
    const { writer, err } = makeWriter();
    await handleTemplateExport("sbx_abc", { out: "m.json" }, writer);
    expect(mockWrite).toHaveBeenCalledWith("m.json", expect.stringContaining("oxagen.sandbox-template"), "utf8");
    expect(err.join("\n")).toContain("✓ wrote manifest to m.json");
  });
});

describe("handleTemplateImport", () => {
  const MANIFEST = {
    kind: "oxagen.sandbox-template",
    version: 1,
    name: "SWE-bench prewarmed",
    slug: "swe-bench-prewarmed",
    provider: "modal",
    tools: [{ kind: "capability", ref: "agent.code.execute" }],
    secretKeys: [{ key: "EVAL_API_KEY", required: true, sensitive: true }],
  };

  it("requires --env (usage error, exit 2, no read/API call)", async () => {
    const { writer, err } = makeWriter();
    await handleTemplateImport({ file: "m.json" }, writer);
    expect(err[0]).toContain("import requires --env");
    expect(process.exitCode).toBe(2);
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("previews without --yes: no API call, flags required secret keys", async () => {
    mockRead.mockReturnValueOnce(JSON.stringify(MANIFEST));
    const { writer, out } = makeWriter();
    await handleTemplateImport({ env: "staging", file: "m.json" }, writer);
    expect(mockPost).not.toHaveBeenCalled();
    const text = out.join("\n");
    expect(text).toContain("preview");
    expect(text).toContain("capability:agent.code.execute");
    expect(text).toContain("EVAL_API_KEY");
    expect(text).toContain("rerun with --yes");
  });

  it("warns on an unexpected manifest kind in the preview", async () => {
    mockRead.mockReturnValueOnce(JSON.stringify({ ...MANIFEST, kind: "wrong" }));
    const { writer, out } = makeWriter();
    await handleTemplateImport({ env: "staging", file: "m.json" }, writer);
    expect(out.join("\n")).toContain("unexpected manifest kind 'wrong'");
  });

  it("rejects invalid JSON as a usage error (exit 2, no API call)", async () => {
    mockRead.mockReturnValueOnce("{ not json");
    const { writer, err } = makeWriter();
    await handleTemplateImport({ env: "staging", file: "m.json" }, writer);
    expect(err[0]).toContain("not valid JSON");
    expect(process.exitCode).toBe(2);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("writes on --yes and surfaces server warnings", async () => {
    mockRead.mockReturnValueOnce(JSON.stringify(MANIFEST));
    mockPost
      .mockResolvedValueOnce({ environments: [{ id: "env_5", slug: "staging" }] })
      .mockResolvedValueOnce({
        template: { ...TEMPLATE, isDefault: false },
        warnings: ["tool ref 'swe-bench' is not installed — it will be skipped at provision time"],
      });
    const { writer, out } = makeWriter();
    await handleTemplateImport({ env: "staging", file: "m.json", yes: true, slug: "swe-2" }, writer);
    expect(mockPost).toHaveBeenNthCalledWith(2, "sandbox/template/import", {
      environmentId: "env_5",
      manifest: MANIFEST,
      slug: "swe-2",
    });
    const text = out.join("\n");
    expect(text).toContain("✓ imported template");
    expect(text).toContain("⚠ tool ref 'swe-bench' is not installed");
  });
});
