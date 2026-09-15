// The screen is an async Server Component; the tests call it and walk the
// element tree it returns, which covers both branches without an RSC renderer.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { translator } from "../auth/test-intl";

const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next-intl/server", () => ({
  getTranslations: (ns: string) => Promise.resolve(translator(ns)),
}));
const getAuthUser = vi.fn();
vi.mock("@/features/auth", async () => ({
  ...(await vi.importActual<typeof import("../auth/safe-next")>(
    "../auth/safe-next",
  )),
  getAuthUser,
}));

const { NewOrganizationScreen } = await import("./new-organization");
const { OrganizationForm } = await import("./ui/organization-form");
const { AuthHeading } = await import("@/ui/auth-shell");

type AnyElement = ReactElement<Record<string, unknown>>;

function elements(node: ReactNode): AnyElement[] {
  const out: AnyElement[] = [];
  const visit = (n: unknown) => {
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    if (!isValidElement(n)) return;
    const el = n as AnyElement;
    out.push(el);
    for (const value of Object.values(el.props)) visit(value);
  };
  visit(node);
  return out;
}

describe("NewOrganizationScreen", () => {
  it("sends a signed-out visit to log in and back here", async () => {
    getAuthUser.mockResolvedValue(null);
    await expect(NewOrganizationScreen()).rejects.toThrow(
      "NEXT_REDIRECT /login?next=%2Fnew-organization",
    );
  });

  it("renders the heading and the organization form for a signed-in person", async () => {
    getAuthUser.mockResolvedValue({ id: "usr_marcusbell" });
    const tree = elements(await NewOrganizationScreen());
    expect(redirect).not.toHaveBeenCalled();
    const heading = tree.find((e) => e.type === AuthHeading);
    expect(heading?.props.title).toBe("Name your organization");
    expect(tree.some((e) => e.type === OrganizationForm)).toBe(true);
  });
});
