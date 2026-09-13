// @vitest-environment jsdom
// The server half: the chrome loads through the source and 404s an unknown
// organization; the workspace guard 404s an unknown workspace; the frame
// streams a skeleton and the pre-paint theme script.
import { cleanup, render, screen } from "@testing-library/react";
import { isValidElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import shellMessages from "../../../messages/shell.json";
import { FIXTURE_USER } from "@/server/fixture-session";
import { fixtureShell } from "./adapters/fixture";
import { liveShell } from "./adapters/live";
import { DEFAULT_SWITCHES } from "./fixture-switches";
import type { ShellSource } from "./source";

const source = vi.hoisted(() => ({ current: null as ShellSource | null }));

vi.mock("./source", () => ({
  shellSource: () => {
    if (source.current === null) throw new Error("no source set");
    return Promise.resolve(source.current);
  },
}));

class NotFound extends Error {}
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));

// React's cache() only dedupes inside a server request; in tests it is a pass-through.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: <T,>(fn: T) => fn };
});

vi.mock("next-intl/server", () => ({
  getTranslations: () =>
    Promise.resolve((key: string) => {
      const value = (shellMessages.shell as Record<string, unknown>)[key];
      if (typeof value !== "string") throw new Error(`missing shell.${key}`);
      return value;
    }),
}));

const fixtureSource = (): ShellSource => ({
  port: fixtureShell(DEFAULT_SWITCHES),
  userId: FIXTURE_USER.id,
});

beforeEach(() => {
  source.current = fixtureSource();
});
afterEach(() => {
  cleanup();
});

describe("ShellChrome", () => {
  it("hands the loaded organization to the client shell", async () => {
    const { ShellChrome } = await import("./shell-chrome");
    const element = (await ShellChrome({
      params: Promise.resolve({ org: "acme" }),
    })) as ReactElement<{
      data: { org: string; context: { ok: boolean } };
    }>;
    expect(isValidElement(element)).toBe(true);
    expect(element.props.data.org).toBe("acme");
    expect(element.props.data.context.ok).toBe(true);
  });

  it("is not found for an organization the viewer does not belong to", async () => {
    const { ShellChrome } = await import("./shell-chrome");
    await expect(
      ShellChrome({ params: Promise.resolve({ org: "globex" }) }),
    ).rejects.toBeInstanceOf(NotFound);
  });

  it("is not found without a session in fixture mode", async () => {
    source.current = { port: fixtureShell(DEFAULT_SWITCHES), userId: null };
    const { ShellChrome } = await import("./shell-chrome");
    await expect(
      ShellChrome({ params: Promise.resolve({ org: "acme" }) }),
    ).rejects.toBeInstanceOf(NotFound);
  });
});

describe("WorkspaceGuard", () => {
  it("lets a real workspace through", async () => {
    const { WorkspaceGuard } = await import("./shell-chrome");
    expect(
      await WorkspaceGuard({
        params: Promise.resolve({ org: "acme", ws: "finops" }),
      }),
    ).toBeNull();
  });

  it("is not found for an unknown workspace or organization", async () => {
    const { WorkspaceGuard } = await import("./shell-chrome");
    await expect(
      WorkspaceGuard({ params: Promise.resolve({ org: "acme", ws: "nope" }) }),
    ).rejects.toBeInstanceOf(NotFound);
    await expect(
      WorkspaceGuard({
        params: Promise.resolve({ org: "globex", ws: "finops" }),
      }),
    ).rejects.toBeInstanceOf(NotFound);
  });

  it("does not 404 when the workspace list could not be read; the page decides", async () => {
    source.current = { port: liveShell, userId: null };
    const { WorkspaceGuard } = await import("./shell-chrome");
    expect(
      await WorkspaceGuard({
        params: Promise.resolve({ org: "acme", ws: "anything" }),
      }),
    ).toBeNull();
  });
});

describe("ShellFrame", () => {
  it("renders the page beside the chrome, with the pre-paint theme script", async () => {
    const { ShellFrame } = await import("./shell-frame");
    const { THEME_SCRIPT } = await import("./theme");
    const { container } = render(
      <ShellFrame chrome={<p>chrome</p>}>
        <main id="main">page</main>
      </ShellFrame>,
    );
    expect(screen.getByTestId("shell")).toBeInTheDocument();
    expect(screen.getByText("chrome")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent("page");
    expect(container.querySelector("script")?.innerHTML).toBe(THEME_SCRIPT);
  });

  it("streams a labelled skeleton while the chrome loads", async () => {
    const { ChromeSkeleton } = await import("./shell-frame");
    render(await ChromeSkeleton());
    expect(screen.getByTestId("shell-loading")).toHaveTextContent(
      "Loading Mission Control",
    );
  });
});
