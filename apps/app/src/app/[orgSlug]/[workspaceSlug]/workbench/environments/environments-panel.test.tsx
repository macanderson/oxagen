// @vitest-environment jsdom
/**
 * environments-panel.test.tsx — unit tests for EnvironmentsPanel.
 *
 * Covers:
 *   (a) Secret key names appear in the grid
 *   (b) Environment slugs appear as table column headers
 *   (c) canManage:false hides "Paste .env", "+ Add key", and "Delete" controls
 *   (d) Clicking "Paste .env" opens the dialog (textarea becomes visible)
 *   (e) Typing text + clicking "Preview" calls importEnvAction(commit:false)
 *       with the entered text, environmentId:null, and the workspace scope
 *   (f) After preview rows are returned, clicking "Import N keys" calls
 *       importEnvAction(commit:true)
 */

import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
  waitFor,
} from "@testing-library/react";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Mocks — stub every UI component so the component tree renders in jsdom
// without importing the @oxagen/ui package (which relies on browser APIs).
// ---------------------------------------------------------------------------

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    variant: _v,
    size: _s,
    className: _c,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    size?: string;
    className?: string;
    "data-testid"?: string;
  }) => (
    <button onClick={onClick} disabled={disabled} data-testid={testId}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    variant: _v,
    size: _s,
  }: {
    children: React.ReactNode;
    variant?: string;
    size?: string;
  }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: ({
    value,
    onChange,
    placeholder,
    type,
    disabled,
    size: _s,
    autoFocus: _af,
    id,
    className: _c,
  }: {
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    placeholder?: string;
    type?: string;
    disabled?: boolean;
    size?: string;
    autoFocus?: boolean;
    id?: string;
    className?: string;
  }) => (
    <input
      id={id}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      type={type ?? "text"}
      disabled={disabled}
    />
  ),
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: ({
    value,
    onChange,
    placeholder,
    rows,
    className: _c,
  }: {
    value: string;
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    placeholder?: string;
    rows?: number;
    className?: string;
  }) => (
    <textarea
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      rows={rows}
    />
  ),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
    "aria-label": ariaLabel,
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
      disabled={disabled}
      aria-label={ariaLabel}
    />
  ),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => (
    <div role="alert">{children}</div>
  ),
  AlertTitle: ({ children }: { children: React.ReactNode }) => (
    <h5>{children}</h5>
  ),
  AlertDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

