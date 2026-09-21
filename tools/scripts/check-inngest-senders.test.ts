import { describe, expect, it } from "vitest";
import {
  eventResolver,
  orphans,
  sendersIn,
  triggersIn,
  type Trigger,
} from "./check-inngest-senders";

const FUNCTION_SOURCE = `
export const [chatPersistStream] = createFunction(
  { id: "chat.persist-stream", retries: 3 },
  { event: "chat/message.streamed" },
  async ({ event, step }) => {},
);
`;

const SENDER_SOURCE = `
await eventClient.send({
  name: "schema/reconcile.start",
  data: { orgId, workspaceId },
});
`;

/** The shape that made #2823 hard to see: a name literal that sends nothing. */
const TYPE_ANNOTATION_SOURCE = `
type RepoEvent = {
  name: "ingestion/entity.received";
  data: { connectionId: string };
};
`;

describe("triggersIn", () => {
  it("reads the trigger event and the line it sits on", () => {
    expect(triggersIn(FUNCTION_SOURCE, "chat.persist-stream.ts")).toEqual([
      { event: "chat/message.streamed", location: "chat.persist-stream.ts:4" },
    ]);
  });

  it("returns nothing for a file that declares no trigger", () => {
    expect(triggersIn("export const x = 1;", "x.ts")).toEqual([]);
  });
});

describe("sendersIn", () => {
  it("reads the event name a send call ships", () => {
    expect(sendersIn(SENDER_SOURCE)).toEqual(["schema/reconcile.start"]);
  });

  it("reads a name declared several lines above its send call", () => {
    // github-webhook.ts builds an array of events and sends it at the end;
    // a line-local match would miss every one of them.
    const batched = `
      const events = [{ name: "ingestion/entity.received", data: {} }];
      // …forty lines of mapping…
      await eventClient.send(events);
    `;
    expect(sendersIn(batched)).toEqual(["ingestion/entity.received"]);
  });

  it("does not read a type annotation as a sender", () => {
    expect(sendersIn(TYPE_ANNOTATION_SOURCE)).toEqual([]);
  });
});

describe("orphans", () => {
  const triggers: Trigger[] = [
    { event: "chat/message.streamed", location: "chat.persist-stream.ts:19" },
    { event: "schema/reconcile.start", location: "schema.reconcile.ts:98" },
    { event: "inngest/function.failed", location: "capture-failure.ts:47" },
  ];

  it("catches the #2823 state — a retries:3 trigger nothing sends", () => {
    const dead = orphans(triggers, new Set(["schema/reconcile.start"]));
    expect(dead).toEqual([
      { event: "chat/message.streamed", location: "chat.persist-stream.ts:19" },
    ]);
  });

  it("passes once the event is sent", () => {
    const sent = new Set(["chat/message.streamed", "schema/reconcile.start"]);
    expect(orphans(triggers, sent)).toEqual([]);
  });

  it("does not ask for a sender for an event the platform emits", () => {
    // inngest/function.failed comes from Inngest when a run exhausts its
    // retries; no code here sends it and none should.
    expect(orphans(triggers, new Set())).not.toContainEqual(
      expect.objectContaining({ event: "inngest/function.failed" }),
    );
  });
});

describe("constant event names", () => {
  const files = new Map([
    [
      "/events.ts",
      'export const PRICE_BOOK_BACKDATED_EVENT = "cost/price-book.backdated" as const;',
    ],
    [
      "/barrel.ts",
      'export { PRICE_BOOK_BACKDATED_EVENT as BACKDATED } from "./events";',
    ],
  ]);
  const resolver = () =>
    eventResolver(
      (file) => {
        const source = files.get(file);
        if (!source) throw new Error(`Missing fixture ${file}`);
        return source;
      },
      (name) => `${name.slice(1)}.ts`,
    );
  const trigger = `import { BACKDATED as EVENT } from "./barrel";
    createFunction({}, {event: EVENT}, async () => {});`;

  it("finds an orphan when a shared-constant event has no sender", () => {
    const found = triggersIn(trigger, "/consumer.ts", resolver());
    expect(found.map((row) => row.event)).toEqual([
      "cost/price-book.backdated",
    ]);
    expect(orphans(found, new Set())).toEqual(found);
    const sender = `import { PRICE_BOOK_BACKDATED_EVENT as EVENT } from "./events";
      const ALIAS = EVENT; client.send({name: ALIAS});`;
    expect(
      orphans(found, new Set(sendersIn(sender, "/sender.ts", resolver()))),
    ).toEqual([]);
  });

  it("rejects unresolved, mutable, and shadowed trigger constants", () => {
    for (const source of [
      "createFunction({}, {event: UNKNOWN}, handler);",
      'let EVENT = "mutable"; createFunction({}, {event: EVENT}, handler);',
      'const EVENT = "outer"; function register(EVENT: string) { createFunction({}, {event: EVENT}, handler); }',
      'const EVENT = "outer"; function register({EVENT}: {EVENT: string}) { createFunction({}, {event: EVENT}, handler); }',
      'const EVENT = "outer"; try {} catch (EVENT) { createFunction({}, {event: EVENT}, handler); }',
      'const EVENT = "outer"; { const EVENT = dynamic(); createFunction({}, {event: EVENT}, handler); }',
      "const FIRST = SECOND; const SECOND = FIRST; createFunction({}, {event: FIRST}, handler);",
    ])
      expect(() => triggersIn(source, "/consumer.ts", resolver())).toThrow(
        "cannot resolve",
      );
  });

  it("reads constant waits and ignores comments and type declarations", () => {
    expect(
      triggersIn(
        'const EVENT = "ready"; step.waitForEvent("wait", {event: EVENT});',
        "/wait.ts",
      ).map((row) => row.event),
    ).toEqual(["ready"]);
    expect(
      triggersIn(
        '// createFunction({}, {event: "fiction"}, handler);',
        "/comment.ts",
      ),
    ).toEqual([]);
    expect(
      sendersIn('type Named = {name: "fiction"}; client.send(payload);'),
    ).toEqual([]);
  });

  it("rejects a dynamic registration object instead of losing its trigger", () => {
    for (const trigger of [
      "dynamicTrigger",
      "{...dynamicTrigger}",
      "[dynamicTrigger]",
      "[...dynamicTriggers]",
      "{event}",
    ]) {
      expect(() =>
        triggersIn(`createFunction({}, ${trigger}, handler);`, "/dynamic.ts"),
      ).toThrow("cannot resolve");
    }
    expect(
      triggersIn(
        'const event = "ready"; createFunction({}, [{event}], handler);',
        "/shorthand.ts",
      ).map((row) => row.event),
    ).toEqual(["ready"]);
  });
});
