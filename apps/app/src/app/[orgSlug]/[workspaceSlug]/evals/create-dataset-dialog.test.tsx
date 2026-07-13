// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
/**
 * create-dataset-dialog.test.tsx — component tests for CreateDatasetForm.
 *
 * CreateDatasetForm is deliberately split out from the Dialog shell so it can
 * be unit-tested without mounting the Dialog portal machinery.
 *
 * Covers:
 *   (a) Initial render — Manual mode by default, name/description visible,
 *       trace-only fields (lookback window, max items) hidden.
 *   (b) Mode toggle — switching to "From traces" reveals the trace fields.
 *   (c) Manual submit — calls createDatasetAction with name+description,
 *       NOT sinceHours/limit; onCreated + router.refresh() fire on success.
 *   (d) From-traces submit — calls createTraceDatasetAction with the
 *       (default) sinceHours/limit.
 *   (e) Client-side validation — empty name blocks submit before either
 *       action is called.
 *   (f) Error path — action returns ok:false → inline error + toast, form
 *       state (name) preserved, onCreated NOT called.
 *   (g) Submitting state — submit button disabled + relabeled while pending.
 *
 * Mock seam: ./actions (createDatasetAction, createTraceDatasetAction),
 * next/navigation (useRouter), @/components/ui/toast (useToast),
 * @/components/ui/segmented-control, @/components/ui/select — same
 * simplified-stub pattern as preferences-form.test.tsx.
 */

import * as React from "react";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockCreateDatasetAction,
  mockCreateTraceDatasetAction,
  mockAddToast,
  mockRefresh,
} = vi.hoisted(() => ({
  mockCreateDatasetAction: vi.fn(),
  mockCreateTraceDatasetAction: vi.fn(),
  mockAddToast: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock("./actions", () => ({
  createDatasetAction: mockCreateDatasetAction,
  createTraceDatasetAction: mockCreateTraceDatasetAction,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

vi.mock("@/components/ui/segmented-control", () => ({
  SegmentedControl: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (v: string) => void;
  }) => (
    <div role="group" data-value={value}>
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child;
        const { value: itemValue, children: itemChildren } = child.props as {
          value: string;
          children: React.ReactNode;
        };
        return (
          <button
            type="button"
            role="radio"
            aria-checked={value === itemValue}
            onClick={() => onValueChange(itemValue)}
          >
            {itemChildren}
          </button>
        );
      })}
    </div>
  ),
  SegmentedControlItem: ({
    children,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <>{children}</>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (v: string | null) => void;
  }) => (
    <div data-testid="select-root" data-value={value}>
      {children}
    </div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: React.ReactNode; value: string }) => (
    <div>{children}</div>
  ),
}));

import { CreateDatasetForm } from "./create-dataset-dialog";

const PROPS = { orgSlug: "acme", workspaceSlug: "research" };

describe("CreateDatasetForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // ---------------------------------------------------------------------------
  // (a) Initial render
  // ---------------------------------------------------------------------------

  it("renders in Manual mode by default with name/description visible", () => {
    render(<CreateDatasetForm {...PROPS} onCreated={vi.fn()} />);

    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
    expect(screen.queryByLabelText("Lookback window")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Max items")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("evals-create-manual-submit"),
    ).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // (b) Mode toggle
  // ---------------------------------------------------------------------------

  it("reveals lookback window + max items when switching to From traces", () => {
    render(<CreateDatasetForm {...PROPS} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("radio", { name: "From traces" }));

    expect(screen.getByText("Lookback window")).toBeInTheDocument();
    expect(screen.getByLabelText("Max items")).toBeInTheDocument();
    expect(
      screen.getByTestId("evals-create-traces-submit"),
    ).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // (c) Manual submit
  // ---------------------------------------------------------------------------

  it("submits manual mode via createDatasetAction with name+description only", async () => {
    mockCreateDatasetAction.mockResolvedValue({
      ok: true,
      datasetId: "id-1",
      publicId: "evd_1",
      slug: "smoke",
    });
    const onCreated = vi.fn();

    render(<CreateDatasetForm {...PROPS} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Smoke dataset" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "desc" },
    });
    fireEvent.click(screen.getByTestId("evals-create-manual-submit"));

    await waitFor(() => expect(mockCreateDatasetAction).toHaveBeenCalledOnce());

    expect(mockCreateDatasetAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "research",
      name: "Smoke dataset",
      description: "desc",
    });
    expect(mockCreateTraceDatasetAction).not.toHaveBeenCalled();

    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(mockRefresh).toHaveBeenCalledOnce();
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Dataset created" }),
    );
  });

  // ---------------------------------------------------------------------------
  // (d) From-traces submit
  // ---------------------------------------------------------------------------

  it("submits From-traces mode via createTraceDatasetAction with sinceHours/limit", async () => {
    mockCreateTraceDatasetAction.mockResolvedValue({
      ok: true,
      datasetId: "id-2",
      publicId: "evd_2",
      slug: "from-traces",
      itemCount: 10,
    });

    render(<CreateDatasetForm {...PROPS} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("radio", { name: "From traces" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Recent traces" },
    });
    fireEvent.click(screen.getByTestId("evals-create-traces-submit"));

    await waitFor(() =>
      expect(mockCreateTraceDatasetAction).toHaveBeenCalledOnce(),
    );

    expect(mockCreateTraceDatasetAction).toHaveBeenCalledWith(
      expect.objectContaining({
        orgSlug: "acme",
        workspaceSlug: "research",
        name: "Recent traces",
        sinceHours: 168,
        limit: 50,
      }),
    );
    expect(mockCreateDatasetAction).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // (e) Client-side validation
  // ---------------------------------------------------------------------------

  it("blocks submit with an inline error when name is empty", async () => {
    render(<CreateDatasetForm {...PROPS} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByTestId("evals-create-manual-submit"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /name is required/i,
    );
    expect(mockCreateDatasetAction).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // (f) Error path
  // ---------------------------------------------------------------------------

  it("shows an inline error and toast when the action returns ok:false, preserving form state", async () => {
    mockCreateDatasetAction.mockResolvedValue({
      ok: false,
      error: "Slug already taken",
    });
    const onCreated = vi.fn();

    render(<CreateDatasetForm {...PROPS} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Dup" },
    });
    fireEvent.click(screen.getByTestId("evals-create-manual-submit"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Slug already taken",
    );
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to create dataset" }),
    );
    expect(onCreated).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
    // Form state preserved — name input still has the typed value.
    expect(screen.getByLabelText("Name")).toHaveValue("Dup");
  });

  // ---------------------------------------------------------------------------
  // (g) Submitting state
  // ---------------------------------------------------------------------------

  it("disables the submit button and relabels it while saving", async () => {
    let resolve!: (v: { ok: boolean }) => void;
    mockCreateDatasetAction.mockReturnValue(
      new Promise<{ ok: boolean }>((r) => {
        resolve = r;
      }),
    );

    render(<CreateDatasetForm {...PROPS} onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Pending" },
    });
    fireEvent.click(screen.getByTestId("evals-create-manual-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("evals-create-manual-submit")).toBeDisabled();
      expect(
        screen.getByTestId("evals-create-manual-submit"),
      ).toHaveTextContent(/creating/i);
    });

    resolve({ ok: true });
    await waitFor(() =>
      expect(
        screen.getByTestId("evals-create-manual-submit"),
      ).not.toBeDisabled(),
    );
  });
});
