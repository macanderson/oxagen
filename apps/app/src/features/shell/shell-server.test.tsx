// @vitest-environment jsdom
// The server half: the chrome loads through the source and 404s an unknown
// organization; the frame streams a skeleton and the pre-paint theme script.
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
import { readError } from "@/data/not-backed";
import type { ShellReadPort } from "@/data/ports";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import { SHELL_ORG_ID, SHELL_VIEWER, shellData } from "./shell.builders";
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
  orgId: SHELL_ORG_ID,
  workspaceId: ORG_ONLY_WORKSPACE_ID,
};

/** A port serving the built shell reads to the built viewer, and a 404 context to anyone else. */
function builtPort(): ShellReadPort {
  const data = shellData();
  return {
    context: (_scope, userId) =>
      Promise.resolve(
        userId === SHELL_VIEWER.id
          ? data.context
          : readError("org_not_found", 404),
      ),
    navCounts: () => Promise.resolve(data.counts),
    notifications: () => Promise.resolve(data.notifications),
    people: () => Promise.resolve(readError("people_not_read", 501)),
    assistantEngine: () => Promise.resolve(data.engine),
    recentRuns: () => Promise.resolve({ ok: true, value: data.runs }),
    account: () => Promise.resolve(data.account),
  };
}
const builtSource = (): ShellSource => ({
  port: builtPort(),
  scope: ORG_SCOPE,
  userId: SHELL_VIEWER.id,
});

// The first import of the chrome pulls the whole shell graph through jsdom. On
// the CI runner that alone outlasted the first test's 5s budget, so load it once
// here; each test's own `await import` then resolves from the module cache.
beforeAll(async () => {
  await import("./shell-chrome");
}, 30_000);

beforeEach(() => {
  source.current = builtSource();
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
      port: builtPort(),
      scope: ORG_SCOPE,
      userId: "usr_someoneelse",
    };
    const { ShellChrome } = await import("./shell-chrome");
    await expect(
      ShellChrome({ params: Promise.resolve({ org: "acme" }) }),
    ).rejects.toBeInstanceOf(NotFound);
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
