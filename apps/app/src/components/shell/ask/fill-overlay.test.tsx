// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import * as React from "react";

type FillResult = {
  fields: Array<{
    name: string;
    changed: boolean;
    current: unknown;
    proposed: unknown;
    reason?: string;
  }>;
  error?: string;
};

const mockSetFillResult = vi.fn();
const mockPageCtx = {
  fillResult: null as FillResult | null,
  fillableForm: null as null | {
    formId: string;
    title: string;
    fields: unknown[];
    apply: ReturnType<typeof vi.fn>;
  },
  _setFillResult: mockSetFillResult,
  isFilling: false,
};

vi.mock("@/lib/page-context", () => ({
  usePageContext: () => mockPageCtx,
}));

vi.mock("@/components/ui/field-fill-transition", () => ({
  FieldFillTransition: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("lucide-react", () => ({
  Check: () => <span />,
  X: () => <span />,
  Sparkles: () => <span />,
  ChevronDown: () => <span />,
  ChevronUp: () => <span />,
}));

import { FillOverlay } from "./fill-overlay";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockPageCtx.fillResult = null;
  mockPageCtx.fillableForm = null;
  mockPageCtx._setFillResult = mockSetFillResult;
  mockPageCtx.isFilling = false;
});

describe("FillOverlay", () => {
  it("renders nothing visible when fillResult=null", () => {
    mockPageCtx.fillResult = null;
    mockPageCtx.isFilling = false;
    const { container } = render(<FillOverlay />);
    // The overlay should not render any visible content
    expect(container.firstChild).toBeNull();
  });

  it("renders 'Filling form…' status when isFilling=true and no fillResult", () => {
    mockPageCtx.fillResult = null;
    mockPageCtx.isFilling = true;
    render(<FillOverlay />);
    expect(screen.getByText("Filling form…")).toBeDefined();
  });

  it("renders changed fields diff when fillResult has changed fields", () => {
    mockPageCtx.fillResult = {
      fields: [
        {
          name: "email",
          changed: true,
          current: "old@example.com",
          proposed: "new@example.com",
        },
      ],
    };
    mockPageCtx.isFilling = false;
    render(<FillOverlay />);
    expect(screen.getByText("email")).toBeDefined();
    expect(screen.getByText("old@example.com")).toBeDefined();
    expect(screen.getByText("new@example.com")).toBeDefined();
  });

  it("Accept field button calls fillableForm.apply", () => {
    const applyMock = vi.fn();
    mockPageCtx.fillableForm = {
      formId: "form-1",
      title: "Test Form",
      fields: [],
      apply: applyMock,
    };
    mockPageCtx.fillResult = {
      fields: [
        {
          name: "email",
          changed: true,
          current: "old@example.com",
          proposed: "new@example.com",
        },
      ],
    };
    mockPageCtx.isFilling = false;
    render(<FillOverlay />);
    const acceptBtn = screen.getByRole("button", {
      name: /accept suggestion for email/i,
    });
    fireEvent.click(acceptBtn);
    expect(applyMock).toHaveBeenCalledWith(
      { email: "new@example.com" },
      "field",
      "email",
    );
  });

  it("Reject all button calls _setFillResult(null)", () => {
    mockPageCtx.fillResult = {
      fields: [
        {
          name: "email",
          changed: true,
          current: "old@example.com",
          proposed: "new@example.com",
        },
      ],
    };
    mockPageCtx.isFilling = false;
    render(<FillOverlay />);
    const rejectAllBtn = screen.getByRole("button", {
      name: /reject all suggestions/i,
    });
    fireEvent.click(rejectAllBtn);
    expect(mockSetFillResult).toHaveBeenCalledWith(null);
  });

  it("Apply all button applies all changed fields", () => {
    const applyMock = vi.fn();
    mockPageCtx.fillableForm = {
      formId: "form-1",
      title: "Test Form",
      fields: [],
      apply: applyMock,
    };
    mockPageCtx.fillResult = {
      fields: [
        {
          name: "email",
          changed: true,
          current: "old@example.com",
          proposed: "new@example.com",
        },
        {
          name: "name",
          changed: true,
          current: "Old Name",
          proposed: "New Name",
        },
      ],
    };
    mockPageCtx.isFilling = false;
    render(<FillOverlay />);
    const applyAllBtn = screen.getByRole("button", {
      name: /apply all suggestions/i,
    });
    fireEvent.click(applyAllBtn);
    expect(applyMock).toHaveBeenCalledWith(
      { email: "new@example.com", name: "New Name" },
      "all",
    );
    expect(mockSetFillResult).toHaveBeenCalledWith(null);
  });
});
