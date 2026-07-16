// @vitest-environment jsdom
/**
 * skill-detail-panel.test.tsx — unit tests for SkillDetailPanel component.
 *
 * Covers:
 *   - Renders skill name, description, slug
 *   - Renders "Built-in" badge for source="builtin"
 *   - Renders "Custom" badge for source="custom"
 *   - Renders active version badge when activeVersion is set
 *   - Does not render active version badge when activeVersion is null
 *   - Download button is always visible
 *   - Edit button visible when canManage=true
 *   - Edit button hidden when canManage=false
 *   - Clicking Edit toggles to editor view
 *   - Editor panel shows content textarea, commit message, and save button
 *   - Clicking Edit again (Cancel) hides editor
 *   - Save is disabled when content is empty
 *   - Save calls editAction with correct args and shows success toast
 *   - Save with commit message includes commit message
 *   - editAction failure shows error toast
 *   - Download button calls exportAction and triggers blob download
 *   - exportAction failure shows error toast
 *   - Version history shows "No versions found" for empty list
 *   - Version history renders rows for each version
 *   - Active version shows "active" badge
 *   - Inactive version shows Activate button when canManage=true
 *   - Inactive version does NOT show Activate button when canManage=false
 *   - Active version does NOT show Activate button
 *   - Clicking Activate calls activateAction and shows success toast
 *   - activateAction failure shows error toast
 *   - Per-version Download button calls exportAction with versionId
 *   - formatDate renders a human-readable date
 */

import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react";
import {
  SkillDetailPanel,
  type SkillDetailData,
  type SkillVersion,
} from "./skill-detail-panel";

afterEach(() => {
  cleanup();
  // The download-flow tests vi.spyOn(document.body, "appendChild"/"removeChild").
  // Restore them so the mocked appendChild does not leak into later tests/files
  // (a leaked appendChild mock makes every subsequent render() fail with
  // "Target container is not a DOM element").
  vi.restoreAllMocks();
});

// ── Module mocks ──────────────────────────────────────────────────────────────

const { mockToastAdd } = vi.hoisted(() => ({ mockToastAdd: vi.fn() }));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockToastAdd }),
}));

