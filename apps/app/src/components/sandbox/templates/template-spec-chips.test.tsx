// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  TemplateSpecChips,
  templateResourceSummary,
  templateSecretSummary,
} from "./template-spec-chips";
import type { SandboxTemplateSummary } from "@/app/[orgSlug]/[workspaceSlug]/workbench/sandboxes/sandbox-template-actions";

afterEach(cleanup);

type ChipTemplate = Pick<
  SandboxTemplateSummary,
  "provider" | "runtime" | "resources" | "network" | "secretSelection" | "tools"
>;

function makeTemplate(overrides: Partial<ChipTemplate> = {}): ChipTemplate {
  return {
    provider: "modal",
    runtime: null,
    resources: {},
    network: { mode: "public" },
    secretSelection: "all",
    tools: [],
    ...overrides,
  };
}

describe("templateResourceSummary / templateSecretSummary", () => {
  it("falls back to 'provider default' when no resource caps are set", () => {
    expect(templateResourceSummary({})).toBe("provider default");
  });

  it("renders the set vCPU/memory pair, using an em-dash for the unset side", () => {
    expect(templateResourceSummary({ vcpu: 2 })).toBe("2 vCPU / — MB");
    expect(templateResourceSummary({ vcpu: 2, memoryMb: 4096 })).toBe(
      "2 vCPU / 4096 MB",
    );
  });

  it("summarizes 'all' vs an explicit key allow-list, pluralizing correctly", () => {
    expect(templateSecretSummary("all")).toBe("all keys");
    expect(templateSecretSummary({ keyPublicIds: ["a"] })).toBe("1 key");
    expect(templateSecretSummary({ keyPublicIds: ["a", "b"] })).toBe("2 keys");
  });
});

describe("TemplateSpecChips", () => {
  it("renders provider, resources, network, secret mode, and tool count", () => {
    render(
      <TemplateSpecChips
        template={makeTemplate({
          resources: { vcpu: 1, memoryMb: 2048 },
          tools: [
            {
              id: "tool-1",
              kind: "capability",
              ref: "repo.pr.open",
              config: {},
            },
            { id: "tool-2", kind: "tool", ref: "x", config: {} },
          ],
        })}
      />,
    );
    expect(screen.getByText("Modal")).toBeInTheDocument();
    expect(screen.getByText("1 vCPU / 2048 MB")).toBeInTheDocument();
    expect(screen.getByText("Public egress")).toBeInTheDocument();
    expect(screen.getByText("all keys")).toBeInTheDocument();
    expect(screen.getByText("2 tools")).toBeInTheDocument();
  });

  it("omits the image chip when runtime is unset, and shows it (truncated) when set", () => {
    const { rerender } = render(
      <TemplateSpecChips template={makeTemplate()} />,
    );
    expect(screen.queryByTitle(/ghcr\.io/)).not.toBeInTheDocument();

    const runtime = "ghcr.io/oxageninc/oxagen-ci-base:latest";
    rerender(<TemplateSpecChips template={makeTemplate({ runtime })} />);
    const chip = screen.getByTitle(runtime);
    expect(chip.textContent?.startsWith("…")).toBe(true);
  });

  it("singularizes the tool count for exactly one tool", () => {
    render(
      <TemplateSpecChips
        template={makeTemplate({
          tools: [
            {
              id: "tool-1",
              kind: "capability",
              ref: "repo.pr.open",
              config: {},
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("1 tool")).toBeInTheDocument();
  });
});
