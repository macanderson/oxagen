// @vitest-environment jsdom
/**
 * agent-editor-form.test.tsx — component tests for AgentEditorForm.
 *
 * Covers: create render + submit (createAgentAction), slug auto-derivation,
 * adding tools and triggers, edit-mode submit (updateAgentAction), validation
 * error surfacing, and the canEdit gate.
 */
import * as React from "react";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockCreate, mockUpdate, mockPush, mockRefresh, mockAddToast } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
  mockAddToast: vi.fn(),
}));

vi.mock("./agent-actions", () => ({
  createAgentAction: mockCreate,
  updateAgentAction: mockUpdate,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    type,
    disabled,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <button type={type ?? "button"} onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {children}
    </button>
  ),
}));

vi.mock("lucide-react", () => ({
  Save: () => <svg aria-hidden="true" />,
  Plus: () => <svg aria-hidden="true" />,
  Trash2: () => <svg aria-hidden="true" />,
}));

import { AgentEditorForm } from "./agent-editor-form";
import { defaultAgentConfig } from "./agent-ui";

const createProps = {
  mode: "create" as const,
  orgSlug: "acme",
  workspaceSlug: "prod",
  ontologyId: "wrk_1",
  initialConfig: defaultAgentConfig("wrk_1"),
  canEdit: true,
};

function setName(value: string) {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value } });
}

