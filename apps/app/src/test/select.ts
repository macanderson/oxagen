// Drives the app's Select (`@/ui/select`) from a test. The trigger is a
// button with the combobox role, and its options exist in the accessibility
// tree only while the list is open. A closed list stays in the DOM, hidden,
// so each helper waits for the listbox to leave before it returns. A test
// that opens the same select twice then finds one set of options.
import { screen, waitFor } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { expect } from "vitest";

type Pointer = Pick<UserEvent, "click" | "keyboard">;

async function listClosed() {
  await waitFor(() => {
    expect(screen.queryByRole("listbox")).toBeNull();
  });
}

/** Opens the select and picks the option with this accessible name. */
export async function pickOption(
  user: Pointer,
  trigger: HTMLElement,
  name: string,
): Promise<void> {
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name }));
  await listClosed();
}

/** Opens the select, reads each option's text in order, and closes it. */
export async function optionNames(
  user: Pointer,
  trigger: HTMLElement,
): Promise<string[]> {
  await user.click(trigger);
  const names = (await screen.findAllByRole("option")).map(
    (option) => option.textContent,
  );
  await user.keyboard("{Escape}");
  await listClosed();
  return names;
}
