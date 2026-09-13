// @vitest-environment jsdom
// The server half: the chrome loads through the source and 404s an unknown
// organization; the workspace guard 404s an unknown workspace; the frame
// streams a skeleton and the pre-paint theme script.
import { cleanup, render, screen } from "@testing-library/react";
import { isValidElement, type ReactElement } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import shellMessages from "../../../messages/shell.json";
import { testFixtureShell } from "@/data/adapters/fixture/testing";
import { liveShell } from "@/data/adapters/live/shell";
import { FIXTURE_TENANT } from "@/data/fixture-tenant";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import { FIXTURE_USER } from "@/server/fixture-session";
import type { ShellSource } from "./source";

const source = vi.hoisted(() => ({ current: null as ShellSource | null }));

vi.mock("./source", () => ({
  // requireViewer runs inside shellSource: an organization the viewer is not a
  // member of never reaches the port.
  shellSource: (org: string) => {
    if (source.current === null) throw new Error("no source set");
    if (org !== "acme") return Promise.reject(new NotFound("NEXT_NOT_FOUND"));
    return Promise.resolve(source.current);
  },
}));

const { NotFound } = vi.hoisted(() => ({
  NotFound: class NotFound extends Error {},
}));
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

const ORG_SCOPE = {
  orgId: FIXTURE_TENANT.orgId,
  workspaceId: ORG_ONLY_WORKSPACE_ID,
};
const fixtureSource = (): ShellSource => ({
  port: testFixtureShell(),
  scope: ORG_SCOPE,
  userId: FIXTURE_USER.id,
});

// The first import of the chrome pulls the whole shell graph through jsdom. On
// the CI runner that alone outlasted the first test's 5s budget, so load it once
// here; each test's own `await import` then resolves from the module cache.
beforeAll(async () => {
  await import("./shell-chrome");
}, 30_000);

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

  it("is not found when the organization read is a 404 for this viewer", async () => {
    source.current = {
      port: testFixtureShell(),
      scope: ORG_SCOPE,
      userId: "usr_someoneelse",
    };
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
    source.current = { port: liveShell, scope: ORG_SCOPE, userId: "" };
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