vi.mock(
  "lucide-react",
  () =>
    new Proxy({} as Record<string | symbol, unknown>, {
      get: (_t, prop) =>
        prop === "then"
          ? undefined
          : () => <svg aria-hidden="true" data-icon={String(prop)} />,
      has: (_t, prop) => prop !== "then",
    }),
);

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    variant: _v,
    size: _s,
    className: _c,
    "aria-label": ariaLabel,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    size?: string;
    className?: string;
    "aria-label"?: string;
    "data-testid"?: string;
  }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    variant: _v,
    className: _c,
  }: {
    children: React.ReactNode;
    variant?: string;
    className?: string;
  }) => <span data-testid="badge">{children}</span>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    children: React.ReactNode;
  }) => (open ? <div data-testid="dialog-root">{children}</div> : null),
  DialogPopup: ({
    children,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    className?: string;
    "data-testid"?: string;
  }) => <div data-testid={testId ?? "dialog-popup"}>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({
    children,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: ({
    value,
    onChange,
    rows: _r,
    className: _c,
    "aria-label": ariaLabel,
    "data-testid": testId,
    placeholder: _p,
  }: {
    value: string;
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    rows?: number;
    className?: string;
    "aria-label"?: string;
    "data-testid"?: string;
    placeholder?: string;
  }) => (
    <textarea
      value={value}
      onChange={onChange}
      aria-label={ariaLabel}
      data-testid={testId}
    />
  ),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeSkill = (
  overrides: Partial<SkillDetailData> = {},
): SkillDetailData => ({
  id: "skill-1",
  slug: "my-skill",
  name: "My Skill",
  description: "Does something useful",
  source: "custom",
  installedFromSlug: null,
  activeVersion: "v1.2.0",
  activeVersionIsPinned: true,
  content: "# My Skill\n\nSome content here.",
  updatedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

const makeVersion = (
  overrides: Partial<SkillVersion> & { id: string },
): SkillVersion => ({
  versionNumber: 1,
  version: "v1.0.0",
  commitMessage: "Initial commit",
  createdAt: "2026-01-01T00:00:00Z",
  createdByEmail: "user@example.com",
  isActive: false,
  ...overrides,
});

const v1 = makeVersion({
  id: "ver-1",
  versionNumber: 1,
  version: "v1.0.0",
  isActive: false,
});
const v2 = makeVersion({
  id: "ver-2",
  versionNumber: 2,
  version: "v1.2.0",
  isActive: true,
  commitMessage: "Add feature",
});

const defaultEditAction = vi.fn();
const defaultActivateAction = vi.fn();
const defaultExportAction = vi.fn();

function renderPanel(
  props: Partial<{
    skill: SkillDetailData;
    versions: SkillVersion[];
    canManage: boolean;
    editAction: typeof defaultEditAction;
    activateAction: typeof defaultActivateAction;
    exportAction: typeof defaultExportAction;
  }> = {},
) {
  return render(
    <SkillDetailPanel
      orgSlug="acme"
      workspaceSlug="main"
      skill={makeSkill()}
      versions={[v1, v2]}
      canManage={true}
      editAction={defaultEditAction}
      activateAction={defaultActivateAction}
      exportAction={defaultExportAction}
      {...props}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SkillDetailPanel — rendering: meta section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the skill name", () => {
    renderPanel();
    expect(screen.getByText("My Skill")).toBeInTheDocument();
  });

  it("renders the skill description", () => {
    renderPanel();
    expect(screen.getByText("Does something useful")).toBeInTheDocument();
  });

  it("renders the skill slug as monospace", () => {
    renderPanel();
    expect(screen.getByText("my-skill")).toBeInTheDocument();
  });

  it("renders 'Built-in' badge for source='builtin'", () => {
    renderPanel({ skill: makeSkill({ source: "builtin" }) });
    expect(screen.getByText("Built-in")).toBeInTheDocument();
  });

  it("renders 'Custom' badge for source='custom'", () => {
    renderPanel({ skill: makeSkill({ source: "custom" }) });
    expect(screen.getByText("Custom")).toBeInTheDocument();
  });

  it("renders active version badge when activeVersion is set", () => {
    // Use a unique version string not present in default version rows
    renderPanel({
      skill: makeSkill({ activeVersion: "v99.0.0" }),
      versions: [],
    });
    expect(screen.getByText("v99.0.0")).toBeInTheDocument();
  });

  it("does not render a meta version badge when activeVersion is null", () => {
    // With activeVersion=null, the skill.activeVersion conditional block is skipped.
    // Render with no version history so the only badges are the source badge.
    renderPanel({ skill: makeSkill({ activeVersion: null }), versions: [] });
    const badges = screen.getAllByTestId("badge");
    // Only the source badge ("Custom") should appear — no version badge
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toBe("Custom");
  });
});

describe("SkillDetailPanel — rendering: action buttons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Download button is always visible", () => {
    renderPanel();
    expect(screen.getByTestId("skill-download-btn")).toBeInTheDocument();
  });

  it("Edit button is visible when canManage=true", () => {
    renderPanel({ canManage: true });
    expect(screen.getByTestId("skill-edit-btn")).toBeInTheDocument();
  });

  it("Edit button is hidden when canManage=false", () => {
    renderPanel({ canManage: false });
    expect(screen.queryByTestId("skill-edit-btn")).not.toBeInTheDocument();
  });
});

