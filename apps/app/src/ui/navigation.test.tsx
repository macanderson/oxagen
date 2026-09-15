// @vitest-environment jsdom
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const { routes } = await import("@/shared/safe-path");
const { SafeForm, SafeLink, useNavigate } = await import("./navigation");

afterEach(() => {
  cleanup();
});

describe("SafeLink", () => {
  it("renders a link to the path with the rest of its props", () => {
    render(
      <SafeLink to={routes.people("acme")} className="x" aria-current="page">
        Acme
      </SafeLink>,
    );
    const link = screen.getByRole("link", { name: "Acme" });
    expect(link).toHaveAttribute("href", "/acme");
    expect(link).toHaveAttribute("aria-current", "page");
  });
});

describe("SafeForm", () => {
  it("renders a form whose action is the given path", () => {
    render(
      <SafeForm action={routes.login()} aria-label="f">
        <button type="submit">go</button>
      </SafeForm>,
    );
    expect(screen.getByRole("form", { name: "f" })).toHaveAttribute(
      "action",
      "/login",
    );
  });
});

describe("useNavigate", () => {
  it("pushes, and replaces with a server re-render", () => {
    const { result } = renderHook(() => useNavigate());
    result.current.push(routes.fleet("acme", "core"));
    expect(router.push).toHaveBeenCalledWith("/acme/core");
    expect(router.refresh).not.toHaveBeenCalled();
    result.current.replace(routes.people("acme"));
    expect(router.replace).toHaveBeenCalledWith("/acme");
    expect(router.refresh).toHaveBeenCalledOnce();
  });
});
