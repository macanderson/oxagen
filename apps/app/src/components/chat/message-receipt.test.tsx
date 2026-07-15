// @vitest-environment jsdom
/**
 * message-receipt.test.tsx — the per-message run receipt: gated on the
 * session provider (flag), summary line format, expand toggle, and the
 * metadata parser + formatters.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  MessageReceiptLine,
  modelLabelOf,
  formatReceiptCost,
  formatReceiptDuration,
} from "./message-receipt";
import { parseMessageReceipt, type MessageReceipt } from "./stream-event-types";
import { ChatSessionProvider } from "./session/session-store";
import type { SessionSeed } from "./session/session-state";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const SEED: SessionSeed = {
  defaultAgentId: null,
  defaultRepoKey: null,
  defaultEnvId: null,
  textModel: null,
  textTier: "fast",
  budgetUsd: null,
};

const RECEIPT: MessageReceipt = {
  model: "anthropic/claude-sonnet-5",
  effort: "high",
  durationMs: 4230,
  usage: {
    promptTokens: 1200,
    completionTokens: 300,
    totalTokens: 1500,
    creditsCharged: 31,
  },
};

function withProvider(children: React.ReactNode) {
  return render(
    <ChatSessionProvider
      workspaceSlug="ws"
      conversationId={null}
      boundAgentId={null}
      isNewConversation
      hasMessages={false}
      seed={SEED}
    >
      {children}
    </ChatSessionProvider>,
  );
}

describe("MessageReceiptLine", () => {
  it("renders nothing without the session provider (flag off)", () => {
    render(<MessageReceiptLine receipt={RECEIPT} />);
    expect(screen.queryByTestId("message-receipt")).toBeNull();
  });

  it("renders the model · effort · cost summary", () => {
    withProvider(<MessageReceiptLine receipt={RECEIPT} />);
    expect(screen.getByTestId("message-receipt").textContent).toBe(
      "Claude Sonnet 5 · High effort · $0.31",
    );
  });

  it("click toggles duration and tokens detail", () => {
    withProvider(<MessageReceiptLine receipt={RECEIPT} />);
    const el = screen.getByTestId("message-receipt");
    fireEvent.click(el);
    expect(el.textContent).toContain("4.2s");
    expect(el.textContent).toContain("1,500 tokens");
    expect(el.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(el);
    expect(el.textContent).not.toContain("4.2s");
  });

  it("omits effort and cost when absent", () => {
    withProvider(
      <MessageReceiptLine
        receipt={{
          ...RECEIPT,
          effort: null,
          usage: { ...RECEIPT.usage, creditsCharged: undefined },
        }}
      />,
    );
    expect(screen.getByTestId("message-receipt").textContent).toBe(
      "Claude Sonnet 5",
    );
  });
});

describe("formatters", () => {
  it("modelLabelOf prettifies gateway ids without a catalog", () => {
    expect(modelLabelOf("anthropic/claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(modelLabelOf("openai/gpt-5.2")).toBe("Gpt 5 2");
    expect(modelLabelOf("bare-model")).toBe("Bare Model");
  });

  it("formatReceiptCost converts credits (1¢) to dollars", () => {
    expect(formatReceiptCost(31)).toBe("$0.31");
    expect(formatReceiptCost(200)).toBe("$2.00");
    expect(formatReceiptCost(undefined)).toBeNull();
  });

  it("formatReceiptDuration renders seconds and minutes", () => {
    expect(formatReceiptDuration(4230)).toBe("4.2s");
    expect(formatReceiptDuration(65_000)).toBe("1m 05s");
  });
});

describe("parseMessageReceipt", () => {
  it("round-trips a valid receipt", () => {
    expect(parseMessageReceipt(RECEIPT)).toEqual(RECEIPT);
  });

  it("rejects wrong shapes", () => {
    expect(parseMessageReceipt(null)).toBeNull();
    expect(parseMessageReceipt("x")).toBeNull();
    expect(parseMessageReceipt({ model: "m" })).toBeNull();
    expect(parseMessageReceipt({ model: "m", durationMs: 1 })).toBeNull();
  });

  it("sanitizes invalid effort and missing token fields", () => {
    const parsed = parseMessageReceipt({
      model: "m",
      effort: "warp",
      durationMs: 10,
      usage: {},
    });
    expect(parsed).toEqual({
      model: "m",
      effort: null,
      durationMs: 10,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
  });
});