describe("SkillDetailPanel — edit flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clicking Edit shows the editor panel", () => {
    renderPanel({ canManage: true });
    expect(screen.queryByTestId("skill-editor")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("skill-edit-btn"));

    expect(screen.getByTestId("skill-editor")).toBeInTheDocument();
  });

  it("editor panel contains content textarea", () => {
    renderPanel({ canManage: true });
    fireEvent.click(screen.getByTestId("skill-edit-btn"));

    expect(screen.getByTestId("skill-content-textarea")).toBeInTheDocument();
  });

  it("editor panel contains commit message input", () => {
    renderPanel({ canManage: true });
    fireEvent.click(screen.getByTestId("skill-edit-btn"));

    expect(
      screen.getByTestId("skill-commit-message-input"),
    ).toBeInTheDocument();
  });

  it("editor panel contains Save New Version button", () => {
    renderPanel({ canManage: true });
    fireEvent.click(screen.getByTestId("skill-edit-btn"));

    expect(screen.getByTestId("skill-save-btn")).toBeInTheDocument();
  });

  it("Edit button label changes to 'Cancel' when editor is open", () => {
    renderPanel({ canManage: true });
    fireEvent.click(screen.getByTestId("skill-edit-btn"));

    expect(screen.getByTestId("skill-edit-btn")).toHaveTextContent(/cancel/i);
  });

  it("clicking Cancel hides the editor", () => {
    renderPanel({ canManage: true });
    fireEvent.click(screen.getByTestId("skill-edit-btn"));
    expect(screen.getByTestId("skill-editor")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("skill-edit-btn"));
    expect(screen.queryByTestId("skill-editor")).not.toBeInTheDocument();
  });

  it("Save button is disabled when textarea is empty", () => {
    renderPanel({ skill: makeSkill({ content: "" }), canManage: true });
    fireEvent.click(screen.getByTestId("skill-edit-btn"));

    const saveBtn = screen.getByTestId("skill-save-btn");
    expect(saveBtn).toBeDisabled();
  });

  it("Save button is enabled when textarea has content", () => {
    renderPanel({
      skill: makeSkill({ content: "Some content" }),
      canManage: true,
    });
    fireEvent.click(screen.getByTestId("skill-edit-btn"));

    const saveBtn = screen.getByTestId("skill-save-btn");
    expect(saveBtn).not.toBeDisabled();
  });

  it("calls editAction with correct args on save", async () => {
    defaultEditAction.mockResolvedValue({ ok: true, version: "v1.3.0" });
    renderPanel({ canManage: true });
    fireEvent.click(screen.getByTestId("skill-edit-btn"));

    const textarea = screen.getByTestId("skill-content-textarea");
    fireEvent.change(textarea, { target: { value: "Updated content" } });

    const commitInput = screen.getByTestId("skill-commit-message-input");
    fireEvent.change(commitInput, { target: { value: "Fix typo" } });

    await act(async () => {
      fireEvent.click(screen.getByTestId("skill-save-btn"));
    });

    expect(defaultEditAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "main",
      skillSlug: "my-skill",
      content: "Updated content",
      commitMessage: "Fix typo",
    });
  });

  it("shows success toast and closes editor on save success", async () => {
    defaultEditAction.mockResolvedValue({ ok: true, version: "v1.3.0" });
    renderPanel({ canManage: true });
    fireEvent.click(screen.getByTestId("skill-edit-btn"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("skill-save-btn"));
    });

    await waitFor(() => {
      expect(mockToastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "New version saved" }),
      );
    });

    expect(screen.queryByTestId("skill-editor")).not.toBeInTheDocument();
  });

  it("includes version number in success toast description", async () => {
    defaultEditAction.mockResolvedValue({ ok: true, version: "v1.3.0" });
    renderPanel({ canManage: true });
    fireEvent.click(screen.getByTestId("skill-edit-btn"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("skill-save-btn"));
    });

    await waitFor(() => {
      expect(mockToastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          description: expect.stringContaining("v1.3.0"),
        }),
      );
    });
  });

  it("shows error toast on save failure", async () => {
    defaultEditAction.mockResolvedValue({ ok: false, error: "Conflict" });
    renderPanel({ canManage: true });
    fireEvent.click(screen.getByTestId("skill-edit-btn"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("skill-save-btn"));
    });

    await waitFor(() => {
      expect(mockToastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Save failed",
          description: "Conflict",
          type: "error",
        }),
      );
    });

    // Editor stays open on failure
    expect(screen.getByTestId("skill-editor")).toBeInTheDocument();
  });

  it("does not include commitMessage key when commit message input is empty", async () => {
    defaultEditAction.mockResolvedValue({ ok: true, version: "v1.3.0" });
    renderPanel({ canManage: true });
    fireEvent.click(screen.getByTestId("skill-edit-btn"));

    // Leave commit message empty
    await act(async () => {
      fireEvent.click(screen.getByTestId("skill-save-btn"));
    });

    expect(defaultEditAction).toHaveBeenCalledWith(
      expect.objectContaining({ commitMessage: undefined }),
    );
  });
});

