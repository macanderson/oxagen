// @vitest-environment jsdom
/**
 * edit-source-config-sheet.test.tsx — tests for the source config editor.
 *
 * The schema provider + field renderer are mocked so these tests focus on the
 * sheet's own responsibilities:
 *   - Fetches the connection's current config via connection.get on open.
 *   - Merge-submits: PATCH deliveryConfig = { ...existing, ...editedSchemaFields }
 *     so non-schema operational keys (owner/repo) survive an edit.
 *   - Sends displayName only when it changed.
 *   - Validation errors block the PATCH.
 *   - No-op save (nothing changed, no config fields) closes without a PATCH.
 */

import * as React from "react";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockAddToast,
  mockRefresh,
  ctxHolder,
  validateHolder,
  setErrorsMock,
  touchFieldMock,
} = vi.hoisted(() => ({
  mockAddToast: vi.fn(),
  mockRefresh: vi.fn(),
  setErrorsMock: vi.fn(),
  touchFieldMock: vi.fn(),
  ctxHolder: { current: null as unknown as Record<string, unknown> },
  validateHolder: { fn: (_f: unknown, _v: unknown) => null as string | null },
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="sheet">{children}</div> : null,
  SheetPopup: ({ children, ...rest }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...rest}>{children}</div>
  ),
  SheetHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetPanel: ({ children, ...rest }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...rest}>{children}</div>
  ),
  SheetFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: ({
    value,
    onChange,
    ...rest
  }: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input value={value} onChange={onChange} {...rest} />
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({
    children,
    ...rest
  }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
    <label {...rest}>{children}</label>
  ),
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
}));

vi.mock("@/components/connectors/connector-schema-provider", () => ({
  ConnectorSchemaProvider: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  useConnectorSchema: () => ctxHolder.current,
}));

vi.mock("@/components/connectors/field-renderer", () => ({
  FieldRenderer: ({ field }: { field: { key: string } }) => (
    <div data-testid={`field-${field.key}`} />
  ),
  validateField: (f: unknown, v: unknown) => validateHolder.fn(f, v),
}));

import { EditSourceConfigSheet } from "./edit-source-config-sheet";

const TARGET = {
  publicId: "con_pub1",
  connectorId: "github",
  displayName: "Acme Repos",
};

const BASE_PROPS = {
  open: true,
  onClose: vi.fn(),
  orgSlug: "acme",
  workspaceSlug: "main",
  target: TARGET,
};

/** connection.get payload — deliveryConfig mixes a schema field with operational keys. */
const EXISTING = {
  displayName: "Acme Repos",
  deliveryConfig: { organizations: ["old-org"], owner: "acme", repo: "core" },
};

function makeCtx(
  values: Record<string, unknown>,
  configFields: Array<{ key: string }>,
) {
  return {
    schema: { config: { fields: configFields } },
    loading: false,
    fetchError: null,
    formState: { values, errors: [], touched: new Set<string>() },
    setErrors: setErrorsMock,
    touchField: touchFieldMock,
  };
}

/** Route GET → connection.get; PATCH → ok. Returns the jest mock for assertions. */
function stubFetch(patchOk = true) {
  const fn = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
    if (!opts || !opts.method || opts.method === "GET") {
      return Promise.resolve({
        ok: true,
        json: async () => EXISTING,
        text: async () => "",
      });
    }
    return Promise.resolve(
      patchOk
        ? {
            ok: true,
            json: async () => ({ connectionId: "con_pub1" }),
            text: async () => "",
          }
        : { ok: false, status: 500, text: async () => "patch failed" },
    );
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function patchCall(fn: ReturnType<typeof vi.fn>) {
  const call = fn.mock.calls.find(
    (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
  );
  if (!call) return null;
  return {
    url: call[0] as string,
    body: JSON.parse((call[1] as RequestInit).body as string),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  validateHolder.fn = () => null;
  ctxHolder.current = makeCtx({ organizations: ["new-org"] }, [
    { key: "organizations" },
  ]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EditSourceConfigSheet", () => {
  it("fetches current config and renders the manifest config fields", async () => {
    stubFetch();
    render(<EditSourceConfigSheet {...BASE_PROPS} />);
    await waitFor(() =>
      expect(screen.getByTestId("field-organizations")).toBeTruthy(),
    );
    // Display name seeded from connection.get.
    expect(
      (screen.getByTestId("edit-source-display-name") as HTMLInputElement)
        .value,
    ).toBe("Acme Repos");
  });

  it("merge-submits deliveryConfig, preserving non-schema operational keys", async () => {
    const fn = stubFetch();
    render(<EditSourceConfigSheet {...BASE_PROPS} />);
    await waitFor(() =>
      expect(screen.getByTestId("save-source-config-btn")).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("save-source-config-btn"));
    });

    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    const patch = patchCall(fn)!;
    expect(patch.url).toBe("/api/v1/acme/main/connections/con_pub1");
    // edited schema field overrides; owner/repo (not in the manifest) survive.
    expect(patch.body.deliveryConfig).toEqual({
      organizations: ["new-org"],
      owner: "acme",
      repo: "core",
    });
    // displayName unchanged → not sent.
    expect(patch.body.displayName).toBeUndefined();
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("sends displayName when it changed", async () => {
    const fn = stubFetch();
    render(<EditSourceConfigSheet {...BASE_PROPS} />);
    await waitFor(() =>
      expect(screen.getByTestId("edit-source-display-name")).toBeTruthy(),
    );

    fireEvent.change(screen.getByTestId("edit-source-display-name"), {
      target: { value: "Renamed Source" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("save-source-config-btn"));
    });

    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(patchCall(fn)!.body.displayName).toBe("Renamed Source");
  });

  it("blocks the PATCH when a field fails validation", async () => {
    validateHolder.fn = () => "Required";
    const fn = stubFetch();
    render(<EditSourceConfigSheet {...BASE_PROPS} />);
    await waitFor(() =>
      expect(screen.getByTestId("save-source-config-btn")).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("save-source-config-btn"));
    });

    expect(setErrorsMock).toHaveBeenCalledWith([
      { field: "organizations", message: "Required", code: "invalid" },
    ]);
    expect(patchCall(fn)).toBeNull();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("closes without a PATCH when nothing changed and there are no config fields", async () => {
    ctxHolder.current = makeCtx({}, []);
    const fn = stubFetch();
    const onClose = vi.fn();
    render(<EditSourceConfigSheet {...BASE_PROPS} onClose={onClose} />);
    await waitFor(() =>
      expect(screen.getByTestId("save-source-config-btn")).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("save-source-config-btn"));
    });

    expect(onClose).toHaveBeenCalled();
    expect(patchCall(fn)).toBeNull();
  });
});
