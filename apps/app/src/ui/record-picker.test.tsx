// @vitest-environment jsdom
// The record pickers (record-picker.tsx): typing narrows the list by name,
// slug or id; the arrow keys and Enter pick; the hidden input carries the id
// in the shape the old text field sent; a freeform picker keeps typed
// patterns; `load` runs once, on first open. Every test ends in an axe check.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  type OptionLoad,
  type PickerOption,
  RecordMultiPicker,
  RecordPicker,
} from "./record-picker";

const AGENTS: PickerOption[] = [
  { value: "agt_1", label: "Billing reconciler", detail: "billing-reconciler" },
  { value: "agt_2", label: "Release captain", detail: "release-captain" },
  { value: "agt_3", label: "Docs gardener", detail: "docs-gardener" },
];

function hidden(container: HTMLElement, name: string): string {
  const input = container.querySelector<HTMLInputElement>(
    `input[type="hidden"][name="${name}"]`,
  );
  if (input === null) throw new Error(`no hidden input named ${name}`);
  return input.value;
}

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("RecordPicker", () => {
  it("finds a record by part of its name and submits its id", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <IntlProvider>
        <label htmlFor="agent">Agent</label>
        <RecordPicker id="agent" name="agentId" options={AGENTS} />
      </IntlProvider>,
    );
    const input = screen.getByRole("combobox", { name: "Agent" });
    await user.type(input, "capt");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Release captain");
    await user.keyboard("{Enter}");
    expect(hidden(container, "agentId")).toBe("agt_2");
    expect(input).toHaveValue("Release captain");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("matches the detail line, so a slug finds its record", async () => {
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <label htmlFor="agent">Agent</label>
        <RecordPicker id="agent" name="agentId" options={AGENTS} />
      </IntlProvider>,
    );
    await user.type(screen.getByRole("combobox"), "docs-g");
    expect(screen.getByRole("option")).toHaveTextContent("Docs gardener");
  });

  it("puts the label back when a person types and leaves without picking", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <IntlProvider>
        <label htmlFor="agent">Agent</label>
        <RecordPicker
          id="agent"
          name="agentId"
          options={AGENTS}
          defaultValue="agt_1"
        />
        <button type="button">elsewhere</button>
      </IntlProvider>,
    );
    const input = screen.getByRole("combobox");
    expect(input).toHaveValue("Billing reconciler");
    await user.clear(input);
    await user.type(input, "zzz");
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(hidden(container, "agentId")).toBe("");
    expect(input).toHaveValue("");
  });

  it("is required only until a record is picked", async () => {
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <label htmlFor="agent">Agent</label>
        <RecordPicker id="agent" name="agentId" options={AGENTS} required />
      </IntlProvider>,
    );
    const input = screen.getByRole("combobox");
    expect(input).toBeRequired();
    await user.click(input);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(input).not.toBeRequired();
  });

  it("loads its options once, on first open", async () => {
    const user = userEvent.setup();
    const load = vi.fn(
      (): Promise<OptionLoad> =>
        Promise.resolve({
          ok: true,
          value: { options: AGENTS, partial: true },
        }),
    );
    render(
      <IntlProvider>
        <label htmlFor="agent">Agent</label>
        <RecordPicker id="agent" name="agentId" load={load} />
        <button type="button">elsewhere</button>
      </IntlProvider>,
    );
    expect(load).not.toHaveBeenCalled();
    await user.click(screen.getByRole("combobox"));
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(3);
    });
    expect(screen.getByRole("status")).toHaveTextContent(/first page only/);
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    await user.click(screen.getByRole("combobox"));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("says so when the list cannot be loaded", async () => {
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <label htmlFor="agent">Agent</label>
        <RecordPicker
          id="agent"
          name="agentId"
          load={() => Promise.resolve({ ok: false })}
        />
      </IntlProvider>,
    );
    await user.click(screen.getByRole("combobox"));
    expect(await screen.findByRole("status")).toHaveTextContent(
      /could not be loaded/,
    );
  });
});