describe("SkillDetailPanel — download flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clicking Download button calls exportAction without versionNumber", async () => {
    defaultExportAction.mockResolvedValue({
      ok: true,
      content: "# Skill",
      filename: "my-skill.md",
    });

    // Mock DOM for blob download
    const createObjectURL = vi.fn(() => "blob:fake-url");
    const revokeObjectURL = vi.fn();
    global.URL.createObjectURL = createObjectURL;
    global.URL.revokeObjectURL = revokeObjectURL;

    const clickMock = vi.fn();
    const appendMock = vi.fn();
    const removeMock = vi.fn();
    const createElementOriginal = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "a") {
        const el = createElementOriginal("a") as HTMLAnchorElement;
        el.click = clickMock;
        return el;
      }
      return createElementOriginal(tag);
    });
    // Render BEFORE stubbing appendChild — RTL's render() attaches its container
    // via document.body.appendChild, so a no-op appendMock here would make
    // render() fail with "Target container is not a DOM element".
    renderPanel();

    vi.spyOn(document.body, "appendChild").mockImplementation(appendMock);
    vi.spyOn(document.body, "removeChild").mockImplementation(removeMock);

    await act(async () => {
      fireEvent.click(screen.getByTestId("skill-download-btn"));
    });

    expect(defaultExportAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "main",
      skillSlug: "my-skill",
      versionNumber: undefined,
    });

    expect(createObjectURL).toHaveBeenCalled();
    expect(clickMock).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake-url");

    vi.restoreAllMocks();
  });

  it("shows error toast when exportAction fails", async () => {
    defaultExportAction.mockResolvedValue({ ok: false, error: "Not found" });

    renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByTestId("skill-download-btn"));
    });

    await waitFor(() => {
      expect(mockToastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Export failed",
          description: "Not found",
          type: "error",
        }),
      );
    });
  });

  it("shows error toast when exportAction returns ok but no content", async () => {
    defaultExportAction.mockResolvedValue({ ok: true, content: undefined });

    renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByTestId("skill-download-btn"));
    });

    await waitFor(() => {
      expect(mockToastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Export failed",
          type: "error",
        }),
      );
    });
  });
});

