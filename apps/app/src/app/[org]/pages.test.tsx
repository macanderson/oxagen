// @vitest-environment jsdom
// Every route under /[org] and the root render between WL-08 and their page
// item (ARCHITECTURE.md §8): the four gap-lane pages render their one
// UNRECORDED row under the title, the four rev1 pages and the root render the
// title alone. Fleet, Run, People, API keys and Billing gain their bodies in
// WL-34 to WL-38 and the root becomes a redirect in WL-32.
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";

vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve((key: string) => {
      let node: unknown = (en as Record<string, unknown>)[namespace];
      for (const part of key.split("."))
        node = (node as Record<string, unknown>)[part];
      if (typeof node !== "string") throw new Error(`missing ${key}`);
      return node;
    }),
}));

afterEach(() => {
  cleanup();
});

async function renderPage(page: () => Promise<ReactElement>) {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      {await page()}
    </NextIntlClientProvider>,
  );
}

describe("gap-lane pages", () => {
  it.each([
    ["Agents", "agents", () => import("./[ws]/agents/page")],
    ["Tools", "tools", () => import("./[ws]/tools/[[...tab]]/page")],
    ["Steering", "steering", () => import("./[ws]/steering/[[...tab]]/page")],
    ["Spend", "spend", () => import("./[ws]/spend/[[...drill]]/page")],
  ])(
    "%s renders its title and one NotRecorded row",
    async (title, section, load) => {
      await renderPage((await load()).default);
      expect(screen.getByRole("main")).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        title,
      );
      expect(screen.getByTestId("not-recorded")).toHaveAttribute(
        "data-section",
        section,
      );
    },
  );
});

describe("rev1 pages before their page item", () => {
  it.each([
    ["Fleet", () => import("./[ws]/page")],
    ["Run", () => import("./[ws]/runs/[run]/[[...tab]]/page")],
    ["Organization", () => import("./page")],
    ["API keys", () => import("./api-keys/page")],
    ["Billing", () => import("./billing/page")],
    ["Mission Control", () => import("../page")],
  ])(
    "%s renders its title and no body, never a NotRecorded row (negative)",
    async (title, load) => {
      await renderPage((await load()).default);
      const main = screen.getByRole("main");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        title,
      );
      expect(screen.queryByTestId("not-recorded")).toBeNull();
      expect(main.querySelectorAll("p, table, form, ul")).toHaveLength(0);
    },
  );
});
