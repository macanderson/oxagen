import { describe, expect, it } from "vitest";
import { buildChatSystemPrompt } from "./system-prompt";

const BASE_CTX = {
  orgSlug: "acme",
  workspaceSlug: "main",
  orgName: "Acme Corp",
  workspaceName: "Main Workspace",
};

/**
 * The prompt with every run of whitespace collapsed to one space. The golden
 * file pins the exact layout; phrase assertions read the words, so rewrapping
 * a paragraph does not break them.
 */
function flatPrompt(ctx = BASE_CTX): string {
  return buildChatSystemPrompt(ctx).replace(/\s+/g, " ");
}

describe("buildChatSystemPrompt", () => {
  // The whole prompt, rendered for one fixed context and compared with the
  // checked-in file. A change to the prompt shows up in review as a diff of
  // that file. Regenerate it with `vitest run -u` on this one test file.
  it("matches the checked-in golden prompt", async () => {
    await expect(buildChatSystemPrompt(BASE_CTX)).toMatchFileSnapshot(
      "./__golden__/system-prompt.txt",
    );
  });

  describe("identity", () => {
    it("introduces the agent as stella", () => {
      expect(buildChatSystemPrompt(BASE_CTX)).toMatch(/^You are stella,/);
    });

    it.each(["governance agent", "governance plane", "Mission Control"])(
      "never uses the retired name %s",
      (retired) => {
        expect(flatPrompt()).not.toContain(retired);
      },
    );

    it("names the product and category from ADR-113", () => {
      const prompt = flatPrompt();
      expect(prompt).toContain("workforce management for autonomous agents");
      expect(prompt).toContain("agent control plane");
    });
  });

  describe("what stella can read", () => {
    it.each([
      "Runs",
      "Spend",
      "Approvals",
      "mandates",
      "knowledge graph",
      "memories",
    ])("names %s", (subject) => {
      expect(flatPrompt()).toContain(subject);
    });
  });

  // The model sees the pinned tools plus the belt's two helpers
  // (runtime/tool-belt.ts). A prompt that never names the helpers lets the
  // model end a turn with "I cannot" that one search would have answered.
  describe("the tool belt", () => {
    it("names both belt helpers", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).toContain("search_tools");
      expect(prompt).toContain("load_tools");
    });

    it("tells the model to search before it declines", () => {
      expect(flatPrompt()).toContain(
        "Search before you say you cannot do something.",
      );
    });
  });

  describe("governance", () => {
    it("says a write that requires approval parks and has not run", () => {
      const prompt = flatPrompt();
      expect(prompt).toContain("parks");
      expect(prompt).toContain("it has not run");
    });

    // First-use consent applies only to external MCP tools. Contract tools
    // pass the kernel's gates and, when requiresApproval is set, an approval.
    it("ties first-use consent to external MCP servers only", () => {
      const sentences = flatPrompt()
        .split(/(?<=\.)\s/)
        .filter((sentence) => sentence.includes("consent"));
      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toContain("external MCP server");
    });

    it("says the turn is recorded as a run", () => {
      expect(flatPrompt()).toContain("This turn is recorded as a run");
    });

    it("forbids working around a refused call", () => {
      const prompt = flatPrompt();
      expect(prompt).toContain("Never retry it under another name");
      expect(prompt).toContain("never ask anyone to turn a gate off");
    });

    it("separates what Oxagen observed from what a client reported", () => {
      expect(flatPrompt()).toContain("A report is not enforcement.");
    });

    it("asks for records by their human label, not a raw id", () => {
      expect(flatPrompt()).toContain("Name records by their human label.");
    });
  });

  // ADR-043: Oxagen governs agents, it does not run them. The prompt must not
  // advertise an execution surface the turn does not have.
  describe("no execution runtime", () => {
    it.each(["sandbox", "shell", "file system", "browser"])(
      "disclaims the %s rather than offering it",
      (surface) => {
        expect(flatPrompt()).toContain(`no ${surface}`);
      },
    );

    it.each([
      "subagent",
      "execute_code",
      "run_sandbox_command",
      "dispatch_subagent",
      "render_agent_ui",
      "create_plan",
      "run_workflow",
      "load_skill",
      "A2A",
    ])("never references the removed %s surface", (removed) => {
      expect(buildChatSystemPrompt(BASE_CTX)).not.toContain(removed);
    });
  });

  // The apps/app flyout has no slash-command menu and no mention picker, so
  // the prompt teaches neither grammar.
  describe("no composer grammar", () => {
    it("carries no slash-command table", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).not.toContain("Slash commands");
      expect(prompt).not.toContain("`/pr");
    });

    it("carries no mention grammar", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      expect(prompt).not.toContain("Reference mentions");
      expect(prompt).not.toContain("[:TYPE|");
    });
  });

  describe("interpolation", () => {
    it("names the org and workspace in the first line and the footer", () => {
      const prompt = buildChatSystemPrompt(BASE_CTX);
      const [first] = prompt.split("\n");
      expect(first).toContain('"Main Workspace" (workspace: main)');
      expect(first).toContain('"Acme Corp" (org: acme)');
      const tail = prompt.slice(-300);
      expect(tail).toContain("Acme Corp");
      expect(tail).toContain("Main Workspace");
    });

    it("uses different values for a different context", () => {
      const promptA = buildChatSystemPrompt(BASE_CTX);
      const promptB = buildChatSystemPrompt({
        orgSlug: "beta-inc",
        workspaceSlug: "dev",
        orgName: "Beta Inc",
        workspaceName: "Dev Team",
      });
      expect(promptA).not.toContain("Beta Inc");
      expect(promptB).toContain("Beta Inc");
      expect(promptB).toContain("Dev Team");
      expect(promptB).not.toContain("Acme Corp");
    });

    it("keeps special characters in names intact", () => {
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
