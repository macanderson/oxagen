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
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain('"Acme Corp"');
    });

    it("interpolates workspaceName into the identity line", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain('"Main Workspace"');
    });

    it("includes orgSlug in the identity line", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("org: acme");
    });

    it("includes workspaceSlug in the identity line", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("workspace: main");
    });

    it("repeats org and workspace context in the footer", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("Acme Corp");
      expect(prompt).toContain("Main Workspace");
    });
  });

  describe("UI rendering guidance section", () => {
    it("mentions create-workspace-inline component", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("create-workspace-inline");
    });

    it("mentions create-org-inline component", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("create-org-inline");
    });

    it("mentions invite-member-inline component", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("invite-member-inline");
    });

    it("mentions model-settings-inline component", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("model-settings-inline");
    });

    it("mentions billing-upgrade-inline component", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("billing-upgrade-inline");
    });

    it("mentions credits-purchase-inline component", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("credits-purchase-inline");
    });

    it("mentions confirm-destructive-inline for destructive actions", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("confirm-destructive-inline");
    });

    it("references agent.ui.render as the tool to call", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("agent.ui.render");
    });

    it("explains that api.key.create handles its own render directive", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("api.key.create");
      expect(prompt).toContain("render directive automatically");
    });
  });

  describe("direct-action guidance section", () => {
    it("mentions workspace.create as a direct-call capability", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("workspace.create");
    });

    it("mentions api.key.create as a direct-call capability", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("api.key.create");
    });

    it("instructs to invoke directly when all params are known", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("invoke the capability directly");
    });
  });

  describe("workflow guidance section", () => {
    it("references workflow.run for large parallel tasks", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("workflow.run");
    });

    it("specifies threshold of 10+ tasks for workflow.run", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("10 or more parallel");
    });

    it("instructs agent.plan.create for N > 20 tasks before dispatching", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("agent.plan.create");
      expect(prompt).toContain("N > 20");
    });

    it("allows skipping approval for N <= 20 tasks", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("N ≤ 20");
    });

    it("includes recognizable large-task examples", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("Fortune 500");
    });
  });

  describe("subagent guidance section", () => {
    it("references agent.subagent.dispatch for 2-9 parallel tasks", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("agent.subagent.dispatch");
    });

    it("specifies the 2-9 task range for subagent dispatch", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("2–9 parallel tasks");
    });

    it("explains subagent dispatch is faster than workflow.run", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("faster than");
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
      const orgSlugOccurrences = (prompt.match(/slug-org/g) ?? []).length;
      const wsSlugOccurrences = (prompt.match(/slug-ws/g) ?? []).length;
      expect(orgSlugOccurrences).toBeGreaterThanOrEqual(2);
      expect(wsSlugOccurrences).toBeGreaterThanOrEqual(2);
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
