// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CREATE_EVENT,
  CREATE_KINDS,
  createRequestOf,
  openCreate,
} from "./create";

const listeners: ((e: Event) => void)[] = [];
afterEach(() => {
  for (const l of listeners.splice(0))
    window.removeEventListener(CREATE_EVENT, l);
});
function listen() {
  const seen = vi.fn((e: Event) => createRequestOf(e));
  listeners.push(seen);
  window.addEventListener(CREATE_EVENT, seen);
  return seen;
}

describe("openCreate", () => {
  it("asks for the chooser when it names no kind", () => {
    const seen = listen();
    openCreate();
    expect(seen.mock.results[0]?.value).toEqual({ kind: null });
  });

  it("asks for one kind's wizard", () => {
    const seen = listen();
    openCreate("skill");
    expect(seen.mock.results[0]?.value).toEqual({ kind: "skill" });
  });
});

describe("createRequestOf", () => {
  it("offers the skill and context-record wizards today and keeps the tool kind out", () => {
    expect(CREATE_KINDS).toContain("skill");
    expect(CREATE_KINDS).toContain("record");
    expect(CREATE_KINDS).not.toContain("tool");
  });

  it("refuses a plain event, a missing detail and a kind no wizard hosts (negative)", () => {
    expect(createRequestOf(new Event(CREATE_EVENT))).toBeNull();
    expect(createRequestOf(new CustomEvent(CREATE_EVENT))).toBeNull();
    expect(
      createRequestOf(
        new CustomEvent(CREATE_EVENT, { detail: { kind: "tool" } }),
      ),
    ).toBeNull();
    expect(
      createRequestOf(new CustomEvent(CREATE_EVENT, { detail: { kind: 7 } })),
    ).toBeNull();
  });
});

describe("context description prefill", () => {
  it("passes a finding draft without submitting anything", () => {
    const seen = listen();
    openCreate("record", {
      description: "Finding fnd_1: paginate repeated tool results.",
    });
    expect(seen.mock.results[0]?.value).toEqual({
      kind: "record",
      prefill: {
        description: "Finding fnd_1: paginate repeated tool results.",
      },
    });
  });
  it.each([
    { kind: "skill", prefill: { description: "Wrong wizard" } },
    { kind: "record", prefill: { description: 42 } },
    { kind: "record", prefill: { description: " " } },
    { kind: "record", prefill: { description: "x".repeat(2001) } },
    { kind: "record", prefill: null },
  ])("rejects invalid prefill %j", (detail) => {
    expect(
      createRequestOf(new CustomEvent(CREATE_EVENT, { detail })),
    ).toBeNull();
  });
});