// Dialog mock: renders children only when open=true, wires onOpenChange to a
// Close button so Cancel/close flows can be tested without relying on Escape.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
    onOpenChange,
  }: {
    open: boolean;
    children: React.ReactNode;
    onOpenChange?: (v: boolean) => void;
  }) =>
    open ? (
      <div
        data-testid="dialog"
        onClick={(e) => {
          // allow backdrop click via data-backdrop attribute if needed
          if ((e.target as HTMLElement).dataset["backdrop"] && onOpenChange)
            onOpenChange(false);
        }}
      >
        {children}
      </div>
    ) : null,
  DialogPopup: ({
    children,
    className: _c,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div data-testid="dialog-popup">{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogPanel: ({
    children,
    className: _c,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are declared)
// ---------------------------------------------------------------------------

import { EnvironmentsPanel } from "./environments-panel";
import type {
  EnvironmentSummary,
  SecretKeySummary,
  ImportPreviewRow,
} from "./actions";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeEnv(
  overrides: Partial<EnvironmentSummary> = {},
): EnvironmentSummary {
  return {
    id: "env-1",
    name: "Production",
    slug: "production",
    description: null,
    isDefault: true,
    isActive: true,
    ...overrides,
  };
}

function makeKey(overrides: Partial<SecretKeySummary> = {}): SecretKeySummary {
  return {
    id: "key-1",
    key: "DATABASE_URL",
    sensitive: true,
    memo: null,
    hasDefault: true,
    overrideEnvironmentIds: [],
    ...overrides,
  };
}

const PREVIEW_ROWS: ImportPreviewRow[] = [
  {
    key: "NEW_KEY",
    isNewKey: true,
    sensitive: true,
    target: "default",
    willOverride: false,
  },
  {
    key: "LOG_LEVEL",
    isNewKey: false,
    sensitive: false,
    target: "default",
    willOverride: true,
  },
];

function makeDefaultProps(
  overrides: Partial<React.ComponentProps<typeof EnvironmentsPanel>> = {},
) {
  return {
    orgSlug: "acme",
    workspaceSlug: "main",
    canManage: true,
    environments: [makeEnv()],
    secretKeys: [
      makeKey({ id: "key-1", key: "DATABASE_URL" }),
      makeKey({
        id: "key-2",
        key: "LOG_LEVEL",
        sensitive: false,
        hasDefault: false,
      }),
    ],
    importEnvAction: vi.fn(async () => ({
      ok: true as const,
      rows: [],
      committed: false,
    })),
    upsertKeyAction: vi.fn(async () => ({ ok: true as const, id: "key-new" })),
    setValueAction: vi.fn(async () => ({ ok: true as const })),
    unsetValueAction: vi.fn(async () => ({ ok: true as const })),
    deleteKeyAction: vi.fn(async () => ({ ok: true as const })),
    createEnvironmentAction: vi.fn(async () => ({
      ok: true as const,
      environment: makeEnv(),
    })),
    setDefaultEnvironmentAction: vi.fn(async () => ({
      ok: true as const,
      environment: makeEnv(),
    })),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EnvironmentsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // (a) Grid renders secret key names
  it("renders secret key names in the grid", () => {
    render(<EnvironmentsPanel {...makeDefaultProps()} />);
    expect(screen.getByText("DATABASE_URL")).toBeInTheDocument();
    expect(screen.getByText("LOG_LEVEL")).toBeInTheDocument();
  });

  // (b) Environment slugs appear as column headers
  it("renders environment slug as a table column header", () => {
    const props = makeDefaultProps({
      environments: [
        makeEnv({ id: "env-1", slug: "production" }),
        makeEnv({
          id: "env-2",
          name: "Staging",
          slug: "staging",
          isDefault: false,
        }),
      ],
    });
    render(<EnvironmentsPanel {...props} />);
    expect(
      screen.getByRole("columnheader", { name: "production" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "staging" }),
    ).toBeInTheDocument();
  });

  // (b2) The workspace-root value column is "Fallback", so it never collides
  // with an environment whose slug is literally "default".
  it("labels the workspace-root value column 'Fallback', distinct from a default-slugged env", () => {
    const props = makeDefaultProps({
      environments: [
        makeEnv({ id: "env-d", name: "Default", slug: "default" }),
      ],
    });
    render(<EnvironmentsPanel {...props} />);
    expect(
      screen.getByRole("columnheader", { name: "Fallback" }),
    ).toBeInTheDocument();
    // The default environment still gets its own distinct slug header.
    expect(
      screen.getByRole("columnheader", { name: "default" }),
    ).toBeInTheDocument();
    // The old ambiguous capital-D "Default" header is gone.
    expect(
      screen.queryByRole("columnheader", { name: "Default" }),
    ).not.toBeInTheDocument();
  });

  // (c) canManage:false hides management controls
  it("hides 'Paste .env' and '+ Add key' buttons when canManage=false", () => {
    render(<EnvironmentsPanel {...makeDefaultProps({ canManage: false })} />);
    expect(screen.queryByText("Paste .env")).not.toBeInTheDocument();
    expect(screen.queryByText("+ Add key")).not.toBeInTheDocument();
  });

  it("hides 'Delete' button for each key when canManage=false", () => {
    render(<EnvironmentsPanel {...makeDefaultProps({ canManage: false })} />);
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("hides '+ New environment' button when canManage=false", () => {
    render(<EnvironmentsPanel {...makeDefaultProps({ canManage: false })} />);
    expect(screen.queryByText("+ New environment")).not.toBeInTheDocument();
  });

  // (g) The new-environment dialog derives its slug preview from the shared
  // @/lib/slug slugify — non-alphanumerics collapse to single hyphens and
  // edge hyphens are trimmed.
  it("previews the shared-slugify slug when typing a new environment name", () => {
    render(<EnvironmentsPanel {...makeDefaultProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "+ New environment" }));
    const nameInput = document.getElementById("env-name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Proof Env 42!" } });
    expect(screen.getByText("proof-env-42")).toBeInTheDocument();
  });

  // (d) Opening "Paste .env" shows the dialog textarea
  it("clicking 'Paste .env' opens the dialog and shows the textarea", () => {
    render(<EnvironmentsPanel {...makeDefaultProps()} />);
    // Dialog not open yet
    expect(
      screen.queryByText("Paste .env", { selector: "h2" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Paste .env" }));

    // Dialog title appears
    expect(
      screen.getByText("Paste .env", { selector: "h2" }),
    ).toBeInTheDocument();
    // Textarea is rendered
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  // (e) Typing text + clicking Preview calls importEnvAction(commit:false)
  it("clicking 'Preview' calls importEnvAction with commit:false and the entered text", async () => {
    const importEnvAction = vi.fn(async () => ({
      ok: true as const,
      rows: PREVIEW_ROWS,
      committed: false,
    }));

    render(<EnvironmentsPanel {...makeDefaultProps({ importEnvAction })} />);

    // Open dialog
    fireEvent.click(screen.getByRole("button", { name: "Paste .env" }));

    // Type in the textarea
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, {
      target: { value: "NEW_KEY=secret123\nLOG_LEVEL=info" },
    });

    // Click Preview
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    });

    expect(importEnvAction).toHaveBeenCalledWith(
      expect.objectContaining({
        orgSlug: "acme",
        workspaceSlug: "main",
        text: "NEW_KEY=secret123\nLOG_LEVEL=info",
        environmentId: null,
        commit: false,
      }),
    );
  });

  // (f) After preview, clicking "Import N keys" calls importEnvAction(commit:true)
  it("after preview, clicking 'Import N keys' calls importEnvAction with commit:true", async () => {
    // First call (commit:false) returns preview rows; second (commit:true) commits
    const importEnvAction = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, rows: PREVIEW_ROWS, committed: false })
      .mockResolvedValueOnce({ ok: true, rows: PREVIEW_ROWS, committed: true });

    render(<EnvironmentsPanel {...makeDefaultProps({ importEnvAction })} />);

    // Open dialog
    fireEvent.click(screen.getByRole("button", { name: "Paste .env" }));

    // Type .env text
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, {
      target: { value: "NEW_KEY=val\nLOG_LEVEL=debug" },
    });

    // Click Preview — importEnvAction called with commit:false
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    });

    // Wait for preview rows to render and Import button to appear
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Import.*key/i }),
      ).toBeInTheDocument();
    });

    // Click Import
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Import.*key/i }));
    });

    // importEnvAction should have been called twice total
    expect(importEnvAction).toHaveBeenCalledTimes(2);
    // Second call must have commit:true
    expect(importEnvAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        commit: true,
        orgSlug: "acme",
        workspaceSlug: "main",
      }),
    );
  });

  // Edge: Preview button disabled when textarea is empty
  it("'Preview' button is disabled when the textarea is empty", () => {
    render(<EnvironmentsPanel {...makeDefaultProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "Paste .env" }));
    // No text typed — Preview should be disabled
    const previewBtn = screen.getByRole("button", { name: "Preview" });
    expect(previewBtn).toBeDisabled();
  });

  // Edge: empty state message when no secret keys
  it("renders 'No secrets yet' placeholder when secretKeys is empty", () => {
    render(<EnvironmentsPanel {...makeDefaultProps({ secretKeys: [] })} />);
    expect(screen.getByText(/No secrets yet/i)).toBeInTheDocument();
  });

  // Load-error notice: surfaced when the server-side read failed
  it("renders a load-error notice when loadError is true", () => {
    render(<EnvironmentsPanel {...makeDefaultProps({ loadError: true })} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/couldn't load environments/i)).toBeInTheDocument();
  });

  it("does not render a load-error notice when loadError is false/absent", () => {
    render(<EnvironmentsPanel {...makeDefaultProps()} />);
    expect(
      screen.queryByText(/couldn't load environments/i),
    ).not.toBeInTheDocument();
  });

  // Edge: environments bar shows "No environments yet." when empty
  it("renders 'No environments yet.' when environments is empty", () => {
    render(
      <EnvironmentsPanel
        {...makeDefaultProps({ environments: [], secretKeys: [] })}
      />,
    );
    expect(screen.getByText("No environments yet.")).toBeInTheDocument();
  });
});
