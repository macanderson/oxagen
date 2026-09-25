// @vitest-environment jsdom
// The tool calls behind one assistant reply (#4161): closed by default under
// the reply with a count, one line per call with its label, outcome and
// duration, and the raw tool name, call id and (for a parked call) approval id
// in each line's detail.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import type { ToolCallSummary } from "./assistant-actions";
import { AssistantToolCalls, toolLabel } from "./assistant-tool-calls";

const APPROVAL = "0a1b2c3d-0000-4000-8000-00000000a001";

const CALLS: readonly ToolCallSummary[] = [
  {
    toolCallId: "tc-completed",
    toolName: "list_runs",
    outcome: "completed",
    durationMs: 41,
    approvalId: null,
  },
  {
    toolCallId: "tc-denied",
    toolName: "delete_agent",
    outcome: "denied",
    durationMs: 3,
    approvalId: null,
  },
  {
    toolCallId: "tc-parked",
    toolName: "set_budget",
    outcome: "parked",
    durationMs: 4,
    approvalId: APPROVAL,
  },
  {
    toolCallId: "tc-failed",
    toolName: "query_ontology",
    outcome: "failed",
    durationMs: 1_250,
    approvalId: null,
  },
];

function renderCalls(calls: readonly ToolCallSummary[] = CALLS) {
  return render(
    <IntlProvider>
      <AssistantToolCalls calls={calls} />
    </IntlProvider>,
  );
}

function row(toolCallId: string): HTMLElement {
  const found = screen
    .getAllByTestId("assistant-tool-call")
    .find((item) => item.textContent.includes(toolCallId));
  if (found === undefined) throw new Error(`no row for ${toolCallId}`);
  return found;
}

afterEach(cleanup);

describe("AssistantToolCalls", () => {
  it("draws nothing for a reply that made no tool calls", () => {
    const { container } = renderCalls([]);
    expect(container.innerHTML).toBe("");
  });

  it("sits closed under the reply and counts the calls", () => {
    renderCalls();
    const list = screen.getByTestId("assistant-tool-calls");
    expect(list.tagName).toBe("DETAILS");
    expect(list).not.toHaveProperty("open", true);
    expect(within(list).getByText("4 tool calls")).toBeTruthy();
  });

  it("says one tool call in the singular", () => {
    renderCalls(CALLS.slice(0, 1));
    expect(screen.getByText("1 tool call")).toBeTruthy();
  });

  it("gives each call one line with its label, outcome and duration", () => {
    renderCalls();
    const rows = screen.getAllByTestId("assistant-tool-call");
    expect(rows.map((item) => item.dataset.outcome)).toEqual([
      "completed",
      "denied",
      "parked",
      "failed",
    ]);

    const outcomes = rows.map(
      (item) =>
        within(item).getByTestId("assistant-tool-call-outcome").textContent,
    );
    expect(outcomes).toEqual([
      "Completed",
      "Denied",
      "Waiting for approval",
      "Failed",
    ]);

    expect(within(row("tc-completed")).getByText("List runs")).toBeTruthy();
    expect(within(row("tc-completed")).getByText("41 ms")).toBeTruthy();
    expect(within(row("tc-denied")).getByText("Delete agent")).toBeTruthy();
    expect(within(row("tc-parked")).getByText("Set budget")).toBeTruthy();
    expect(within(row("tc-parked")).getByText("4 ms")).toBeTruthy();
    expect(within(row("tc-failed")).getByText("Query ontology")).toBeTruthy();
    expect(within(row("tc-failed")).getByText("1.3 s")).toBeTruthy();
  });

  it("keeps the raw tool name and call id in each line's detail", () => {
    renderCalls();
    const completed = row("tc-completed");
    expect(within(completed).getByText("list_runs")).toBeTruthy();
    expect(within(completed).getByText("tc-completed")).toBeTruthy();
    expect(within(completed).getByText("Call id")).toBeTruthy();
  });

  it("names the approval behind a parked call, and only that call", () => {
    renderCalls();
    const approvals = screen.getAllByTestId("assistant-tool-call-approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.textContent).toBe(APPROVAL);
    expect(row("tc-parked").contains(approvals[0] ?? null)).toBe(true);
    for (const id of ["tc-completed", "tc-denied", "tc-failed"]) {
      expect(within(row(id)).queryByText("Approval id")).toBeNull();
    }
  });

  it("opens the list and a line when a person clicks them", async () => {
    const user = userEvent.setup();
    renderCalls();
    const list = screen.getByTestId("assistant-tool-calls");
    await user.click(within(list).getByText("4 tool calls"));
    expect(list).toHaveProperty("open", true);

    const parked = row("tc-parked").querySelector("details");
    expect(parked).not.toBeNull();
    await user.click(within(row("tc-parked")).getByText("Set budget"));
    expect(parked).toHaveProperty("open", true);
  });

  it("passes axe closed and open", async () => {
    const { container } = renderCalls();
    await expectNoAxe(container);
    for (const details of container.querySelectorAll("details")) {
      details.open = true;
    }
    await expectNoAxe(container);
  });
});

describe("toolLabel", () => {
  it("reads a capability name as words", () => {
    expect(toolLabel("list_runs")).toBe("List runs");
    expect(toolLabel("get_prompt_settings")).toBe("Get prompt settings");
  });

  it("reads a dotted or doubled separator the same way", () => {
    expect(toolLabel("ontology.query")).toBe("Ontology query");
    expect(toolLabel("github__create_issue")).toBe("Github create issue");
  });

  it("keeps a name with no words as it is", () => {
    expect(toolLabel("___")).toBe("___");
    expect(toolLabel("")).toBe("");
  });
});
