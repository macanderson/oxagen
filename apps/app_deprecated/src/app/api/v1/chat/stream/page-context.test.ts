/**
 * page-context.test.ts
 *
 * Unit tests for buildPageContextMessage — the per-turn USER message that
 * carries the volatile page context (route + optional entity summary + fillable
 * form fields with their live values). This message replaces the old
 * `pageContextSystemSuffix` that used to be folded into the CACHED system prompt
 * and busted the Anthropic prompt-cache breakpoint on every navigation
 * (ADR-021 §2). These tests lock in that:
 *   (a) no page context ⇒ no message (undefined)
 *   (b) route-only page context produces a user message with just the location
 *   (c) an entity summary is included when present
 *   (d) a fillable form renders fields, live current values, options, required
 *       markers, and the form-fill behavior rules
 *   (e) the message is a USER message (never system) — the whole point of the
 *       extraction, keeping the cached system prefix byte-stable
 */

import { describe, it, expect } from "vitest";
import { buildPageContextMessage } from "./page-context";

describe("buildPageContextMessage", () => {
  it("returns undefined when there is no page context", () => {
    expect(buildPageContextMessage(null)).toBeUndefined();
    expect(buildPageContextMessage(undefined)).toBeUndefined();
  });

  it("builds a user message with just the route when no form is present", () => {
    const msg = buildPageContextMessage({ route: "/acme/ws/knowledge" });
    expect(msg).toBeDefined();
    // The whole point of the extraction: volatile context rides as a USER
    // message, NOT the cached system prompt.
    expect(msg?.role).toBe("user");
    const content = msg?.content as string;
    expect(content).toContain("## Current page");
    expect(content).toContain("Route: /acme/ws/knowledge");
    // No leading "---" separator (that was a system-prompt-append artifact) and
    // no form section when there is no fillable form.
    expect(content.startsWith("## Current page")).toBe(true);
    expect(content).not.toContain("### Fillable form");
  });

  it("includes the entity summary when present", () => {
    const msg = buildPageContextMessage({
      route: "/acme/ws/knowledge/node/abc",
      entitySummary: "Node: Acme Corp (organization)",
    });
    const content = msg?.content as string;
    expect(content).toContain("Entity: Node: Acme Corp (organization)");
  });

  it("renders a fillable form with fields, live values, options, and required markers", () => {
    const msg = buildPageContextMessage({
      route: "/acme/ws/settings",
      fillableForm: {
        formId: "settings-form",
        title: "Workspace settings",
        fields: [
          {
            name: "displayName",
            label: "Display name",
            type: "text",
            current: "Acme",
            required: true,
          },
          {
            name: "tier",
            label: "Tier",
            type: "select",
            current: "",
            options: [
              { label: "Free", value: "free" },
              { label: "Pro", value: "pro" },
            ],
          },
        ],
      },
    });
    const content = msg?.content as string;
    expect(msg?.role).toBe("user");
    expect(content).toContain("### Fillable form");
    expect(content).toContain('Form: "Workspace settings" (id: settings-form)');
    // Required marker + live current value are surfaced.
    expect(content).toContain(
      '  - displayName (Display name) type=text required current="Acme"',
    );
    // Empty current value is omitted; options are listed by label.
    expect(content).toContain(
      '  - tier (Tier) type=select options=["Free", "Pro"]',
    );
    expect(content).not.toContain("tier (Tier) type=select required");
    // Behavior rules for the page_form_fill tool are present.
    expect(content).toContain("**Behavior rules for form fill:**");
    expect(content).toContain("`page_form_fill`");
  });

  it("omits current when the field value is null/undefined/empty", () => {
    const msg = buildPageContextMessage({
      route: "/acme/ws/settings",
      fillableForm: {
        formId: "f1",
        title: "Form",
        fields: [
          { name: "a", label: "A", type: "text", current: null },
          { name: "b", label: "B", type: "text" },
        ],
      },
    });
    const content = msg?.content as string;
    expect(content).toContain("  - a (A) type=text");
    expect(content).toContain("  - b (B) type=text");
    expect(content).not.toContain("current=");
  });
});
