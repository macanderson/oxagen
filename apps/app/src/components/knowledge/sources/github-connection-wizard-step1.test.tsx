// @vitest-environment jsdom
/**
 * github-connection-wizard-step1.test.tsx — tests for the "Connect" step.
 *
 * Covers:
 *   - Happy path: creates the pending connection, fetches the OAuth URL, and
 *     redirects the browser to GitHub.
 *   - A non-OK /auth-url response surfaces the API's real error body (e.g. a
 *     503 "GitHub App is not configured") instead of a generic message — this
 *     is the difference between a diagnosable and an opaque deployment.
 *   - Falls back to the HTTP status when the error body is unparseable.
 */

/// <reference types="@testing-library/jest-dom" />

import * as React from "react";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Step1Connect } from "./github-connection-wizard-step1";
import { readPendingGithubConnection } from "./github-connection-wizard-types";

const ORG = "acme";
const WS = "main";

type FetchJson = { ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> };

/** The auth-url response the next fetch should return. Mutated per-test. */
let authUrlResponse: FetchJson;

let assignedHref = "";
const realLocation = window.location;

function renderStep1(onConnectionCreated = vi.fn()) {
  return render(
    <Step1Connect
      orgSlug={ORG}
      workspaceSlug={WS}
      onConnectionCreated={onConnectionCreated}
      error={null}
    />,
  );
}

beforeEach(() => {
  assignedHref = "";
  window.sessionStorage.clear();
  // Capture (rather than perform) the redirect so jsdom doesn't try to navigate.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      get href() {
        return assignedHref;
      },
      set href(v: string) {
        assignedHref = v;
      },
    },
  });

  authUrlResponse = {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({ authUrl: "https://github.com/login/oauth/authorize?client_id=x" }),
  };

  global.fetch = vi.fn(async (input: RequestInfo | URL): Promise<FetchJson> => {
    const url = String(input);
    // Order matters: the auth-url path also contains "/connections".
    if (url.includes("/auth-url")) {
      return authUrlResponse;
    }
    if (url.includes("/connections")) {
      return {
        ok: true,
        status: 201,
        text: async () => "",
        json: async () => ({ publicId: "con_ABC" }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
});

describe("Step1Connect", () => {
  it("creates a connection then redirects to the GitHub OAuth URL", async () => {
    const onConnectionCreated = vi.fn();
    renderStep1(onConnectionCreated);

    fireEvent.click(screen.getByTestId("github-connect-btn"));

    await waitFor(() => expect(onConnectionCreated).toHaveBeenCalledWith("con_ABC"));
    await waitFor(() =>
      expect(assignedHref).toBe("https://github.com/login/oauth/authorize?client_id=x"),
    );
  });

  it("stashes the pending connection for resume before redirecting to GitHub", async () => {
    renderStep1();

    fireEvent.click(screen.getByTestId("github-connect-btn"));

    // The handoff lets the wizard resume Step 2 even when GitHub's stateless
    // Setup-URL "update" leg redirects back without the connectionId in the URL.
    await waitFor(() =>
      expect(readPendingGithubConnection()).toEqual({
        connectionId: "con_ABC",
        orgSlug: ORG,
        workspaceSlug: WS,
      }),
    );
  });

  it("surfaces the API's real error when /auth-url fails (misconfigured deployment)", async () => {
    authUrlResponse = {
      ok: false,
      status: 503,
      text: async () => "",
      json: async () => ({
        error:
          "GitHub App is not configured — GITHUB_APP_CLIENT_ID / GITHUB_APP_INSTALL_STATE_SECRET missing",
      }),
    };
    renderStep1();

    fireEvent.click(screen.getByTestId("github-connect-btn"));

    const err = await screen.findByText(/GitHub App is not configured/i);
    expect(err).toBeInTheDocument();
    expect(err).toHaveTextContent("Failed to get OAuth URL:");
    // The opaque generic-only message must no longer be shown on its own.
    expect(assignedHref).toBe("");
  });

  it("falls back to the HTTP status when the error body is unparseable", async () => {
    authUrlResponse = {
      ok: false,
      status: 500,
      text: async () => "",
      json: async () => {
        throw new Error("not json");
      },
    };
    renderStep1();

    fireEvent.click(screen.getByTestId("github-connect-btn"));

    const err = await screen.findByText(/Failed to get OAuth URL \(500\)/);
    expect(err).toBeInTheDocument();
  });
});
