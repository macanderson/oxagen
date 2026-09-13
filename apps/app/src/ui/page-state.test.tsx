// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import { denied, notBacked, readError } from "@/data/not-backed";
import { PageState } from "./page-state";

// Resolve `states.*` keys against the real catalog with ICU-style {arg} substitution.
vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(
      (key: string, values: Record<string, string | number> = {}) => {
        const path = [...namespace.split("."), ...key.split(".")];
        let node: unknown = en;
        for (const part of path) node = (node as Record<string, unknown>)[part];
        if (typeof node !== "string")
          throw new Error(`missing message ${path.join(".")}`);
        return node.replace(/\{(\w+)\}/g, (_m, name: string) =>
          String(values[name]),
        );
      },
    ),
}));

afterEach(() => {
  cleanup();
});

async function renderState(props: Parameters<typeof PageState>[0]) {
  render(await PageState(props));
}

describe("PageState", () => {
  it("names the milestone and gap for a read that is not backed", async () => {
    await renderState({ page: "fleet", result: notBacked("M2", "G3") });
    const state = screen.getByTestId("page-state-not_backed");
    expect(state).toHaveAccessibleName("Not recorded yet");
    expect(state).toHaveTextContent("milestone M2 (backend gap G3)");
  });

  it("names the missing permission when denied", async () => {
    await renderState({ page: "audit", result: denied("audit.events.read") });
    expect(screen.getByTestId("page-state-denied")).toHaveTextContent(
      "audit.events.read",
    );
  });

  it("shows the error code and status", async () => {
    await renderState({
      page: "tools",
      result: readError("tool_registry_unavailable", 503),
    });
    expect(screen.getByTestId("page-state-error")).toHaveTextContent(
      "Error tool_registry_unavailable (HTTP 503)",
    );
  });

  it("renders the empty state", async () => {
    await renderState({ page: "fleet", empty: true });
    expect(screen.getByTestId("page-state-empty")).toHaveAccessibleName(
      "Nothing here yet",
    );
  });
});
