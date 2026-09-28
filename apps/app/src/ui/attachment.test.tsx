// @vitest-environment jsdom
// The attachment chip, ported from shadcn's base attachment (#4690): each
// slot carries the data attribute the styles read, an uploading chip is busy,
// the line under the name keeps each fact in its own element, and the action
// is a named button that never submits the form around it.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "./attachment";

afterEach(cleanup);

function Chip({
  state,
  onSubmit = () => undefined,
}: {
  state?: "uploading" | "error" | "done";
  onSubmit?: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <AttachmentGroup>
        <Attachment state={state} size="sm" data-testid="chip">
          <AttachmentMedia>
            <svg aria-hidden="true" />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle title="report.pdf">report.pdf</AttachmentTitle>
            <AttachmentDescription data-testid="description">
              <span>PDF</span>
              <span>2.4 MB</span>
            </AttachmentDescription>
          </AttachmentContent>
          <AttachmentActions>
            <AttachmentAction aria-label="Remove report.pdf">
              <svg aria-hidden="true" />
            </AttachmentAction>
          </AttachmentActions>
        </Attachment>
      </AttachmentGroup>
    </form>
  );
}

describe("Attachment", () => {
  it("marks every slot and carries the state and size the styles read", () => {
    const { container } = render(<Chip state="error" />);
    const chip = screen.getByTestId("chip");
    expect(chip).toHaveAttribute("data-slot", "attachment");
    expect(chip).toHaveAttribute("data-state", "error");
    expect(chip).toHaveAttribute("data-size", "sm");
    for (const slot of [
      "attachment-group",
      "attachment-media",
      "attachment-content",
      "attachment-title",
      "attachment-description",
      "attachment-actions",
      "attachment-action",
    ]) {
      expect(container.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-slot="attachment-media"]')).toHaveAttribute(
      "data-variant",
      "icon",
    );
  });

  it("is a finished file by default and busy only while it uploads", () => {
    const { rerender } = render(<Chip />);
    expect(screen.getByTestId("chip")).toHaveAttribute("data-state", "done");
    expect(screen.getByTestId("chip")).not.toHaveAttribute("aria-busy");
    rerender(<Chip state="uploading" />);
    expect(screen.getByTestId("chip")).toHaveAttribute("aria-busy", "true");
  });

  it("keeps the kind and the size in separate elements with no punctuation between them", () => {
    render(<Chip />);
    const description = screen.getByTestId("description");
    expect(Array.from(description.children, (c) => c.textContent)).toEqual([
      "PDF",
      "2.4 MB",
    ]);
    expect(description.textContent).not.toMatch(/[·,]/);
  });

  it("draws its action as a named button that does not submit the form (negative)", () => {
    const onSubmit = vi.fn();
    render(<Chip onSubmit={onSubmit} />);
    const remove = screen.getByRole("button", { name: "Remove report.pdf" });
    expect(remove).toHaveAttribute("type", "button");
    fireEvent.click(remove);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
