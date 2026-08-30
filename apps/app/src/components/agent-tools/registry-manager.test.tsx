// @vitest-environment jsdom
/**
 * registry-manager.test.tsx — component tests for RegistryManager.
 *
 * Covers:
 *   - Renders the registry list with Default badge on the default entry.
 *   - Hides the remove button when exactly one registry exists (single-default rule).
 *   - Calls addRegistryAction and appends the new row on success.
 *   - Calls removeRegistryAction on confirm and removes the row from the list.
 *   - When the removed registry was default and promotedId is returned, the
 *     promoted registry receives the Default badge.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RegistryManager, type RegistryRow } from "./registry-manager";

// Stub window.confirm — vitest/jsdom doesn't have it wired to resolve true.
vi.stubGlobal(
  "confirm",
  vi.fn(() => true),
);

// Stub @/components/ui/popover — keep test scope lightweight.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <button data-testid="popover-trigger">{children}</button>
  ),
  PopoverPopup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-popup">{children}</div>
  ),
}));

const DOCS_BASE = "https://docs.example.com";

function makeRegistry(over: Partial<RegistryRow> = {}): RegistryRow {
  return {
    id: "reg_1",
    name: "MCP Official",
    baseUrl: "https://registry.modelcontextprotocol.io",
    enabled: true,
    isDefault: true,
    ...over,
  };
}

function noopAdd(): Promise<{ ok: boolean }> {
  return Promise.resolve({ ok: true });
}
function noopRemove(): Promise<{ ok: boolean; promotedId: null }> {
  return Promise.resolve({ ok: true, promotedId: null });
}

afterEach(() => cleanup());

describe("RegistryManager — list rendering", () => {
  it("renders each registry row with its name", () => {
    const regs = [
      makeRegistry({ id: "r1", name: "Registry A", isDefault: true }),
      makeRegistry({ id: "r2", name: "Registry B", isDefault: false }),
    ];
    render(
      <RegistryManager
        orgSlug="acme"
        workspaceSlug="prod"
        initialRegistries={regs}
        docsBaseUrl={DOCS_BASE}
        addRegistryAction={noopAdd}
        removeRegistryAction={noopRemove}
      />,
    );
    expect(screen.getByTestId("registry-row-r1")).toBeInTheDocument();
    expect(screen.getByTestId("registry-row-r2")).toBeInTheDocument();
    expect(screen.getByTestId("registry-default-badge-r1")).toBeInTheDocument();
    expect(
      screen.queryByTestId("registry-default-badge-r2"),
    ).not.toBeInTheDocument();
  });

  it("shows empty state when no registries", () => {
    render(
      <RegistryManager
        orgSlug="acme"
        workspaceSlug="prod"
        initialRegistries={[]}
        docsBaseUrl={DOCS_BASE}
        addRegistryAction={noopAdd}
        removeRegistryAction={noopRemove}
      />,
    );
    expect(screen.getByText(/no registries configured/i)).toBeInTheDocument();
  });
});

describe("RegistryManager — single-default rule", () => {
  it("hides remove button when exactly one registry exists", () => {
    render(
      <RegistryManager
        orgSlug="acme"
        workspaceSlug="prod"
        initialRegistries={[makeRegistry({ id: "r1" })]}
        docsBaseUrl={DOCS_BASE}
        addRegistryAction={noopAdd}
        removeRegistryAction={noopRemove}
      />,
    );
    expect(
      screen.queryByTestId("registry-remove-btn-r1"),
    ).not.toBeInTheDocument();
  });

  it("shows remove buttons when more than one registry exists", () => {
    render(
      <RegistryManager
        orgSlug="acme"
        workspaceSlug="prod"
        initialRegistries={[
          makeRegistry({ id: "r1", isDefault: true }),
          makeRegistry({ id: "r2", isDefault: false }),
        ]}
        docsBaseUrl={DOCS_BASE}
        addRegistryAction={noopAdd}
        removeRegistryAction={noopRemove}
      />,
    );
    expect(screen.getByTestId("registry-remove-btn-r1")).toBeInTheDocument();
    expect(screen.getByTestId("registry-remove-btn-r2")).toBeInTheDocument();
  });
});

describe("RegistryManager — add registry", () => {
  it("calls addRegistryAction and appends the new row", async () => {
    const addAction = vi.fn().mockResolvedValue({
      ok: true,
      registryId: "new_reg",
      isDefault: false,
    });
    // This is the typing-heaviest case (an 11-char name + a 31-char URL). The
    // default userEvent inter-keystroke delay is a real timer whose wall-clock
    // cost balloons under a saturated `pnpm gate` runner — it timed out at 5s
    // there while passing in ~300ms in isolation. `delay: null` removes the
    // artificial pacing so typing cost no longer scales with machine load; the
    // generous per-test deadline below is belt-and-suspenders against event-loop
    // starvation between the awaited interactions.
    const user = userEvent.setup({ delay: null });

    render(
      <RegistryManager
        orgSlug="acme"
        workspaceSlug="prod"
        initialRegistries={[makeRegistry({ id: "r1" })]}
        docsBaseUrl={DOCS_BASE}
        addRegistryAction={addAction}
        removeRegistryAction={noopRemove}
      />,
    );

    await user.click(screen.getByTestId("add-registry-btn"));
    await user.type(screen.getByTestId("registry-name-input"), "My Registry");
    await user.type(
      screen.getByTestId("registry-url-input"),
      "https://my-registry.example.com",
    );
    await user.click(screen.getByTestId("registry-submit-btn"));

    await waitFor(() =>
      expect(addAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "prod",
        name: "My Registry",
        baseUrl: "https://my-registry.example.com",
      }),
    );

    // After success the form closes and the new row appears
    await waitFor(() =>
      expect(
        screen.queryByTestId("registry-name-input"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("My Registry")).toBeInTheDocument();
  }, 20000);

  it("shows an error when addRegistryAction fails", async () => {
    const addAction = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "URL already exists" });
    const user = userEvent.setup();

    render(
      <RegistryManager
        orgSlug="acme"
        workspaceSlug="prod"
        initialRegistries={[]}
        docsBaseUrl={DOCS_BASE}
        addRegistryAction={addAction}
        removeRegistryAction={noopRemove}
      />,
    );

    await user.click(screen.getByTestId("add-registry-btn"));
    await user.type(screen.getByTestId("registry-name-input"), "Dup");
    await user.type(
      screen.getByTestId("registry-url-input"),
      "https://dup.example.com",
    );
    await user.click(screen.getByTestId("registry-submit-btn"));

    await waitFor(() =>
      expect(screen.getByText("URL already exists")).toBeInTheDocument(),
    );
  });
});

describe("RegistryManager — remove registry", () => {
  it("calls removeRegistryAction and removes the row on success", async () => {
    const removeAction = vi
      .fn()
      .mockResolvedValue({ ok: true, promotedId: null });
    const user = userEvent.setup();

    render(
      <RegistryManager
        orgSlug="acme"
        workspaceSlug="prod"
        initialRegistries={[
          makeRegistry({ id: "r1", name: "A", isDefault: true }),
          makeRegistry({ id: "r2", name: "B", isDefault: false }),
        ]}
        docsBaseUrl={DOCS_BASE}
        addRegistryAction={noopAdd}
        removeRegistryAction={removeAction}
      />,
    );

    await user.click(screen.getByTestId("registry-remove-btn-r2"));
    await waitFor(() =>
      expect(removeAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "prod",
        registryId: "r2",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("registry-row-r2")).not.toBeInTheDocument(),
    );
  });

  it("promotes the new default when removeRegistryAction returns promotedId", async () => {
    const removeAction = vi
      .fn()
      .mockResolvedValue({ ok: true, promotedId: "r2" });
    const user = userEvent.setup();

    render(
      <RegistryManager
        orgSlug="acme"
        workspaceSlug="prod"
        initialRegistries={[
          makeRegistry({ id: "r1", name: "Default Reg", isDefault: true }),
          makeRegistry({ id: "r2", name: "Other Reg", isDefault: false }),
        ]}
        docsBaseUrl={DOCS_BASE}
        addRegistryAction={noopAdd}
        removeRegistryAction={removeAction}
      />,
    );

    await user.click(screen.getByTestId("registry-remove-btn-r1"));
    await waitFor(() =>
      expect(screen.queryByTestId("registry-row-r1")).not.toBeInTheDocument(),
    );
    // r2 should now have the Default badge
    await waitFor(() =>
      expect(
        screen.getByTestId("registry-default-badge-r2"),
      ).toBeInTheDocument(),
    );
  });
});
