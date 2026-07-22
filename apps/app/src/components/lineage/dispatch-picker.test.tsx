// @vitest-environment jsdom
/**
 * dispatch-picker.test.tsx — render tests for the "pick a dispatch" surface.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DispatchPicker } from "./dispatch-picker";

afterEach(cleanup);

const CTX = { orgSlug: "acme", workspaceSlug: "core" };

describe("DispatchPicker", () => {
  it("always renders the paste-a-dispatch-id form, even with zero recent dispatches", () => {
    render(<DispatchPicker ctx={CTX} fanouts={[]} />);
    expect(screen.getByTestId("dispatch-id-input")).toBeInTheDocument();
    expect(screen.getByTestId("dispatch-id-submit")).toBeInTheDocument();
  });

  it("shows an explanatory empty state when there are no recent dispatches", () => {
    render(<DispatchPicker ctx={CTX} fanouts={[]} />);
    expect(screen.getByText(/no fleet dispatches yet/i)).toBeInTheDocument();
  });

  it("lists recent dispatches as links to ?dispatchId=<id>", () => {
    render(
      <DispatchPicker
        ctx={CTX}
        fanouts={[
          {
            fanoutId: "sfo_abc123",
            parentMessageId: "msg_1",
            status: "completed",
            totalChildren: 3,
            completedChildren: 3,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:05:00.000Z",
          },
        ]}
      />,
    );
    const link = screen.getByTestId("recent-dispatch-sfo_abc123");
    expect(link).toHaveAttribute(
      "href",
      "/acme/core/automations/lineage?dispatchId=sfo_abc123",
    );
    expect(link).toHaveTextContent("completed");
    expect(link).toHaveTextContent("3/3 children");
  });

  it("shows a not-found banner naming the id that failed to resolve", () => {
    render(<DispatchPicker ctx={CTX} fanouts={[]} notFoundId="sfo_missing" />);
    expect(screen.getByRole("alert")).toHaveTextContent("sfo_missing");
  });

  it("shows the REAL error message (e.g. a permission denial) instead of a generic not-found copy when provided", () => {
    render(
      <DispatchPicker
        ctx={CTX}
        fanouts={[]}
        notFoundId="sfo_denied"
        errorMessage="You must be a workspace member to view fleet lineage."
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You must be a workspace member to view fleet lineage.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "Couldn’t find a dispatch",
    );
  });

  it("the paste-id form submits GET to the lineage route", () => {
    render(<DispatchPicker ctx={CTX} fanouts={[]} />);
    const form = screen.getByTestId("dispatch-id-input").closest("form");
    expect(form).toHaveAttribute("action", "/acme/core/automations/lineage");
    expect(form).toHaveAttribute("method", "GET");
    expect(screen.getByTestId("dispatch-id-input")).toHaveAttribute(
      "name",
      "dispatchId",
    );
  });
});
