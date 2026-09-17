// @vitest-environment jsdom
// /cli/complete names itself pages.cliComplete in the tab and the h1, and says
// the terminal holds the token (ARCHITECTURE.md §1.2). It renders with no
// session and reads nothing: the browser that finished the loopback exchange
// may hold no app cookie, so a page that asked for a viewer would end a
// successful sign-in on /login (#3091).
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { translator } from "@/test/intl";
import { expectPageTitle, renderPage, routeProps } from "@/test/render-page";

vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));
// The seams this page must not touch, wired to throw. A mock only takes effect
// on import, so today they are inert; the day the page resolves a viewer or
// opens the data source, every test below fails instead of the flow silently
// regaining the gate that sends a cookie-less browser to /login.
const refuse = (name: string) => () => {
  throw new Error(`/cli/complete must not call ${name}`);
};
vi.mock("@/server/viewer", () => ({
  requireUser: refuse("requireUser"),
  requireViewer: refuse("requireViewer"),
  resolveViewer: refuse("resolveViewer"),
}));
vi.mock("@/data/source", () => ({ dataSource: refuse("dataSource") }));

const page = await import("./page");
const t = translator("auth.cli");

describe("/cli/complete", () => {
  it("pages.cliComplete is the document title and the one h1", async () => {
    await expectPageTitle(
      page,
      routeProps({}),
      translator("pages")("cliComplete"),
    );
  });

  it("tells the person the terminal holds the token and the tab can close", async () => {
    await expectPageTitle(
      page,
      routeProps({}),
      translator("pages")("cliComplete"),
    );
    expect(screen.getByTestId("cli-complete")).toHaveTextContent(
      t("complete.body"),
    );
  });

  it("renders with no route arguments at all (negative)", async () => {
    // The CLI names this address itself, with no query and no segment
    // (cliLoginCompleteUrl). A page that needed one would render a different
    // thing for the browser that actually arrives.
    const container = await renderPage(await page.default());
    expect(container.querySelector("h1")?.textContent).toBe(
      translator("pages")("cliComplete"),
    );
  });
});
