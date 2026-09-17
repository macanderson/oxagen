// @vitest-environment jsdom
// expectNoAxe (INV-26): a container axe-core finds a WCAG violation in fails
// with the rule and the markup; a clean one passes.
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "./expect-no-axe";

function mount(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  return container;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("expectNoAxe", () => {
  it("passes a container with named controls", async () => {
    await expectNoAxe(
      mount(
        '<button type="button">Approve</button><img src="/a.png" alt="Acme">',
      ),
    );
  });

  it("leaves out Base UI's focus guards, and still fails an unnamed button beside one (negative)", async () => {
    const guard =
      '<span data-base-ui-focus-guard="" role="button" tabindex="0"></span>';
    await expectNoAxe(mount(guard));
    await expect(
      expectNoAxe(mount(`${guard}<button type="button"></button>`)),
    ).rejects.toThrow(/button-name/);
  });

  it("fails a button with no accessible name and an image with no text alternative (negative)", async () => {
    const container = mount(
      '<button type="button"></button><img src="/a.png">',
    );
    await expect(expectNoAxe(container)).rejects.toThrow(/button-name/);
    await expect(expectNoAxe(container)).rejects.toThrow(/image-alt/);
  });
});
