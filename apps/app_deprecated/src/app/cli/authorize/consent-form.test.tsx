// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
/**
 * consent-form.test.tsx — the CLI consent pickers.
 *
 * The Select primitive is replaced with a native <select> so the assertions
 * are about this form's rules (what is offered, what is disabled, what the
 * approve action receives), not about @base-ui's popup mechanics.
 */
import * as React from "react";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockApprove, mockCancel } = vi.hoisted(() => ({
  mockApprove: vi.fn(),
  mockCancel: vi.fn(),
}));

vi.mock("./actions", () => ({
  approveCliAuth: mockApprove,
  cancelCliAuth: mockCancel,
}));

vi.mock("@/components/ui/select", () => {
  const Ctx = React.createContext<{
    value: string;
    onValueChange: (v: string | null) => void;
    disabled: boolean;
  }>({ value: "", onValueChange: () => {}, disabled: false });
  return {
    Select: ({
      value,
      onValueChange,
      disabled,
      children,
    }: {
      value: string;
      onValueChange: (v: string | null) => void;
      disabled?: boolean;
      children: React.ReactNode;
    }) => (
      <Ctx.Provider
        value={{ value, onValueChange, disabled: disabled ?? false }}
      >
        {children}
      </Ctx.Provider>
    ),
    SelectTrigger: ({ id }: { id: string; children?: React.ReactNode }) => {
      const ctx = React.useContext(Ctx);
      return (
        <select
          id={id}
          value={ctx.value}
          disabled={ctx.disabled}
          onChange={(e) => ctx.onValueChange(e.target.value)}
        >
          {ctx.value === "" ? <option value="" /> : null}
          {(
            window as unknown as {
              __options?: Record<string, { value: string; label: string }[]>;
            }
          ).__options?.[id]?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    },
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    SelectItem: ({
      value,
      children,
    }: {
      value: string;
      children: React.ReactNode;
    }) => (
      <span data-testid={`option-${value}`} hidden>
        {children}
      </span>
    ),
  };
});

import { ConsentForm } from "./consent-form";

const baseProps = {
  label: "my-laptop",
  redirectUri: "http://127.0.0.1:5555/callback",
  state: "state-1",
  codeChallenge: "c".repeat(43),
};

function setOptions(map: Record<string, { value: string; label: string }[]>) {
  (
    window as unknown as {
      __options?: Record<string, { value: string; label: string }[]>;
    }
  ).__options = map;
}

beforeEach(() => {
  mockApprove.mockReset();
  mockCancel.mockReset();
  setOptions({});
});
afterEach(cleanup);

describe("ConsentForm", () => {
  it("keeps the org and workspace pickers enabled with a single option each", () => {
    setOptions({
      "org-select": [{ value: "oxagen", label: "Oxagen" }],
      "ws-select": [{ value: "default", label: "Customer ABC" }],
    });
    render(
      <ConsentForm
        {...baseProps}
        orgs={[
          {
            id: "org-1",
            slug: "oxagen",
            name: "Oxagen",
            workspaces: [{ id: "ws-1", slug: "default", name: "Customer ABC" }],
          },
        ]}
      />,
    );
    expect(screen.getByLabelText("Organization")).toBeEnabled();
    expect(screen.getByLabelText("Workspace")).toBeEnabled();
    expect(screen.getByLabelText("Organization")).toHaveValue("oxagen");
    expect(screen.getByLabelText("Workspace")).toHaveValue("default");
    expect(screen.getByTestId("option-oxagen")).toHaveTextContent("Oxagen");
    expect(screen.getByTestId("option-default")).toHaveTextContent(
      "Customer ABC",
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("disables only the workspace picker, and Approve, when the org has none", () => {
    setOptions({ "org-select": [{ value: "solo", label: "Solo" }] });
    render(
      <ConsentForm
        {...baseProps}
        orgs={[{ id: "org-1", slug: "solo", name: "Solo", workspaces: [] }]}
      />,
    );
    expect(screen.getByLabelText("Organization")).toBeEnabled();
    expect(screen.getByLabelText("Workspace")).toBeDisabled();
    expect(
      screen.getByText("No workspaces available in this organization."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("switching org resets the workspace to that org's first workspace", () => {
    setOptions({
      "org-select": [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
      "ws-select": [
        { value: "a-1", label: "A1" },
        { value: "b-1", label: "B1" },
      ],
    });
    render(
      <ConsentForm
        {...baseProps}
        orgs={[
          {
            id: "org-a",
            slug: "a",
            name: "A",
            workspaces: [{ id: "wa", slug: "a-1", name: "A1" }],
          },
          {
            id: "org-b",
            slug: "b",
            name: "B",
            workspaces: [{ id: "wb", slug: "b-1", name: "B1" }],
          },
        ]}
      />,
    );
    fireEvent.change(screen.getByLabelText("Organization"), {
      target: { value: "b" },
    });
    expect(screen.getByLabelText("Workspace")).toHaveValue("b-1");
  });

  it("approve submits the selected org and workspace slugs with the PKCE fields", async () => {
    mockApprove.mockResolvedValue(undefined);
    setOptions({
      "org-select": [{ value: "oxagen", label: "Oxagen" }],
      "ws-select": [{ value: "default", label: "Customer ABC" }],
    });
    render(
      <ConsentForm
        {...baseProps}
        orgs={[
          {
            id: "org-1",
            slug: "oxagen",
            name: "Oxagen",
            workspaces: [{ id: "ws-1", slug: "default", name: "Customer ABC" }],
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(mockApprove).toHaveBeenCalledOnce());
    const fd = mockApprove.mock.calls[0]?.[0] as FormData;
    expect(fd.get("org_slug")).toBe("oxagen");
    expect(fd.get("workspace_slug")).toBe("default");
    expect(fd.get("redirect_uri")).toBe(baseProps.redirectUri);
    expect(fd.get("code_challenge")).toBe(baseProps.codeChallenge);
    expect(fd.get("code_challenge_method")).toBe("S256");
  });

  it("shows a genuine action error and swallows nothing else", async () => {
    mockApprove.mockRejectedValue(new Error("Workspace not found"));
    setOptions({
      "org-select": [{ value: "oxagen", label: "Oxagen" }],
      "ws-select": [{ value: "default", label: "Customer ABC" }],
    });
    render(
      <ConsentForm
        {...baseProps}
        orgs={[
          {
            id: "org-1",
            slug: "oxagen",
            name: "Oxagen",
            workspaces: [{ id: "ws-1", slug: "default", name: "Customer ABC" }],
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Workspace not found",
    );
  });

  it("cancel sends the redirect_uri and state to the cancel action", async () => {
    mockCancel.mockResolvedValue(undefined);
    setOptions({ "org-select": [{ value: "oxagen", label: "Oxagen" }] });
    render(
      <ConsentForm
        {...baseProps}
        orgs={[{ id: "org-1", slug: "oxagen", name: "Oxagen", workspaces: [] }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(mockCancel).toHaveBeenCalledOnce());
    const fd = mockCancel.mock.calls[0]?.[0] as FormData;
    expect(fd.get("redirect_uri")).toBe(baseProps.redirectUri);
    expect(fd.get("state")).toBe("state-1");
  });
});
