// @vitest-environment jsdom
// The window a model request carried and the assembler's manifest, as the
// frame view draws them (ADR-200, #3894). The rules: a block's tokens are its
// byte share of the provider's total, so the parts add up to the prompt
// tokens; a block the recorder could not tell apart is not drawn; and a
// figure the record does not carry says not recorded, never a zero.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  AssembledContext,
  assemblyAt,
  CompositionBar,
  drawsAssembly,
  drawsWindow,
  RequestWindow,
  windowAt,
} from "./request-window";
import { contextAssembly, contextWindow, runContext } from "./run.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

afterEach(cleanup);

const hrefOf = (seq: string) =>
  routes.run("acme", "core-platform", "arun_7k2m9q", {
    tab: "actions",
    body: seq,
  });

describe("which frames draw a panel", () => {
  it("draws a window on the frames that record a model request, and a manifest on the assembler's", () => {
    expect(drawsWindow("llm_call")).toBe(true);
    expect(drawsWindow("model.engine_call_started")).toBe(true);
    expect(drawsWindow("model.engine_call_completed")).toBe(false);
    expect(drawsWindow(null)).toBe(false);
    expect(drawsAssembly("steering.manifest")).toBe(true);
    expect(drawsAssembly("tool_call")).toBe(false);
  });

  it("finds the window and the manifest recorded at a frame, and nothing at another", () => {
    const context = runContext({
      windows: [contextWindow({ seq: "4" })],
      assemblies: [contextAssembly({ seq: "3" })],
    });
    expect(windowAt(context, "4")?.promptTokens).toBe(12_000);
    expect(windowAt(context, "5")).toBeNull();
    expect(assemblyAt(context, "3")?.spentTokens).toBe(600);
    expect(assemblyAt(context, "4")).toBeNull();
  });
});

describe("RequestWindow", () => {
  it("draws the window's facts, composition and stack, and links the frame that answered it", async () => {
    const { container } = render(
      <IntlProvider>
        <RequestWindow
          read={readOk(runContext({ windows: [contextWindow()] }))}
          seq="4"
          hrefOf={hrefOf}
        />
      </IntlProvider>,
    );
    const panel = within(screen.getByTestId("window-panel"));
    expect(panel.getByText("Provider").nextSibling).toHaveTextContent(
      "anthropic",
    );
    expect(panel.getByText("Model").nextSibling).toHaveTextContent(
      "claude-opus-5",
    );
    expect(panel.getByRole("link")).toHaveAttribute("href", hrefOf("5"));
    expect(screen.getAllByTestId("window-stack-row")).toHaveLength(5);
    await expectNoAxe(container);
  });

  it("says the provider and model are not recorded when the window names neither (negative)", () => {
    render(
      <IntlProvider>
        <RequestWindow
          read={readOk(
            runContext({
              windows: [
                contextWindow({ provider: null, model: null, responseSeq: null }),
              ],
            }),
          )}
          seq="4"
          hrefOf={hrefOf}
        />
      </IntlProvider>,
    );
    const panel = within(screen.getByTestId("window-panel"));
    expect(panel.getByText("Provider").nextSibling).toHaveTextContent(
      "not recorded",
    );
    expect(panel.getByText("Model").nextSibling).toHaveTextContent(
      "not recorded",
    );
    expect(panel.queryByRole("link")).toBeNull();
  });

  it("names the read's failure (negative)", () => {
    render(
      <IntlProvider>
        <RequestWindow
          read={readError("frame_store_unreachable", 502)}
          seq="4"
          hrefOf={hrefOf}
        />
      </IntlProvider>,
    );
    expect(screen.getByText(/frame_store_unreachable/)).toBeTruthy();
  });
});

describe("CompositionBar", () => {
  it("draws no band for a block that measured no bytes", async () => {
    const { container } = render(
      <IntlProvider>
        <CompositionBar
          recorded={contextWindow({
            blocks: [
              { kind: "system", bytes: 0, items: 0, tokens: 0 },
              { kind: "steering", bytes: 0, items: 0, tokens: 0 },
              { kind: "tools", bytes: 40, items: 1, tokens: 400 },
              { kind: "context", bytes: 0, items: 0, tokens: 0 },
              { kind: "conversation", bytes: 60, items: 2, tokens: 600 },
            ],
          })}
        />
      </IntlProvider>,
    );
    expect(
      screen
        .getAllByTestId("window-part")
        .map((part) => part.getAttribute("data-kind")),
    ).toEqual(["tools", "conversation"]);
    await expectNoAxe(container);
  });
});

describe("AssembledContext", () => {
  it("says the budget's use without a share when the budget is zero (negative)", () => {
    render(
      <IntlProvider>
        <AssembledContext
          read={readOk(
            runContext({
              assemblies: [
                contextAssembly({
                  budgetTokens: 0,
                  spentTokens: 0,
                  textDigest: null,
                }),
              ],
            }),
          )}
          seq="3"
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("assembled-used")).toHaveTextContent("0 tok");
    expect(
      within(screen.getByTestId("assembled-panel")).getByText(
        "No text was included",
      ),
    ).toBeTruthy();
  });

  it("says a frame with no readable manifest summary has none (negative)", async () => {
    const { container } = render(
      <IntlProvider>
        <AssembledContext read={readOk(runContext())} seq="3" />
      </IntlProvider>,
    );
    expect(screen.getByTestId("assembled-none")).toHaveTextContent(
      "This frame carries no manifest summary the record can read.",
    );
    await expectNoAxe(container);
  });
});
