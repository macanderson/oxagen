/**
 * `oxagen agent env …` output-discipline + wiring tests (ADR-023 §4).
 *
 * Agent handles resolve to public ids (agt_…) via the agent-definition list
 * (GET); env/template slugs resolve via their list endpoints. --json emits one
 * JSON line; pretty prints a summary/table; a missing --env is a usage error
 * (exit 2, no API call); API failures route to a uniform stderr error (exit 1).
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
import type { CommandWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api.js")>();
  return { ...actual, apiPostOrThrow: vi.fn(), apiGetOrThrow: vi.fn() };
});

import {
  handleAgentEnvBind,
  handleAgentEnvUnbind,
  handleAgentEnvList,
} from "../agent-env.js";
import { apiPostOrThrow, apiGetOrThrow, ApiError } from "../../lib/api.js";

const mockPost = apiPostOrThrow as unknown as Mock;
const mockGet = apiGetOrThrow as unknown as Mock;

function makeWriter(): { writer: CommandWriter; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: {
      write: (l) => void out.push(l),
      writeErr: (l) => void err.push(l),
    },
    out,
    err,
  };
}

const AGENTS = [
  { agentId: "agt_code", slug: "coder", agentKey: "acme.default.coder" },
  { agentId: "agt_rev", slug: "reviewer", agentKey: null },
];

const BINDING = {
  id: "aeb_1",
  agentId: "agt_code",
  environmentId: "env_1",
  environmentName: "Staging",
  environmentSlug: "staging",
  sandboxTemplateId: "sbx_abc",
  sandboxTemplateName: "SWE-bench prewarmed",
  isPrimary: true,
};

let prevExit: typeof process.exitCode;

beforeEach(() => {
  prevExit = process.exitCode;
  process.exitCode = 0;
  mockPost.mockReset();
  mockGet.mockReset();
});

afterEach(() => {
  process.exitCode = prevExit;
});

describe("handleAgentEnvBind", () => {
  it("requires --env (usage error, exit 2, no API call)", async () => {
    const { writer, err } = makeWriter();
    await handleAgentEnvBind("coder", {}, writer);
    expect(err[0]).toContain("bind requires --env");
    expect(process.exitCode).toBe(2);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("resolves agent slug + env slug + template slug then binds", async () => {
    mockGet.mockResolvedValueOnce({ agents: AGENTS });
    mockPost
      .mockResolvedValueOnce({
        environments: [{ id: "env_1", slug: "staging" }],
      })
      .mockResolvedValueOnce({
        templates: [{ id: "sbx_abc", slug: "swe-bench-prewarmed" }],
      })
      .mockResolvedValueOnce({ binding: BINDING });
    const { writer, out } = makeWriter();
    await handleAgentEnvBind(
      "coder",
      { env: "staging", template: "swe-bench-prewarmed", primary: true },
      writer,
    );
    expect(mockGet).toHaveBeenCalledWith("agent/definitions");
    expect(mockPost).toHaveBeenLastCalledWith("agent/environment/bind", {
      agentId: "agt_code",
      environmentId: "env_1",
      sandboxTemplateId: "sbx_abc",
      isPrimary: true,
    });
    expect(out.join("\n")).toContain("✓ bound coder → Staging (staging)");
    expect(out.join("\n")).toContain("primary");
  });

  it("passes an agt_ id and env_ id straight through (no lookups)", async () => {
    mockPost.mockResolvedValueOnce({
      binding: { ...BINDING, sandboxTemplateName: null },
    });
    const { writer } = makeWriter();
    await handleAgentEnvBind("agt_code", { env: "env_1" }, writer);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPost).toHaveBeenCalledOnce();
    expect(mockPost).toHaveBeenCalledWith("agent/environment/bind", {
      agentId: "agt_code",
      environmentId: "env_1",
    });
  });

  it("emits a json binding on stdout in --json mode", async () => {
    mockPost.mockResolvedValueOnce({ binding: BINDING });
    const { writer, out } = makeWriter();
    await handleAgentEnvBind("agt_code", { env: "env_1", json: true }, writer);
    expect(out).toEqual([JSON.stringify(BINDING)]);
  });

  it("fails cleanly when the agent handle is unknown (exit 1)", async () => {
    mockGet.mockResolvedValueOnce({ agents: AGENTS });
    const { writer, err } = makeWriter();
    await handleAgentEnvBind("ghost", { env: "env_1" }, writer);
    expect(err[0]).toContain("No agent matching 'ghost'");
    expect(process.exitCode).toBe(1);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("matches an agent by its agent-key", async () => {
    mockGet.mockResolvedValueOnce({ agents: AGENTS });
    mockPost.mockResolvedValueOnce({ binding: BINDING });
    const { writer } = makeWriter();
    await handleAgentEnvBind("acme.default.coder", { env: "env_1" }, writer);
    expect(mockPost).toHaveBeenCalledWith("agent/environment/bind", {
      agentId: "agt_code",
      environmentId: "env_1",
    });
  });
});

describe("handleAgentEnvUnbind", () => {
  it("requires --env (usage error, exit 2)", async () => {
    const { writer, err } = makeWriter();
    await handleAgentEnvUnbind("agt_code", {}, writer);
    expect(err[0]).toContain("unbind requires --env");
    expect(process.exitCode).toBe(2);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("unbinds after resolving handles", async () => {
    mockPost
      .mockResolvedValueOnce({
        environments: [{ id: "env_1", slug: "staging" }],
      })
      .mockResolvedValueOnce({ ok: true });
    const { writer, out } = makeWriter();
    await handleAgentEnvUnbind("agt_code", { env: "staging" }, writer);
    expect(mockPost).toHaveBeenLastCalledWith("agent/environment/unbind", {
      agentId: "agt_code",
      environmentId: "env_1",
    });
    expect(out.join("\n")).toContain("✓ unbound agt_code from staging");
  });
});

describe("handleAgentEnvList", () => {
  it("lists bindings as a table in pretty mode", async () => {
    mockPost.mockResolvedValueOnce({ bindings: [BINDING] });
    const { writer, out } = makeWriter();
    await handleAgentEnvList("agt_code", {}, writer);
    expect(mockPost).toHaveBeenCalledWith("agent/environment/list", {
      agentId: "agt_code",
    });
    const text = out.join("\n");
    expect(text).toContain("Staging");
    expect(text).toContain("SWE-bench prewarmed");
    expect(text).toContain("★");
  });

  it("shows the env-default hint when no template is pinned", async () => {
    mockPost.mockResolvedValueOnce({
      bindings: [
        { ...BINDING, sandboxTemplateId: null, sandboxTemplateName: null },
      ],
    });
    const { writer, out } = makeWriter();
    await handleAgentEnvList("agt_code", {}, writer);
    expect(out.join("\n")).toContain("‹env default›");
  });

  it("emits a json array on stdout in --json mode", async () => {
    mockPost.mockResolvedValueOnce({ bindings: [BINDING] });
    const { writer, out } = makeWriter();
    await handleAgentEnvList("agt_code", { json: true }, writer);
    expect(out).toEqual([JSON.stringify([BINDING])]);
  });

  it("prints an empty-state line for no bindings", async () => {
    mockPost.mockResolvedValueOnce({ bindings: [] });
    const { writer, out } = makeWriter();
    await handleAgentEnvList("agt_code", {}, writer);
    expect(out.join("\n")).toContain("(no environment bindings)");
  });

  it("routes an API failure to a uniform stderr error (exit 1)", async () => {
    mockPost.mockRejectedValueOnce(new ApiError("nope", 403));
    const { writer, err } = makeWriter();
    await handleAgentEnvList("agt_code", {}, writer);
    expect(err[0]).toContain("✗ nope");
    expect(process.exitCode).toBe(1);
  });
});
