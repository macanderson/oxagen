// @vitest-environment jsdom
// The server half: the chrome renders the viewer the source resolved and 404s
// an organization the viewer does not belong to; the frame streams a skeleton
// and the pre-paint theme script.
import { cleanup, render, screen } from "@testing-library/react";
import { isValidElement, type ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import shellMessages from "../../../messages/shell.json";
import { shellData } from "./shell.builders";
import type { ShellData } from "./shell-data";

vi.mock("./source", () => ({
  // requireViewer runs inside shellSource: an organization the viewer is not a
  // member of is a 404 before the chrome renders.
  shellSource: (org: string) =>
    org === "acme"
      ? Promise.resolve(shellData())
      : Promise.reject(new NotFound("NEXT_NOT_FOUND")),
}));

/** What requireViewer throws through Next's notFound() for a non-member. */
const { NotFound } = vi.hoisted(() => ({
  NotFound: class NotFound extends Error {},
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

// The first import of the chrome pulls the whole shell graph through jsdom. On
// the CI runner that alone outlasted the first test's 5s budget, so load it once
// here; each test's own `await import` then resolves from the module cache.
beforeAll(async () => {
  await import("./shell-chrome");
}, 30_000);

afterEach(() => {
  cleanup();
});

describe("ShellChrome", () => {
  it("hands the resolved organization and viewer to the client shell", async () => {
    const { ShellChrome } = await import("./shell-chrome");
    const element = (await ShellChrome({
      params: Promise.resolve({ org: "acme" }),
    })) as ReactElement<{ data: ShellData }>;
    expect(isValidElement(element)).toBe(true);
    expect(element.props.data).toEqual(shellData());
  });

  it("is not found for an organization the viewer does not belong to", async () => {
    const { ShellChrome } = await import("./shell-chrome");
    await expect(
      ShellChrome({ params: Promise.resolve({ org: "globex" }) }),
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
