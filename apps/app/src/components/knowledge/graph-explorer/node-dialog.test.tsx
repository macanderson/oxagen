// @vitest-environment jsdom
/**
 * node-dialog.test.tsx — render + interaction tests for the merged NodeDialog
 * (create mode when `node` is omitted, edit mode when `node` is passed).
 *
 * Covers, for both modes: title/description/button copy, initial field
 * state (empty vs pre-filled from `node`, including the properties list),
 * submit-disabled gating, the upsertNode payload shape submitted, which
 * value the result callback fires with, and the error state.
 */

import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NodeDialog } from "./node-dialog";
import { upsertNode } from "./api-client";
import type { ExplorerNode } from "./types";

afterEach(cleanup);

vi.mock("./api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api-client")>();
  return { ...actual, upsertNode: vi.fn() };
});

// Dialog renders through Base UI portal machinery jsdom can't drive — a
// minimal open-gate keeps the assertions about what content is mounted.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
  }: {
    children?: React.ReactNode;
    open?: boolean;
  }) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogPopup: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children?: React.ReactNode }) => (
    <h2 data-testid="dialog-title">{children}</h2>
  ),
  DialogDescription: ({ children }: { children?: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogPanel: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

// Combobox opens through positioner/portal machinery jsdom can't exercise —
// expose the controlled `value` on the wrapper so pre-fill can be asserted
// without driving the real popup.
vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({
    value,
    children,
  }: {
    value?: string | null;
    children?: React.ReactNode;
  }) => (
    <div data-testid="label-combobox" data-value={value ?? ""}>
      {children}
    </div>
  ),
  ComboboxTrigger: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ComboboxValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
  ComboboxPopup: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ComboboxItem: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const mockUpsertNode = vi.mocked(upsertNode);
const tenant = { orgSlug: "acme", workspaceSlug: "main" };

const sampleNode: ExplorerNode = {
  id: "n1",
  label: "Issue",
  displayName: "Bug #42",
  description: "A tricky one",
  properties: { priority: "high", displayName: "Bug #42", publicId: "n1" },
  degree: 2,
  hydrated: true,
};

beforeEach(() => {
  mockUpsertNode.mockReset();
});

describe("NodeDialog — create mode (no `node` prop) — initial state", () => {
  it("shows the create title and description", () => {
    render(
      <NodeDialog
        open
        onOpenChange={vi.fn()}
        tenant={tenant}
        labels={["Issue", "Topic"]}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByTestId("dialog-title")).toHaveTextContent("Create node");
    expect(
      screen.getByText("Add a new entity to the knowledge graph."),
    ).toBeInTheDocument();
  });

  it("renders empty fields and no property rows", () => {
    render(
      <NodeDialog
        open
        onOpenChange={vi.fn()}
        tenant={tenant}
        labels={["Issue"]}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Custom label")).toHaveValue("");
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.getByLabelText("Description (optional)")).toHaveValue("");
    expect(screen.getByTestId("label-combobox")).toHaveAttribute(
      "data-value",
      "",
    );
    expect(screen.queryByLabelText(/property key/i)).not.toBeInTheDocument();
  });

  it("disables submit until label and name are filled", () => {
    render(
      <NodeDialog
        open
        onOpenChange={vi.fn()}
        tenant={tenant}
        labels={["Issue"]}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Create node" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Custom label"), {
      target: { value: "Person" },
    });
    expect(screen.getByRole("button", { name: "Create node" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Alice" },
    });
    expect(screen.getByRole("button", { name: "Create node" })).toBeEnabled();
  });
});

describe("NodeDialog — create mode — submit", () => {
  it("submits the entered values and fires onSaved with the result nodeId", async () => {
    mockUpsertNode.mockResolvedValue({ nodeId: "new-id-123", created: true });
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <NodeDialog
        open
        onOpenChange={onOpenChange}
        tenant={tenant}
        labels={["Issue"]}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByLabelText("Custom label"), {
      target: { value: "Person" },
    });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Alice" },
    });
    fireEvent.click(screen.getByText("Add"));
    fireEvent.change(screen.getByLabelText("Property key 1"), {
      target: { value: "role" },
    });
    fireEvent.change(screen.getByLabelText("Property value 1"), {
      target: { value: "engineer" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create node" }));

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith("new-id-123"));
    expect(mockUpsertNode).toHaveBeenCalledWith(tenant, {
      label: "Person",
      displayName: "Alice",
      properties: { role: "engineer" },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the default 'create' error message when upsertNode rejects", async () => {
    mockUpsertNode.mockRejectedValue(new Error("boom"));
    render(
      <NodeDialog
        open
        onOpenChange={vi.fn()}
        tenant={tenant}
        labels={["Issue"]}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Custom label"), {
      target: { value: "Person" },
    });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Alice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create node" }));

    expect(await screen.findByText("boom")).toBeInTheDocument();
  });
});

describe("NodeDialog — edit mode (`node` passed) — initial state", () => {
  it("shows the edit title and description naming the node", () => {
    render(
      <NodeDialog
        open
        onOpenChange={vi.fn()}
        tenant={tenant}
        node={sampleNode}
        labels={["Issue", "Topic"]}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByTestId("dialog-title")).toHaveTextContent("Edit node");
    expect(screen.getByText(/Update the properties of/)).toHaveTextContent(
      "Update the properties of “Bug #42”.",
    );
  });

  it("pre-fills name, description, label, and property rows from the node", () => {
    render(
      <NodeDialog
        open
        onOpenChange={vi.fn()}
        tenant={tenant}
        node={sampleNode}
        labels={["Issue", "Topic"]}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Name")).toHaveValue("Bug #42");
    expect(screen.getByLabelText("Description")).toHaveValue("A tricky one");
    expect(screen.getByTestId("label-combobox")).toHaveAttribute(
      "data-value",
      "Issue",
    );
    // propsToRows excludes displayName/publicId — only "priority" should show.
    expect(screen.getByLabelText("Property key 1")).toHaveValue("priority");
    expect(screen.getByLabelText("Property value 1")).toHaveValue("high");
    expect(screen.queryByLabelText("Property key 2")).not.toBeInTheDocument();
  });

  it("starts with submit enabled (pre-filled) and disables it when name is cleared", () => {
    render(
      <NodeDialog
        open
        onOpenChange={vi.fn()}
        tenant={tenant}
        node={sampleNode}
        labels={["Issue"]}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });
});

describe("NodeDialog — edit mode — submit", () => {
  it("submits with externalId pinned to the node's id and fires onSaved with node.id (not the server's returned id)", async () => {
    // Return a DIFFERENT nodeId than sampleNode.id to prove the callback uses
    // the node's own id, not whatever upsertNode's response happens to say.
    mockUpsertNode.mockResolvedValue({
      nodeId: "server-returned-id",
      created: false,
    });
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <NodeDialog
        open
        onOpenChange={onOpenChange}
        tenant={tenant}
        node={sampleNode}
        labels={["Issue"]}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Bug #42 (updated)" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith("n1"));
    expect(mockUpsertNode).toHaveBeenCalledWith(tenant, {
      label: "Issue",
      displayName: "Bug #42 (updated)",
      description: "A tricky one",
      properties: { priority: "high" },
      externalId: "n1",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the default 'update' error message when upsertNode rejects", async () => {
    mockUpsertNode.mockRejectedValue(new Error("boom"));
    render(
      <NodeDialog
        open
        onOpenChange={vi.fn()}
        tenant={tenant}
        node={sampleNode}
        labels={["Issue"]}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });
});
