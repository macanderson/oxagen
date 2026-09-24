// @vitest-environment jsdom
// The page's error and denied states on their own: a refusal with no code is
// printed by its reason, a code the page does not know is printed without a
// status it cannot vouch for, and a denial that names no permission falls
// back to the one this page needs.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntlProvider } from "@/test/intl";
import { DeniedBody, ErrorBody } from "./states";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));

afterEach(cleanup);

describe("the error state", () => {
  it("prints the page's own failure with its status", () => {
    render(
      <IntlProvider>
        <ErrorBody
          failure={{
            ok: false,
            reason: "unavailable",
            code: "installation_unreachable",
          }}
          readAt="10:00"
          onRetry={vi.fn()}
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("repositories-error")).toHaveTextContent(
      "The control plane answered 503 installation_unreachable.",
    );
  });

  it("prints another code as recorded, with no status, and a codeless refusal by its reason (negative)", () => {
    const view = render(
      <IntlProvider>
        <ErrorBody
          failure={{ ok: false, reason: "unavailable", code: "github_down" }}
          readAt="10:00"
          onRetry={vi.fn()}
        />
      </IntlProvider>,
    );
    const error = screen.getByTestId("repositories-error");
    expect(error).toHaveTextContent("The control plane answered github_down.");
    expect(error).not.toHaveTextContent("503");
    view.rerender(
      <IntlProvider>
        <ErrorBody
          failure={{
            ok: false,
            reason: "pending_approval",
            accessRequestId: "apr_1",
          }}
          readAt="10:00"
          onRetry={vi.fn()}
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("repositories-error")).toHaveTextContent(
      "The control plane answered pending_approval.",
    );
  });
});

describe("the denied state", () => {
  const viewer = { name: "Mac Anderson", role: "workspace.viewer" };

  it("names the permission the refusal carried", () => {
    render(
      <IntlProvider>
        <DeniedBody
          org="acme"
          orgName="Acme"
          ws="core-platform"
          failure={{ ok: false, reason: "denied", code: "repository.write" }}
          viewer={viewer}
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("repositories-denied")).toHaveTextContent(
      "repository.write on core-platform",
    );
  });

  it("falls back to the page's permission when the refusal names none (negative)", () => {
    render(
      <IntlProvider>
        <DeniedBody
          org="acme"
          orgName="Acme"
          ws="core-platform"
          failure={{ ok: false, reason: "denied", code: "authz_denied" }}
          viewer={viewer}
        />
      </IntlProvider>,
    );
    const denied = screen.getByTestId("repositories-denied");
    expect(denied).toHaveTextContent("repository.read on core-platform");
    expect(denied).not.toHaveTextContent("authz_denied");
  });
});
