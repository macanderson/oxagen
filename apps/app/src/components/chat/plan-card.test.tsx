// @vitest-environment jsdom
/**
 * plan-card.test.tsx
 *
 * Render + interaction tests for PlanCard:
 *   - Renders plan title
 *   - Renders step summaries
 *   - Renders Approve and Deny buttons when status=pending
 *   - Shows the approved status text when status=approved
 *   - Shows rationale when opened
 *   - Shows error message when onResolve fails
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

// Mock dnd-kit
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  closestCenter: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock("@dnd-kit/modifiers", () => ({
  restrictToVerticalAxis: vi.fn(),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  verticalListSortingStrategy: vi.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  arrayMove: (arr: unknown[], from: number, to: number) => {
    const result = [...arr] as typeof arr;
    result.splice(to, 0, result.splice(from, 1)[0]);
    return result;
  },
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
    variant,
    "aria-busy": ariaBusy,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: string;
    variant?: string;
    "aria-busy"?: boolean;
  }) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      onClick={onClick}
      disabled={disabled}
      aria-busy={ariaBusy}
      data-variant={variant}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  MenuGroupLabel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  MenuTrigger: ({ render: renderProp }: { render?: React.ReactElement }) =>
    renderProp ?? null,
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    ChevronDown: vi.fn(() => <span />),
    ChevronRight: vi.fn(() => <span />),
    GripVertical: vi.fn(() => <span />),
    ListChecks: vi.fn(() => <span />),
    MoveRight: vi.fn(() => <span />),
    Plus: vi.fn(() => <span />),
    Trash2: vi.fn(() => <span />),
    AlertTriangle: vi.fn(() => <span />),
  };
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

const BASE_STEPS = [
  {
    id: "s1",
    summary: "Load data",
    intent: "Load CSV",
    capability: "files.read",
    dependsOn: [],
  },
  {
    id: "s2",
    summary: "Clean data",
    intent: "Remove nulls",
    capability: "code.run",
    dependsOn: ["s1"],
  },
];

describe("PlanCard", () => {
  it("renders plan title", async () => {
    const { PlanCard } = await import("./plan-card");
    render(
      <PlanCard
        planId="plan_1"
        title="Data Pipeline"
        steps={BASE_STEPS}
        status="pending"
      />,
    );
    expect(screen.getByText("Data Pipeline")).toBeInTheDocument();
  });

  it("renders step summaries", async () => {
    const { PlanCard } = await import("./plan-card");
    render(
      <PlanCard
        planId="plan_1"
        title="Data Pipeline"
        steps={BASE_STEPS}
        status="pending"
      />,
    );
    expect(screen.getByText("Load data")).toBeInTheDocument();
    expect(screen.getByText("Clean data")).toBeInTheDocument();
  });

  it("renders Approve and Deny buttons when status=pending", async () => {
    const { PlanCard } = await import("./plan-card");
    render(
      <PlanCard
        planId="plan_1"
        title="Plan"
        steps={BASE_STEPS}
        status="pending"
        onResolve={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Approve/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Deny/ })).toBeInTheDocument();
  });

  it("renders the 'approved' status text when status=approved", async () => {
    const { PlanCard } = await import("./plan-card");
    render(
      <PlanCard
        planId="plan_1"
        title="Plan"
        steps={BASE_STEPS}
        status="approved"
      />,
    );
    const status = screen.getByText("approved");
    expect(status).toBeInTheDocument();
    expect(status.className).toContain("text-muted-foreground");
  });

  it("renders rationale toggle button when rationale is provided", async () => {
    const { PlanCard } = await import("./plan-card");
    render(
      <PlanCard
        planId="plan_1"
        title="Plan"
        steps={BASE_STEPS}
        status="pending"
        rationale="This plan maximizes efficiency."
      />,
    );
    expect(
      screen.getByRole("button", { name: /Rationale|Reasoning/i }),
    ).toBeInTheDocument();
  });

  it("shows error when onResolve fails", async () => {
    const { PlanCard } = await import("./plan-card");
    const onResolve = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "Not authorized" });
    render(
      <PlanCard
        planId="plan_1"
        title="Plan"
        steps={BASE_STEPS}
        status="pending"
        onResolve={onResolve}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Approve/ }));
    await waitFor(() => {
      // Error is rendered in a plain <p> element (not role=alert)
      expect(screen.getByText("Not authorized")).toBeInTheDocument();
    });
  });

  it("calls onResolve with 'denied' when Deny is clicked", async () => {
    const { PlanCard } = await import("./plan-card");
    const onResolve = vi.fn().mockResolvedValue({ ok: true });
    render(
      <PlanCard
        planId="plan_1"
        title="Plan"
        steps={BASE_STEPS}
        status="pending"
        onResolve={onResolve}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Deny/ }));
    await waitFor(() => {
      expect(onResolve).toHaveBeenCalledWith("plan_1", "denied", undefined);
    });
  });
});
