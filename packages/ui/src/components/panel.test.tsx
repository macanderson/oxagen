// panel.test.tsx — render-composition tests for the titled Panel surface.
// Exercised through SSR (renderToStaticMarkup) so we verify the actual DOM
// structure/order without @testing-library/react, staying in the node env.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Panel } from "./panel";

describe("Panel", () => {
  it("renders body children inside the surface section", () => {
    const html = renderToStaticMarkup(<Panel>Body content</Panel>);
    expect(html).toContain("<section");
    expect(html).toContain("Body content");
    expect(html).toContain("bg-card");
    expect(html).toContain("rounded-xl");
  });

  it("omits the header entirely when no title/eyebrow/actions are passed", () => {
    const html = renderToStaticMarkup(<Panel>Just a body</Panel>);
    expect(html).not.toContain("<header");
  });

  it("renders eyebrow above the title in the header", () => {
    const html = renderToStaticMarkup(
      <Panel eyebrow="Workspace" title="General settings">
        body
      </Panel>,
    );
    expect(html).toContain("<header");
    expect(html).toContain("<h3");
    const eyebrowAt = html.indexOf("Workspace");
    const titleAt = html.indexOf("General settings");
    expect(eyebrowAt).toBeGreaterThanOrEqual(0);
    expect(titleAt).toBeGreaterThan(eyebrowAt);
  });

  it("renders an actions slot when provided", () => {
    const html = renderToStaticMarkup(
      <Panel title="Models" actions={<button data-slot="action">Edit</button>}>
        body
      </Panel>,
    );
    expect(html).toContain('data-slot="action"');
  });

  it("renders a footer below the body on a tinted bar", () => {
    const html = renderToStaticMarkup(
      <Panel title="Billing" footer={<span data-slot="footer">Save</span>}>
        body
      </Panel>,
    );
    expect(html).toContain("<footer");
    expect(html).toContain('data-slot="footer"');
    expect(html).toContain("border-t");
    const bodyAt = html.indexOf(">body<");
    const footerAt = html.indexOf("<footer");
    expect(footerAt).toBeGreaterThan(bodyAt);
  });

  it("removes body padding when inset", () => {
    const inset = renderToStaticMarkup(<Panel inset>table</Panel>);
    const padded = renderToStaticMarkup(<Panel>table</Panel>);
    expect(inset).toContain("p-0");
    expect(padded).toContain("p-[18px]");
  });

  it("accepts the back-compat brand treatments without emitting any class", () => {
    // Both treatments are inert by design in this flat skin (Card ignores them
    // too). The props stay on the type for back-compat, but Panel must emit no
    // class for them — a class no stylesheet defines is dead weight.
    const html = renderToStaticMarkup(
      <Panel glow gradientRing title="Brand">
        body
      </Panel>,
    );
    expect(html).not.toContain("ox-glow-violet");
    expect(html).not.toContain("gradient-ring");
    expect(html).toContain("bg-card");
  });

  it("merges a custom className onto the surface", () => {
    const html = renderToStaticMarkup(
      <Panel className="col-span-2">body</Panel>,
    );
    expect(html).toContain("col-span-2");
    expect(html).toContain("bg-card");
  });
});
