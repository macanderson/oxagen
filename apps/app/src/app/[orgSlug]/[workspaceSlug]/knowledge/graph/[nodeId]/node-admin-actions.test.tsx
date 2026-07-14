// @vitest-environment jsdom
/**
 * node-admin-actions.test.tsx — interaction tests for the node-detail admin
 * panel: labels add/remove, relationship add/remove (with client-side
 * validation), and the delete-node two-step confirm + post-delete navigation.
 */

import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

import { NodeAdminActions } from "./node-admin-actions";

afterEach(cleanup);
beforeEach(() => {
  mockPush.mockReset();
});

const BASE_PROPS = {
  orgSlug: "acme",
  workspaceSlug: "main",
  nodeId: "kn_1",
};

describe("NodeAdminActions", () => {
  it("renders the admin actions heading and current labels", () => {
    render(
      <NodeAdminActions
        {...BASE_PROPS}
        initialLabels={["Billing"]}
        deleteNode={vi.fn()}
        addNodeLabel={vi.fn()}
        removeNodeLabel={vi.fn()}
        upsertEdge={vi.fn()}
        deleteEdge={vi.fn()}
      />,
    );
    expect(screen.getByText("Admin actions")).toBeInTheDocument();
    expect(screen.getByText("Billing")).toBeInTheDocument();
  });

  it("shows 'No extra labels.' when there are none", () => {
    render(
      <NodeAdminActions
        {...BASE_PROPS}
        initialLabels={[]}
        deleteNode={vi.fn()}
        addNodeLabel={vi.fn()}
        removeNodeLabel={vi.fn()}
        upsertEdge={vi.fn()}
        deleteEdge={vi.fn()}
      />,
    );
    expect(screen.getByText("No extra labels.")).toBeInTheDocument();
  });

  it("adds a label via addNodeLabel and updates the displayed set on success", async () => {
    const addNodeLabel = vi.fn().mockResolvedValue({ ok: true, labels: ["Billing"], added: ["Billing"] });
    render(
      <NodeAdminActions
        {...BASE_PROPS}
        initialLabels={[]}
        deleteNode={vi.fn()}
        addNodeLabel={addNodeLabel}
        removeNodeLabel={vi.fn()}
        upsertEdge={vi.fn()}
        deleteEdge={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("New label"), { target: { value: "Billing" } });
    fireEvent.click(screen.getByRole("button", { name: /add label/i }));

    await waitFor(() => {
      expect(addNodeLabel).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        nodeId: "kn_1",
        labels: ["Billing"],
      });
    });
    await waitFor(() => expect(screen.getByText("Billing")).toBeInTheDocument());
  });

  it("shows a client-side validation error for an invalid label without calling the action", async () => {
    const addNodeLabel = vi.fn();
    render(
      <NodeAdminActions
        {...BASE_PROPS}
        initialLabels={[]}
        deleteNode={vi.fn()}
        addNodeLabel={addNodeLabel}
        removeNodeLabel={vi.fn()}
        upsertEdge={vi.fn()}
        deleteEdge={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("New label"), { target: { value: "1bad" } });
    fireEvent.click(screen.getByRole("button", { name: /add label/i }));

    expect(
      await screen.findByText(/must start with a letter/i),
    ).toBeInTheDocument();
    expect(addNodeLabel).not.toHaveBeenCalled();
  });

  it("removes a label via removeNodeLabel", async () => {
    const removeNodeLabel = vi.fn().mockResolvedValue({ ok: true, labels: [], removed: ["Billing"] });
    render(
      <NodeAdminActions
        {...BASE_PROPS}
        initialLabels={["Billing"]}
        deleteNode={vi.fn()}
        addNodeLabel={vi.fn()}
        removeNodeLabel={removeNodeLabel}
        upsertEdge={vi.fn()}
        deleteEdge={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove label Billing" }));

    await waitFor(() => {
      expect(removeNodeLabel).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        nodeId: "kn_1",
        labels: ["Billing"],
      });
    });
    await waitFor(() => expect(screen.getByText("No extra labels.")).toBeInTheDocument());
  });

  it("validates the relationship form before calling upsertEdge", async () => {
    const upsertEdge = vi.fn();
    render(
      <NodeAdminActions
        {...BASE_PROPS}
        initialLabels={[]}
        deleteNode={vi.fn()}
        addNodeLabel={vi.fn()}
        removeNodeLabel={vi.fn()}
        upsertEdge={upsertEdge}
        deleteEdge={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /add relationship/i }));
    expect(await screen.findByText(/target node id is required/i)).toBeInTheDocument();
    expect(upsertEdge).not.toHaveBeenCalled();
  });

  it("adds a relationship via upsertEdge on valid input", async () => {
    const upsertEdge = vi.fn().mockResolvedValue({
      ok: true,
      edgeId: "kn_1:RELATES_TO:kn_2",
      created: true,
      superseded: 0,
    });
    render(
      <NodeAdminActions
        {...BASE_PROPS}
        initialLabels={[]}
        deleteNode={vi.fn()}
        addNodeLabel={vi.fn()}
        removeNodeLabel={vi.fn()}
        upsertEdge={upsertEdge}
        deleteEdge={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Target node id"), { target: { value: "kn_2" } });
    fireEvent.change(screen.getByLabelText("Relationship type"), { target: { value: "relates_to" } });
    fireEvent.click(screen.getByRole("button", { name: /add relationship/i }));

    await waitFor(() => {
      expect(upsertEdge).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        fromNodeId: "kn_1",
        toNodeId: "kn_2",
        // Input is uppercased as the user types.
        relationshipType: "RELATES_TO",
      });
    });
    expect(await screen.findByText("Relationship added.")).toBeInTheDocument();
  });

  it("removes a relationship via deleteEdge", async () => {
    const deleteEdge = vi.fn().mockResolvedValue({ ok: true, deleted: true });
    render(
      <NodeAdminActions
        {...BASE_PROPS}
        initialLabels={[]}
        deleteNode={vi.fn()}
        addNodeLabel={vi.fn()}
        removeNodeLabel={vi.fn()}
        upsertEdge={vi.fn()}
        deleteEdge={deleteEdge}
      />,
    );

    fireEvent.change(screen.getByLabelText("Target node id"), { target: { value: "kn_2" } });
    fireEvent.change(screen.getByLabelText("Relationship type"), { target: { value: "RELATES_TO" } });
    fireEvent.click(screen.getByRole("button", { name: /remove relationship/i }));

    await waitFor(() => {
      expect(deleteEdge).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceSlug: "main",
        fromNodeId: "kn_1",
        toNodeId: "kn_2",
        edgeType: "RELATES_TO",
      });
    });
    expect(await screen.findByText("Relationship removed.")).toBeInTheDocument();
  });

  it("requires a two-step confirm before deleting the node, and navigates to Graph on success", async () => {
    const deleteNode = vi.fn().mockResolvedValue({ ok: true, deleted: true });
    render(
      <NodeAdminActions
        {...BASE_PROPS}
        initialLabels={[]}
        deleteNode={deleteNode}
        addNodeLabel={vi.fn()}
        removeNodeLabel={vi.fn()}
        upsertEdge={vi.fn()}
        deleteEdge={vi.fn()}
      />,
    );

    // First click only reveals the confirm step — no action call yet.
    fireEvent.click(screen.getByRole("button", { name: /delete node/i }));
    expect(deleteNode).not.toHaveBeenCalled();
    expect(screen.getByText("Delete this node permanently?")).toBeInTheDocument();

    // Cancel returns to the initial state.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Delete this node permanently?")).toBeNull();

    // Confirm flow: click delete again, then confirm.
    fireEvent.click(screen.getByRole("button", { name: /delete node/i }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete node" }));

    await waitFor(() => {
      expect(deleteNode).toHaveBeenCalledWith({ orgSlug: "acme", workspaceSlug: "main", nodeId: "kn_1" });
    });
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/acme/main/knowledge/graph");
    });
  });

  it("shows the error and resets confirm state when deleteNode fails", async () => {
    const deleteNode = vi.fn().mockResolvedValue({ ok: false, error: "Cannot delete: still referenced." });
    render(
      <NodeAdminActions
        {...BASE_PROPS}
        initialLabels={[]}
        deleteNode={deleteNode}
        addNodeLabel={vi.fn()}
        removeNodeLabel={vi.fn()}
        upsertEdge={vi.fn()}
        deleteEdge={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /delete node/i }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete node" }));

    expect(await screen.findByText("Cannot delete: still referenced.")).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
