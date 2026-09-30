// The screen is an async Server Component; the tests call it and walk the
// element tree it returns, which covers both branches without an RSC renderer.
// The request's host and the signed-in email reach the form: the address is
// printed under the host, and the denied state names the email.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.fn();
vi.mock("@/server/viewer", () => ({ requireUser }));
const host = vi.fn<() => string | null>(() => "oxagen.test");
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve({ get: () => host() }),
}));
vi.mock("@/server/session", () => ({
  getAuthUser: () => Promise.resolve({ email: "marcus@acme.example" }),
}));

const { NewOrganizationScreen } = await import("./new-organization");
const { OrganizationForm } = await import("./ui/organization-form");

type AnyElement = ReactElement<Record<string, unknown>>;

function elements(node: ReactNode): AnyElement[] {
  const out: AnyElement[] = [];
  const visit = (n: unknown) => {
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    if (!isValidElement<Record<string, unknown>>(n)) return;
    out.push(n);
    for (const value of Object.values(n.props)) visit(value);
  };
  visit(node);
  return out;
}

beforeEach(() => {
  requireUser.mockReset();
  requireUser.mockResolvedValue({ userId: "usr_marcusbell" });
});

describe("NewOrganizationScreen", () => {
  it("gates on a signed-in person who comes back here after log in (negative)", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(
      NewOrganizationScreen({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(requireUser).toHaveBeenCalledWith("/new-organization");
  });

  it("renders the organization form for a signed-in person", async () => {
    const tree = elements(
      await NewOrganizationScreen({ searchParams: Promise.resolve({}) }),
    );
    const form = tree.find((e) => e.type === OrganizationForm);
    expect(form?.props.destination).toBeUndefined();
    expect(form?.props.host).toBe("oxagen.test");
    expect(form?.props.email).toBe("marcus@acme.example");
  });

  it("prints the address under the fallback host when the request names none", async () => {
    host.mockReturnValueOnce(null);
    const form = elements(
      await NewOrganizationScreen({ searchParams: Promise.resolve({}) }),
    ).find((e) => e.type === OrganizationForm);
    expect(form?.props.host).toBe("app.oxagen.sh");
  });

  it("carries a requested destination through log in and to the form", async () => {
    const authorize = "/cli/authorize?state=abc&label=laptop";
    const withDestination = elements(
      await NewOrganizationScreen({
        searchParams: Promise.resolve({ returnTo: authorize }),
      }),
    ).find((e) => e.type === OrganizationForm);
    expect(requireUser).toHaveBeenCalledWith(
      `/new-organization?next=${encodeURIComponent(authorize)}`,
    );
    expect(withDestination?.props.destination).toBe(authorize);
  });

  it("drops a destination that is not a same-origin path (negative)", async () => {
    const refused = elements(
      await NewOrganizationScreen({
        searchParams: Promise.resolve({ next: "//evil.example" }),
      }),
    ).find((e) => e.type === OrganizationForm);
    expect(requireUser).toHaveBeenCalledWith("/new-organization");
    expect(refused?.props.destination).toBeUndefined();
  });
});