describe("AgentEditorForm (create)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("renders the editor form", () => {
    render(<AgentEditorForm {...createProps} />);
    expect(screen.getByRole("form", { name: /agent editor/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create agent/i })).toBeInTheDocument();
  });

  it("auto-derives the slug from the name until edited", () => {
    render(<AgentEditorForm {...createProps} />);
    setName("Repo Review Agent");
    expect((screen.getByLabelText("Slug") as HTMLInputElement).value).toBe("repo-review-agent");
  });

  it("shows a validation error when name is empty", async () => {
    render(<AgentEditorForm {...createProps} />);
    fireEvent.submit(screen.getByRole("form", { name: /agent editor/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/name is required/i);
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("submits createAgentAction with the built config and navigates on success", async () => {
    mockCreate.mockResolvedValue({ ok: true, data: { slug: "repo-review-agent" } });
    render(<AgentEditorForm {...createProps} />);
    setName("Repo Review Agent");
    fireEvent.submit(screen.getByRole("form", { name: /agent editor/i }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledOnce());
    const arg = mockCreate.mock.calls[0]![0] as {
      slug: string;
      name: string;
      config: { graph: { ontologyId: string } };
    };
    expect(arg.slug).toBe("repo-review-agent");
    expect(arg.name).toBe("Repo Review Agent");
    expect(arg.config.graph.ontologyId).toBe("wrk_1");
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith("/acme/prod/automation/agents/repo-review-agent"),
    );
  });

  it("surfaces the action error on failure", async () => {
    mockCreate.mockResolvedValue({ ok: false, error: "slug already exists" });
    render(<AgentEditorForm {...createProps} />);
    setName("Dupe");
    fireEvent.submit(screen.getByRole("form", { name: /agent editor/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/slug already exists/i);
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("adds a tool row that is included in the submitted config", async () => {
    mockCreate.mockResolvedValue({ ok: true, data: { slug: "x" } });
    render(<AgentEditorForm {...createProps} />);
    setName("X");
    fireEvent.click(screen.getByRole("button", { name: /add tool/i }));
    fireEvent.change(screen.getByLabelText("Reference"), { target: { value: "coding" } });
    fireEvent.submit(screen.getByRole("form", { name: /agent editor/i }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledOnce());
    const arg = mockCreate.mock.calls[0]![0] as {
      config: { agentTools: { type: string; ref: string }[] };
    };
    expect(arg.config.agentTools).toContainEqual({ type: "skill", ref: "coding" });
  });

  it("hides the submit affordance description when canEdit is false", () => {
    render(<AgentEditorForm {...createProps} canEdit={false} />);
    expect(
      screen.getByText(/only workspace owners and admins can manage agents/i),
    ).toBeInTheDocument();
  });

  it("removes a tool row so it is not submitted", async () => {
    mockCreate.mockResolvedValue({ ok: true, data: { slug: "x" } });
    render(<AgentEditorForm {...createProps} />);
    setName("X");
    fireEvent.click(screen.getByRole("button", { name: /add tool/i }));
    fireEvent.change(screen.getByLabelText("Reference"), { target: { value: "coding" } });
    fireEvent.click(screen.getByRole("button", { name: /remove tool 1/i }));
    fireEvent.submit(screen.getByRole("form", { name: /agent editor/i }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledOnce());
    const arg = mockCreate.mock.calls[0]![0] as { config: { agentTools: unknown[] } };
    expect(arg.config.agentTools).toHaveLength(0);
  });

  it("builds an event trigger with its filter from the trigger editor", async () => {
    mockCreate.mockResolvedValue({ ok: true, data: { slug: "x" } });
    render(<AgentEditorForm {...createProps} />);
    setName("X");
    fireEvent.click(screen.getByRole("button", { name: /add trigger/i }));
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "event" } });
    fireEvent.change(screen.getByLabelText("Event source"), { target: { value: "github_repo" } });
    fireEvent.change(screen.getByLabelText("Event type"), { target: { value: "push" } });
    fireEvent.change(screen.getByLabelText("Branches (comma-separated)"), {
      target: { value: "main" },
    });
    fireEvent.submit(screen.getByRole("form", { name: /agent editor/i }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledOnce());
    const arg = mockCreate.mock.calls[0]![0] as {
      config: { triggers: { type: string; eventSource?: string; filter?: { branches?: string[] } }[] };
    };
    expect(arg.config.triggers[0]!.type).toBe("event");
    expect(arg.config.triggers[0]!.eventSource).toBe("github_repo");
    expect(arg.config.triggers[0]!.filter?.branches).toEqual(["main"]);
  });

  it("builds a schedule trigger with its cron", async () => {
    mockCreate.mockResolvedValue({ ok: true, data: { slug: "x" } });
    render(<AgentEditorForm {...createProps} />);
    setName("X");
    fireEvent.click(screen.getByRole("button", { name: /add trigger/i }));
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "schedule" } });
    fireEvent.change(screen.getByLabelText("Cron schedule"), { target: { value: "0 9 * * 1" } });
    fireEvent.submit(screen.getByRole("form", { name: /agent editor/i }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledOnce());
    const arg = mockCreate.mock.calls[0]![0] as {
      config: { triggers: { type: string; schedule?: string }[] };
    };
    expect(arg.config.triggers[0]!.type).toBe("schedule");
    expect(arg.config.triggers[0]!.schedule).toBe("0 9 * * 1");
  });

  it("removes a trigger row before submit", async () => {
    mockCreate.mockResolvedValue({ ok: true, data: { slug: "x" } });
    render(<AgentEditorForm {...createProps} />);
    setName("X");
    fireEvent.click(screen.getByRole("button", { name: /add trigger/i }));
    fireEvent.click(screen.getByRole("button", { name: /remove trigger 1/i }));
    fireEvent.submit(screen.getByRole("form", { name: /agent editor/i }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledOnce());
    const arg = mockCreate.mock.calls[0]![0] as { config: { triggers: unknown[] } };
    expect(arg.config.triggers).toHaveLength(0);
  });

  it("includes edited graph budget values in the submitted config", async () => {
    mockCreate.mockResolvedValue({ ok: true, data: { slug: "x" } });
    render(<AgentEditorForm {...createProps} />);
    setName("X");
    fireEvent.change(screen.getByLabelText("Max hops"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Max nodes"), { target: { value: "80" } });
    fireEvent.change(screen.getByLabelText(/min relevance/i), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "extend" } });
    fireEvent.change(screen.getByLabelText("Retrieval strategy"), { target: { value: "semantic" } });
    fireEvent.submit(screen.getByRole("form", { name: /agent editor/i }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledOnce());
    const arg = mockCreate.mock.calls[0]![0] as {
      config: {
        graph: {
          mode: string;
          retrieval: { strategy: string };
          budget: { maxHops: number; maxNodes: number; minRelevance?: number };
        };
      };
    };
    expect(arg.config.graph.mode).toBe("extend");
    expect(arg.config.graph.retrieval.strategy).toBe("semantic");
    expect(arg.config.graph.budget.maxHops).toBe(5);
    expect(arg.config.graph.budget.maxNodes).toBe(80);
    expect(arg.config.graph.budget.minRelevance).toBeUndefined();
  });
});

describe("AgentEditorForm (edit)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  const editProps = {
    ...createProps,
    mode: "edit" as const,
    agentId: "agt_1",
    agentSlug: "repo-review",
    initialName: "Repo Review",
    initialDescription: "Existing",
    initialConfig: {
      ...defaultAgentConfig("wrk_1"),
      instructions: "Do the thing",
    },
  };

  it("seeds fields from the existing definition and locks the slug", () => {
    render(<AgentEditorForm {...editProps} />);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Repo Review");
    expect(screen.getByLabelText("Slug")).toBeDisabled();
    expect(screen.getByRole("button", { name: /save new version/i })).toBeInTheDocument();
  });

  it("submits updateAgentAction and navigates to the agent detail by its slug", async () => {
    mockUpdate.mockResolvedValue({ ok: true, data: { agentId: "agt_1", version: 2, isPublished: false } });
    render(<AgentEditorForm {...editProps} />);
    fireEvent.submit(screen.getByRole("form", { name: /agent editor/i }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledOnce());
    const arg = mockUpdate.mock.calls[0]![0] as { agentId: string };
    expect(arg.agentId).toBe("agt_1");
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/acme/prod/automation/agents/repo-review"));
  });

  it("surfaces an update failure without navigating", async () => {
    mockUpdate.mockResolvedValue({ ok: false, error: "version conflict" });
    render(<AgentEditorForm {...editProps} />);
    fireEvent.submit(screen.getByRole("form", { name: /agent editor/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/version conflict/i);
    });
    expect(mockPush).not.toHaveBeenCalled();
  });
});
