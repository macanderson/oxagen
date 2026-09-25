// @vitest-environment jsdom
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const { DESKTOP_DOWNLOADS, DESKTOP_DOWNLOADS_PAGE } = await import(
  "@/shared/desktop-downloads"
);
const { parseGitHubUrl } = await import("@/shared/github-url");
const { parseHostedInvoiceUrl } = await import("@/shared/invoice-url");
const { parsePullRequestUrl } = await import("@/shared/pull-request-url");
const { routes } = await import("@/shared/safe-path");
const {
  DesktopDownloadsPageLink,
  DesktopInstallerLink,
  GitHubLink,
  HostedInvoiceLink,
  PullRequestLink,
  SafeForm,
  SafeLink,
  useNavigate,
} = await import("./navigation");

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

  it("advances in place: a replace that keeps the scroll and reads once", () => {
    router.replace.mockClear();
    router.refresh.mockClear();
    const { result } = renderHook(() => useNavigate());
    result.current.advance(routes.fleet("acme", "core"));
    expect(router.replace).toHaveBeenCalledWith("/acme/core", {
      scroll: false,
    });
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("HostedInvoiceLink", () => {
  it("opens the invoice page in a new tab without an opener", () => {
    const url = parseHostedInvoiceUrl(
      "https://invoice.stripe.com/i/acct_1Nx/test_1",
    );
    if (url === null) throw new Error("fixture url refused");
    render(<HostedInvoiceLink to={url}>invoice</HostedInvoiceLink>);
    const link = screen.getByRole("link", { name: "invoice" });
    expect(link).toHaveAttribute("href", url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});

describe("PullRequestLink", () => {
  it("opens the pull request in a new tab without an opener", () => {
    const url = parsePullRequestUrl("https://github.com/acme/core/pull/519");
    if (url === null) throw new Error("fixture url refused");
    render(<PullRequestLink to={url}>pull request</PullRequestLink>);
    const link = screen.getByRole("link", { name: "pull request" });
    expect(link).toHaveAttribute("href", url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});

describe("GitHubLink", () => {
  it("opens the App's install page in a new tab without an opener", () => {
    const url = parseGitHubUrl(
      "https://github.com/apps/oxagen/installations/new?state=signed",
    );
    if (url === null) throw new Error("fixture url refused");
    render(<GitHubLink to={url}>install</GitHubLink>);
    const link = screen.getByRole("link", { name: "install" });
    expect(link).toHaveAttribute("href", url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});

describe("DesktopInstallerLink", () => {
  it("downloads the installer in place, with no new tab", () => {
    const url = DESKTOP_DOWNLOADS[0]?.installers[0]?.url;
    if (url === undefined) throw new Error("no installer in the table");
    render(<DesktopInstallerLink to={url}>installer</DesktopInstallerLink>);
    const link = screen.getByRole("link", { name: "installer" });
    expect(link).toHaveAttribute("href", url);
    expect(link).not.toHaveAttribute("target");
    expect(link).not.toHaveAttribute("download");
  });
});

describe("DesktopDownloadsPageLink", () => {
  it("opens the downloads page in a new tab without an opener", () => {
    render(
      <DesktopDownloadsPageLink to={DESKTOP_DOWNLOADS_PAGE}>
        every version
      </DesktopDownloadsPageLink>,
    );
    const link = screen.getByRole("link", { name: "every version" });
    expect(link).toHaveAttribute("href", "https://downloads.oxagen.sh/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
