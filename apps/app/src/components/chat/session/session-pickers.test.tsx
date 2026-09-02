// @vitest-environment jsdom
/**
 * session-pickers.test.tsx — the generic searchable list (`SessionPickerList`)
 * and the model catalog's provider-grouped variant (`ModelPickerRows`).
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  SessionPickerList,
  ModelPickerRows,
  type SessionPickerGroup,
} from "./session-pickers";
import { ChatSessionProvider, useChatSession } from "./session-store";
import type { SessionSeed } from "./session-state";
import type { ResolvedTierCatalog } from "@oxagen/ai/catalog";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const GROUPS: SessionPickerGroup[] = [
  {
    id: "g1",
    label: "Group one",
    rows: [
      { id: "a", label: "Alpha", sublabel: "first" },
      { id: "b", label: "Bravo" },
    ],
  },
  {
    id: "g2",
    label: "Group two",
    rows: [{ id: "c", label: "Charlie" }],
  },
];

describe("SessionPickerList", () => {
  it("filters rows as the search query changes", () => {
    render(
      <SessionPickerList
        groups={GROUPS}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Charlie")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "char" },
    });

    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.queryByText("Bravo")).not.toBeInTheDocument();
    expect(screen.getByText("Charlie")).toBeInTheDocument();
  });

  it("shows the empty message when nothing matches", () => {
    render(
      <SessionPickerList
        groups={GROUPS}
        selectedId={null}
        onSelect={() => {}}
        emptyMessage="Nothing here"
      />,
    );
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "zzz-no-match" },
    });
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });

  it("writes the selected row id via onSelect", () => {
    let selected: string | null = null;
    render(
      <SessionPickerList
        groups={GROUPS}
        selectedId={null}
        onSelect={(id) => {
          selected = id;
        }}
      />,
    );
    fireEvent.click(screen.getByText("Bravo"));
    expect(selected).toBe("b");
  });

  it("marks the currently selected row aria-selected", () => {
    render(
      <SessionPickerList groups={GROUPS} selectedId="c" onSelect={() => {}} />,
    );
    expect(screen.getByRole("option", { name: /Charlie/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("option", { name: /Alpha/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });
});

const MODEL_CONFIG: ResolvedTierCatalog = {
  text: {
    fast: "anthropic/claude-haiku-4.5",
    balanced: "anthropic/claude-sonnet-5",
    precise: "anthropic/claude-opus-4.8",
  },
  image: {
    basic: "google/gemini-3.1-flash-image-preview",
    advanced: "bfl/flux-2-max",
  },
  video: {
    basic: "google/veo-3.0-fast-generate-001",
    advanced: "google/veo-3.0-generate-001",
  },
};

const SEED: SessionSeed = {
  defaultAgentId: null,
  defaultRepoKey: null,
  defaultEnvId: null,
  textModel: null,
  textTier: "fast",
  budgetUsd: null,
};

function ModelHarness() {
  const { state, updateSession } = useChatSession();
  return (
    <div>
      <output data-testid="model">{state.model ?? "none"}</output>
      <output data-testid="tier">{state.tier ?? "none"}</output>
      <ModelPickerRows
        modelConfig={MODEL_CONFIG}
        tier={state.tier}
        model={state.model}
        onSelectTier={(tier) => updateSession({ tier })}
        onSelectModel={(id) => updateSession({ model: id })}
      />
    </div>
  );
}

function renderModelHarness() {
  return render(
    <ChatSessionProvider
      workspaceSlug="ws"
      conversationId={null}
      boundAgentId={null}
      isNewConversation
      hasMessages={false}
      seed={SEED}
    >
      <ModelHarness />
    </ChatSessionProvider>,
  );
}

describe("ModelPickerRows", () => {
  it("shows the Anthropic provider group before any other vendor", () => {
    renderModelHarness();
    fireEvent.click(screen.getByText("All providers"));
    const groupHeaders = screen
      .getAllByRole("group")
      .map((el) => el.getAttribute("aria-label"));
    const anthropicIndex = groupHeaders.indexOf("Anthropic");
    const openaiIndex = groupHeaders.indexOf("OpenAI");
    expect(anthropicIndex).toBeGreaterThanOrEqual(0);
    expect(openaiIndex).toBeGreaterThan(anthropicIndex);
  });

  it('expands the remaining provider groups on "All providers"', () => {
    renderModelHarness();
    expect(screen.queryByText("GPT-5.2")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("All providers"));
    expect(screen.getByText("GPT-5.2")).toBeInTheDocument();
  });

  it("writes an explicit model selection to the session store", () => {
    renderModelHarness();
    fireEvent.click(screen.getByText("All providers"));
    fireEvent.click(screen.getByText("GPT-5.2"));
    expect(screen.getByTestId("model").textContent).toBe("openai/gpt-5.2");
  });

  it("writes a tier selection to the session store", () => {
    renderModelHarness();
    fireEvent.click(screen.getByText("Oxagen Precise"));
    expect(screen.getByTestId("tier").textContent).toBe("precise");
  });
});