describe("SkillDetailPanel — pin confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function saveNewVersion() {
    fireEvent.click(screen.getByTestId("skill-edit-btn"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("skill-save-btn"));
    });
  }

  it("opens the pin dialog after a successful save that returns a versionNumber", async () => {
    defaultEditAction.mockResolvedValue({
      ok: true,
      version: "v3",
      versionNumber: 3,
    });
    renderPanel({ canManage: true });

    await saveNewVersion();

    expect(screen.getByTestId("skill-pin-dialog")).toBeInTheDocument();
    expect(
      screen.getByText("Pin v3 as the default version?"),
    ).toBeInTheDocument();
  });

  it("does not open the pin dialog when save fails", async () => {
    defaultEditAction.mockResolvedValue({ ok: false, error: "Conflict" });
    renderPanel({ canManage: true });

    await saveNewVersion();

    expect(screen.queryByTestId("skill-pin-dialog")).not.toBeInTheDocument();
  });

  it("confirming pins the new version via activateAction and closes the dialog", async () => {
    defaultEditAction.mockResolvedValue({
      ok: true,
      version: "v3",
      versionNumber: 3,
    });
    defaultActivateAction.mockResolvedValue({ ok: true });
    renderPanel({ canManage: true });

    await saveNewVersion();
    await act(async () => {
      fireEvent.click(screen.getByTestId("skill-pin-confirm-btn"));
    });

    expect(defaultActivateAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "main",
      skillSlug: "my-skill",
      versionNumber: 3,
    });
    await waitFor(() => {
      expect(screen.queryByTestId("skill-pin-dialog")).not.toBeInTheDocument();
    });
  });

  it("dismissing keeps the current pinned version (no activate call)", async () => {
    defaultEditAction.mockResolvedValue({
      ok: true,
      version: "v3",
      versionNumber: 3,
    });
    renderPanel({ canManage: true });

    await saveNewVersion();
    fireEvent.click(screen.getByTestId("skill-pin-dismiss-btn"));

    expect(defaultActivateAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId("skill-pin-dialog")).not.toBeInTheDocument();
  });

  it("labels the meta badge when the shown version is latest-unpinned", () => {
    renderPanel({
      skill: makeSkill({ activeVersion: "v2", activeVersionIsPinned: false }),
      versions: [],
    });
    expect(screen.getByText(/latest, unpinned/)).toBeInTheDocument();
  });
});

describe("SkillDetailPanel — version history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows 'No versions found' when versions array is empty", () => {
    renderPanel({ versions: [] });
    expect(screen.getByText("No versions found.")).toBeInTheDocument();
  });

  it("renders version history table when versions exist", () => {
    renderPanel({ versions: [v1, v2] });
    expect(screen.getByTestId("skill-versions-table")).toBeInTheDocument();
  });

  it("renders a row per version", () => {
    renderPanel({ versions: [v1, v2] });
    expect(screen.getByTestId("skill-version-row-ver-1")).toBeInTheDocument();
    expect(screen.getByTestId("skill-version-row-ver-2")).toBeInTheDocument();
  });

  it("shows version numbers in the table", () => {
    renderPanel({ versions: [v1, v2] });
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
    expect(screen.getAllByText("v1.2.0").length).toBeGreaterThan(0);
  });

  it("shows commit messages in the table", () => {
    renderPanel({ versions: [v1, v2] });
    expect(screen.getByText("Initial commit")).toBeInTheDocument();
    expect(screen.getByText("Add feature")).toBeInTheDocument();
  });

  it("renders '—' when commitMessage is null", () => {
    const noMsgVersion = makeVersion({ id: "ver-3", commitMessage: null });
    renderPanel({ versions: [noMsgVersion] });
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders '—' when createdByEmail is null", () => {
    const noEmailVersion = makeVersion({ id: "ver-3", createdByEmail: null });
    renderPanel({ versions: [noEmailVersion] });
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it("active version shows 'active' badge", () => {
    renderPanel({ versions: [v1, v2] });
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("inactive version does NOT show Activate button when canManage=false", () => {
    renderPanel({ versions: [v1], canManage: false });
    expect(
      screen.queryByTestId("skill-version-activate-ver-1"),
    ).not.toBeInTheDocument();
  });

  it("inactive version shows Activate button when canManage=true", () => {
    renderPanel({ versions: [v1], canManage: true });
    expect(
      screen.getByTestId("skill-version-activate-ver-1"),
    ).toBeInTheDocument();
  });

  it("active version does NOT show Activate button even when canManage=true", () => {
    renderPanel({ versions: [v2], canManage: true });
    expect(
      screen.queryByTestId("skill-version-activate-ver-2"),
    ).not.toBeInTheDocument();
  });

  it("per-version Download button is visible for each version", () => {
    renderPanel({ versions: [v1, v2] });
    expect(
      screen.getByTestId("skill-version-download-ver-1"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("skill-version-download-ver-2"),
    ).toBeInTheDocument();
  });

  it("clicking per-version Download calls exportAction with versionNumber", async () => {
    defaultExportAction.mockResolvedValue({
      ok: true,
      content: "# Skill",
      filename: "my-skill-v1.0.0.md",
    });

    const createObjectURL = vi.fn(() => "blob:fake-url");
    const revokeObjectURL = vi.fn();
    global.URL.createObjectURL = createObjectURL;
    global.URL.revokeObjectURL = revokeObjectURL;

    const clickMock = vi.fn();
    const createElementOriginal = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "a") {
        const el = createElementOriginal("a") as HTMLAnchorElement;
        el.click = clickMock;
        return el;
      }
      return createElementOriginal(tag);
    });

    renderPanel({ versions: [v1, v2] });

    await act(async () => {
      fireEvent.click(screen.getByTestId("skill-version-download-ver-1"));
    });

    expect(defaultExportAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "main",
      skillSlug: "my-skill",
      versionNumber: 1,
    });

    vi.restoreAllMocks();
  });
});

