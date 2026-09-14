// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import { PlaceholderPage } from "./placeholder-page";

vi.mock("next-intl/server", () => ({
  getTranslations: () =>
    Promise.resolve((key: string) => {
      let node: unknown = en.routes;
      for (const part of key.split("."))
        node = (node as Record<string, unknown>)[part];
      return String(node);
    }),
}));

afterEach(() => {
  cleanup();
});

describe("PlaceholderPage", () => {
  it("renders a main landmark titled by the route, with the rebuild note by default", async () => {
    render(await PlaceholderPage({ route: "login" }));
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Log in",
    );
    expect(screen.getByText(en.routes.placeholder)).toBeInTheDocument();
  });

  it("renders children in place of the note", async () => {
    render(await PlaceholderPage({ route: "fleet", children: <p>state</p> }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Fleet",
    );
    expect(screen.queryByText(en.routes.placeholder)).not.toBeInTheDocument();
    expect(screen.getByText("state")).toBeInTheDocument();
  });
});
