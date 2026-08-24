/**
 * `oxagen env …` handlers — pins each subcommand's wire call (route + exact
 * body through the apiPost seam, always carrying the caller's writer), the
 * slug-vs-id resolution seam, slug derivation from the environment name, and
 * the human/JSON output written through the CommandWriter.
 */
import { describe, expect, it, vi } from "vitest";

const { apiPost, printTable, resolveEnvironmentId } = vi.hoisted(() => ({
  apiPost: vi.fn<(path: string, body: unknown, writer?: unknown) => Promise<unknown>>(),
  printTable: vi.fn(),
  resolveEnvironmentId: vi.fn<(slugOrId: string) => Promise<string>>(),
}));

vi.mock("../lib/api.js", () => ({ apiPost, printTable }));
vi.mock("../lib/resolve.js", () => ({ resolveEnvironmentId }));

import { captureWriter } from "../lib/capture-writer";
import {
  handleEnvList,
  handleEnvGet,
  handleEnvCreate,
  handleEnvUpdate,
  handleEnvRemove,
  handleEnvSetDefault,
} from "./env";

const prod = {
  id: "env_1",
  name: "Production",
  slug: "prod",
  description: "live",
  isDefault: true,
  isActive: true,
};
const staging = {
  id: "env_2",
  name: "Staging",
  slug: "staging",
  description: null,
  isDefault: false,
  isActive: false,
};

describe("env list", () => {
  it("renders a table row per environment — default star, active yes/no", async () => {
    apiPost.mockResolvedValue({ environments: [prod, staging] });
    const captured = captureWriter();
    await handleEnvList({}, captured.writer);
    expect(apiPost).toHaveBeenCalledWith("environment/list", {}, captured.writer);
    expect(printTable).toHaveBeenCalledWith(
      ["NAME", "SLUG", "DEFAULT", "ACTIVE", "ID"],
      [
        ["Production", "prod", "★", "yes", "env_1"],
        ["Staging", "staging", "", "no", "env_2"],
      ],
      captured.writer,
    );
  });

  it("--json emits the raw summaries and skips the table", async () => {
    apiPost.mockResolvedValue({ environments: [prod, staging] });
    const captured = captureWriter();
    await handleEnvList({ json: true }, captured.writer);
    expect(JSON.parse(captured.output())).toEqual([prod, staging]);
    expect(printTable).not.toHaveBeenCalled();
  });
});

describe("env get", () => {
  it("resolves the slug to an id and prints the environment as JSON", async () => {
    resolveEnvironmentId.mockResolvedValue("env_1");
    apiPost.mockResolvedValue({ environment: prod });
    const captured = captureWriter();
    await handleEnvGet("prod", {}, captured.writer);
    expect(resolveEnvironmentId).toHaveBeenCalledWith("prod");
    expect(apiPost).toHaveBeenCalledWith("environment/get", { environmentId: "env_1" }, captured.writer);
    expect(JSON.parse(captured.output())).toEqual(prod);
  });
});

describe("env create", () => {
  it("sends an explicit slug and description verbatim", async () => {
    apiPost.mockResolvedValue({ environment: prod });
    const captured = captureWriter();
    await handleEnvCreate("Production", { slug: "prod", description: "live" }, captured.writer);
    expect(apiPost).toHaveBeenCalledWith(
      "environment/create",
      { name: "Production", slug: "prod", description: "live" },
      captured.writer,
    );
    expect(captured.output()).toBe("✓ created environment Production (prod) env_1");
  });

  it("derives the slug from the name (lowercase, runs of non-alphanumerics to dashes, trimmed)", async () => {
    apiPost.mockResolvedValue({
      environment: { ...staging, name: "QA / Load 2", slug: "qa-load-2" },
    });
    const captured = captureWriter();
    await handleEnvCreate("  QA / Load 2! ", {}, captured.writer);
    expect(apiPost).toHaveBeenCalledWith(
      "environment/create",
      { name: "  QA / Load 2! ", slug: "qa-load-2", description: null },
      captured.writer,
    );
    expect(captured.output()).toBe("✓ created environment QA / Load 2 (qa-load-2) env_2");
  });
});

describe("env update", () => {
  it("resolves the target and forwards every provided field, mapping active to isActive", async () => {
    resolveEnvironmentId.mockResolvedValue("env_2");
    apiPost.mockResolvedValue({ environment: { ...staging, name: "Stage", slug: "stage" } });
    const captured = captureWriter();
    await handleEnvUpdate(
      "staging",
      { name: "Stage", slug: "stage", description: "pre-prod", active: false },
      captured.writer,
    );
    expect(resolveEnvironmentId).toHaveBeenCalledWith("staging");
    expect(apiPost).toHaveBeenCalledWith(
      "environment/update",
      {
        environmentId: "env_2",
        name: "Stage",
        slug: "stage",
        description: "pre-prod",
        isActive: false,
      },
      captured.writer,
    );
    expect(captured.output()).toBe("✓ updated environment Stage (stage)");
  });

  it("leaves omitted fields undefined so the API treats them as no-change", async () => {
    resolveEnvironmentId.mockResolvedValue("env_2");
    apiPost.mockResolvedValue({ environment: staging });
    const captured = captureWriter();
    await handleEnvUpdate("env_2", {}, captured.writer);
    expect(apiPost).toHaveBeenCalledWith(
      "environment/update",
      {
        environmentId: "env_2",
        name: undefined,
        slug: undefined,
        description: undefined,
        isActive: undefined,
      },
      captured.writer,
    );
  });
});

describe("env remove", () => {
  it("deletes the resolved environment and echoes the handle the user typed", async () => {
    resolveEnvironmentId.mockResolvedValue("env_2");
    apiPost.mockResolvedValue({ ok: true });
    const captured = captureWriter();
    await handleEnvRemove("staging", captured.writer);
    expect(apiPost).toHaveBeenCalledWith(
      "environment/delete",
      { environmentId: "env_2" },
      captured.writer,
    );
    expect(captured.output()).toBe("✓ removed environment staging");
  });
});

describe("env set-default", () => {
  it("promotes the resolved environment and reports the server's name and slug", async () => {
    resolveEnvironmentId.mockResolvedValue("env_1");
    apiPost.mockResolvedValue({ environment: prod });
    const captured = captureWriter();
    await handleEnvSetDefault("prod", captured.writer);
    expect(apiPost).toHaveBeenCalledWith(
      "environment/set-default",
      { environmentId: "env_1" },
      captured.writer,
    );
    expect(captured.output()).toBe("✓ default environment: Production (prod)");
  });
});