describe("RecordMultiPicker", () => {
  it("picks several records as chips and joins their ids", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <IntlProvider>
        <label htmlFor="agents">Agents</label>
        <RecordMultiPicker id="agents" name="agents" options={AGENTS} />
      </IntlProvider>,
    );
    const input = screen.getByRole("combobox", { name: "Agents" });
    await user.type(input, "bill");
    await user.keyboard("{Enter}");
    await user.type(input, "docs");
    await user.keyboard("{Enter}");
    expect(hidden(container, "agents")).toBe("agt_1, agt_3");
    expect(
      screen.getByRole("button", { name: "Remove Billing reconciler" }),
    ).toBeInTheDocument();
  });

  it("removes a chip with its button or with Backspace", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <IntlProvider>
        <label htmlFor="agents">Agents</label>
        <RecordMultiPicker
          id="agents"
          name="agents"
          options={AGENTS}
          defaultValue={["agt_1", "agt_2", "agt_3"]}
        />
      </IntlProvider>,
    );
    await user.click(
      screen.getByRole("button", { name: "Remove Release captain" }),
    );
    expect(hidden(container, "agents")).toBe("agt_1, agt_3");
    await user.click(screen.getByRole("combobox"));
    await user.keyboard("{Backspace}");
    expect(hidden(container, "agents")).toBe("agt_1");
  });

  it("keeps typed patterns in freeform mode, one per line when asked", async () => {
    const user = userEvent.setup();
    const tools: PickerOption[] = [
      { value: "github__create_issue@1", label: "github__create_issue@1" },
    ];
    const { container } = render(
      <IntlProvider>
        <label htmlFor="tools">Tools</label>
        <RecordMultiPicker
          id="tools"
          name="tools"
          options={tools}
          freeform
          joiner={"\n"}
        />
        <button type="button">elsewhere</button>
      </IntlProvider>,
    );
    const input = screen.getByRole("combobox");
    await user.type(input, "github__*");
    expect(screen.getAllByRole("option")[0]).toHaveTextContent(
      "Use “github__*”",
    );
    await user.keyboard("{Enter}");
    await user.type(input, "stripe__*, slack__*,");
    await user.type(input, "linear__*");
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(hidden(container, "tools")).toBe(
      "github__*\nstripe__*\nslack__*\nlinear__*",
    );
  });

  it("keeps a space inside a freeform entry, so a two-word name still matches", async () => {
    const user = userEvent.setup();
    const people: PickerOption[] = [
      {
        value: "user:usr_1",
        label: "Priya Natarajan",
        detail: "priya@acme.test",
      },
    ];
    const { container } = render(
      <IntlProvider>
        <label htmlFor="approvers">Approvers</label>
        <RecordMultiPicker
          id="approvers"
          name="approvers"
          options={people}
          freeform
        />
      </IntlProvider>,
    );
    await user.type(screen.getByRole("combobox"), "Priya N");
    await user.keyboard("{Enter}");
    expect(hidden(container, "approvers")).toBe("user:usr_1");
  });

  it("reads its list up front when prefilled, so chips show names", async () => {
    const load = vi.fn(
      (): Promise<OptionLoad> =>
        Promise.resolve({
          ok: true,
          value: { options: AGENTS, partial: false },
        }),
    );
    render(
      <IntlProvider>
        <label htmlFor="agents">Agents</label>
        <RecordMultiPicker
          id="agents"
          name="agents"
          load={load}
          defaultValue={["agt_2"]}
        />
      </IntlProvider>,
    );
    expect(
      await screen.findByRole("button", { name: "Remove Release captain" }),
    ).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("drops typed text that matches nothing when not freeform", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <IntlProvider>
        <label htmlFor="agents">Agents</label>
        <RecordMultiPicker id="agents" name="agents" options={AGENTS} />
        <button type="button">elsewhere</button>
      </IntlProvider>,
    );
    await user.type(screen.getByRole("combobox"), "nobody");
    expect(screen.getByRole("status")).toHaveTextContent(/Nothing matches/);
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(hidden(container, "agents")).toBe("");
  });

  it("toggles an already-chosen option off when it is picked again", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <IntlProvider>
        <label htmlFor="agents">Agents</label>
        <RecordMultiPicker
          id="agents"
          options={AGENTS}
          value={["agt_2"]}
          onChange={onChange}
        />
      </IntlProvider>,
    );
    await user.type(screen.getByRole("combobox"), "release");
    const option = screen.getByRole("option");
    expect(option).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("keeps a chosen value when its exact text is typed again (negative)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <IntlProvider>
        <label htmlFor="tools">Tools</label>
        <RecordMultiPicker
          id="tools"
          options={[{ value: "github__*", label: "github__*" }]}
          value={["github__*"]}
          onChange={onChange}
          freeform
        />
      </IntlProvider>,
    );
    const input = screen.getByRole("combobox");
    await user.type(input, "github__*");
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("");
  });

  it("keeps a chosen record when its full name is typed in any case (negative)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <IntlProvider>
        <label htmlFor="agents">Agents</label>
        <RecordMultiPicker
          id="agents"
          options={AGENTS}
          value={["agt_2"]}
          onChange={onChange}
        />
      </IntlProvider>,
    );
    const input = screen.getByRole("combobox");
    await user.type(input, "release captain");
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("");
  });
});