describe("SkillDetailPanel — activate flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clicking Activate calls activateAction with correct args", async () => {
    defaultActivateAction.mockResolvedValue({ ok: true });
    renderPanel({ versions: [v1, v2], canManage: true });

    await act(async () => {
      fireEvent.click(screen.getByTestId("skill-version-activate-ver-1"));
    });

    expect(defaultActivateAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "main",
      skillSlug: "my-skill",
      versionNumber: 1,
    });
  });

  it("shows success toast when activateAction succeeds", async () => {
    defaultActivateAction.mockResolvedValue({ ok: true });
    renderPanel({ versions: [v1, v2], canManage: true });

    await act(async () => {
      fireEvent.click(screen.getByTestId("skill-version-activate-ver-1"));
    });

    await waitFor(() => {
      expect(mockToastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "v1 is now the workspace default" }),
      );
    });
  });

  it("shows error toast when activateAction fails", async () => {
    defaultActivateAction.mockResolvedValue({
      ok: false,
      error: "Already active",
    });
    renderPanel({ versions: [v1, v2], canManage: true });

    await act(async () => {
      fireEvent.click(screen.getByTestId("skill-version-activate-ver-1"));
    });

    await waitFor(() => {
      expect(mockToastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Activation failed",
          description: "Already active",
          type: "error",
        }),
      );
    });
  });

  it("Activate button shows 'Activating…' while in progress", async () => {
    let resolve: (v: { ok: boolean }) => void = () => {};
    defaultActivateAction.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );

    renderPanel({ versions: [v1, v2], canManage: true });
    fireEvent.click(screen.getByTestId("skill-version-activate-ver-1"));

    await waitFor(() => {
      expect(screen.getByTestId("skill-version-activate-ver-1")).toBeDisabled();
    });

    // Resolve to clean up
    resolve({ ok: true });
  });
});

describe("SkillDetailPanel — version history heading", () => {
  it("renders Version History heading", () => {
    renderPanel();
    expect(screen.getByText("Version History")).toBeInTheDocument();
  });

  it("renders attribute labels for each version entry", () => {
    // Version history is now a <ul> of <li> entries (a chronological log read
    // item-by-item), not a <table> — "Version" and "Message" are the entry's
    // identity (unlabeled, like a git log line) and "Actions" has no label
    // (just buttons), so only the labeled attributes remain as <dt> text.
    renderPanel({ versions: [v1] });
    expect(screen.getByText("Created")).toBeInTheDocument();
    expect(screen.getByText("Author")).toBeInTheDocument();
  });
});
