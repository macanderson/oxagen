import { describe, it, expect } from "vitest";
import { buildChatSystemPrompt } from "./system-prompt";

const BASE_CTX = {
  orgSlug: "acme",
  workspaceSlug: "main",
  orgName: "Acme Corp",
  workspaceName: "Main Workspace",
};

describe("buildChatSystemPrompt", () => {
  it("returns a non-empty string", () => {
    const prompt = buildChatSystemPrompt(BASE_CTX);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
  });

  describe("identity + context section", () => {
    it("interpolates orgName into the identity line", () => {
      expect(buildChatSystemPrompt(BASE_CTX)).toContain('"Acme Corp"');
    });

    it("interpolates workspaceName into the identity line", () => {
      expect(buildChatSystemPrompt(BASE_CTX)).toContain('"Main Workspace"');
    });

    it("includes orgSlug in the identity line", () => {
      expect(buildChatSystemPrompt(BASE_CTX)).toContain("org: acme");
    });

    it("includes workspaceSlug in the identity line", () => {
      expect(buildChatSystemPrompt(BASE_CTX)).toContain("workspace: main");
    });

    it("repeats org and workspace context in the footer", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      const tail = prompt.slice(-400);
      expect(tail).toContain("Acme Corp");
      expect(tail).toContain("Main Workspace");
    });
  });

  // ADR-043: Oxagen governs agents, it does not run them. The prompt must not
  // advertise an execution surface the runtime no longer has — a model told it
  // can run code burns a turn discovering the tool does not exist.
  describe("governance posture (no execution runtime)", () => {
    it("states plainly that it is not a coding agent", () => {
      expect(buildChatSystemPrompt(BASE_CTX)).toContain("NOT a coding agent");
    });

    it.each(["sandbox", "shell", "file system", "browser"])(
      "disclaims the %s rather than offering it",
      (surface) => {
        const prompt = buildChatSystemPrompt(BASE_CTX);
        expect(prompt).toContain(`no ${surface}`);
      },
    );

    it.each([
      "subagent",
      "skill",
      "execute_code",
      "run_sandbox_command",
      "dispatch_subagent",
      "render_agent_ui",
      "create_plan",
      "run_workflow",
    ])("never references the removed %s surface", (removed) => {
      expect(buildChatSystemPrompt(BASE_CTX)).not.toContain(removed);
    });
  });

  describe("grounding + governance guidance", () => {
    it("requires claims to be grounded in a tool result", () => {
      expect(buildChatSystemPrompt(BASE_CTX)).toContain(
        "Ground every factual claim in a tool result",
      );
    });

    it("forbids citing a node by its raw UUID", () => {
      expect(buildChatSystemPrompt(BASE_CTX)).toContain("never by a raw UUID");
    });

    it("separates observed evidence from client attestation", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("OBSERVED");
      expect(prompt).toContain("ATTESTED");
    });

    it("names the gates every tool call passes through", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      for (const gate of [
        "IAM",
        "entitlement",
        "tool RBAC",
        "consent",
        "approval",
      ]) {
        expect(prompt).toContain(gate);
      }
    });

    it("instructs the model never to work around a refused call", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("never work around it");
      expect(prompt).toContain("never ask the user to disable a gate");
    });
  });

  describe("interpolation correctness", () => {
    it("uses different values for a different context", () => {
      const promptA = buildChatSystemPrompt(BASE_CTX);
      const promptB = buildChatSystemPrompt({
        orgSlug: "beta-inc",
        workspaceSlug: "dev",
        orgName: "Beta Inc",
        workspaceName: "Dev Team",
      });

      expect(promptA).toContain("Acme Corp");
      expect(promptA).not.toContain("Beta Inc");

      expect(promptB).toContain("Beta Inc");
      expect(promptB).toContain("Dev Team");
      expect(promptB).not.toContain("Acme Corp");
    });

    it("slugs appear in both the header and footer", () => {
      const prompt = buildChatSystemPrompt({
        orgSlug: "slug-org",
        workspaceSlug: "slug-ws",
        orgName: "Slug Org",
        workspaceName: "Slug WS",
      });
      expect((prompt.match(/slug-org/g) ?? []).length).toBeGreaterThanOrEqual(
        2,
      );
      expect((prompt.match(/slug-ws/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });

    it("handles special characters in org/workspace names without breaking the prompt", () => {
      const prompt = buildChatSystemPrompt({
        orgSlug: "test-org",
        workspaceSlug: "test-ws",
        orgName: 'Acme & "Partners"',
        workspaceName: "R&D / Labs",
      });
      expect(prompt).toContain('Acme & "Partners"');
      expect(prompt).toContain("R&D / Labs");
    });
  });
});

// ── Composed shared sections (ADR-043: one prompt, one registry each) ────────
describe("buildChatSystemPrompt — composed protocol sections", () => {
  const CTX = {
    orgSlug: "acme",
    workspaceSlug: "main",
    orgName: "Acme",
    workspaceName: "Main",
  };

  it("carries the slash-command table generated from the shared registry", () => {
    const prompt = buildChatSystemPrompt(CTX);
    expect(prompt).toContain("## Slash commands");
    // Generated from @oxagen/ai's SLASH_COMMANDS — the same registry the
    // composer menu renders, so the prompt and the menu cannot disagree.
    expect(prompt).toContain("`/pr <pr-number>`");
    expect(prompt).toContain("`/ci [ref]`");
  });

  it("carries the @-mention grammar so mention tokens are not opaque", () => {
    const prompt = buildChatSystemPrompt(CTX);
    expect(prompt).toContain("## Reference mentions");
    expect(prompt).toContain("[:TYPE|:SLUG|:LOCATION|:LABEL]");
  });

  it("never offers a repository EDIT — Oxagen governs agents, it does not run them", () => {
    const prompt = buildChatSystemPrompt(CTX);
    expect(prompt).toContain("Oxagen does not edit repositories");
    expect(prompt).not.toMatch(/\bpin(ned)? (a |the )?repos(itory)?\b/i);
  });

  it("names no excised runtime tool", () => {
    const prompt = buildChatSystemPrompt(CTX);
    for (const dead of [
      "load_skill",
      "render_agent_ui",
      "run_workflow",
      "create_plan",
      "dispatch_subagent",
      "execute_code",
      "A2A",
    ]) {
      expect(prompt).not.toContain(dead);
    }
  });
});
