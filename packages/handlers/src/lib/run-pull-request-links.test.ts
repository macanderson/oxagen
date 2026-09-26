import { describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "../logger";
import {
  pullRequestLinkEvents,
  sendPullRequestLinks,
} from "./run-pull-request-links";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const ROOT = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const OTHER = "0192d4a8-7c1e-7a00-8000-0000000000b2";
const URL_A = "https://github.com/acme/api/pull/42";

const frame = (
  attrs: Record<string, string>,
  kind = "tool_call",
  root = ROOT,
) => ({ kind, root_session_uuid: root, attrs });

describe("pullRequestLinkEvents", () => {
  it("asks once per root session and link, from either attr spelling", () => {
    const events = pullRequestLinkEvents(SCOPE, [
      frame({ "pr.url": URL_A }, "oxagen:pr_link"),
      // The same link again, from a pr_open effect frame.
      frame({ "pr.url": URL_A }),
      // A pr_link frame stored before #3944.
      frame(
        { pr_url: "https://gitlab.com/acme/platform/api/-/merge_requests/9" },
        "oxagen:pr_link",
      ),
      // The same link under another root is another row.
      frame({ "pr.url": URL_A }, "tool_call", OTHER),
    ]);
    expect(events.map((e) => [e.data.rootSessionUuid, e.data.url])).toEqual([
      [ROOT, URL_A],
      [ROOT, "https://gitlab.com/acme/platform/api/-/merge_requests/9"],
      [OTHER, URL_A],
    ]);
    expect(events[0]).toMatchObject({
      name: "run/pull-request.linked",
      data: { ...SCOPE },
    });
    // The id holds for the pair, so a re-sent batch asks nothing new.
    expect(events[0]?.id).toMatch(/^run-pr-linked:[0-9a-f-]{36}:[0-9a-f]{32}$/);
    expect(
      pullRequestLinkEvents(SCOPE, [frame({ "pr.url": URL_A })])[0]?.id,
    ).toBe(events[0]?.id);
  });

  it.each([
    ["no link", frame({})],
    [
      "a link on another forge",
      frame({ "pr.url": "https://git.example.com/a/b/pull/1" }),
    ],
    ["an http link", frame({ "pr.url": "http://github.com/acme/api/pull/42" })],
    // Only a pr_link frame's old spelling is a link.
    ["an old spelling on another frame", frame({ pr_url: URL_A })],
  ])("asks nothing for %s (negative)", (_label, f) => {
    expect(pullRequestLinkEvents(SCOPE, [f])).toEqual([]);
  });
});

describe("sendPullRequestLinks", () => {
  it("sends the batch's link events in one call", async () => {
    const send = vi.fn((_events: unknown[]) => Promise.resolve());
    await sendPullRequestLinks(send, SCOPE, [frame({ "pr.url": URL_A })]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toHaveLength(1);
  });

  it("sends nothing for a batch with no link", async () => {
    const send = vi.fn();
    await sendPullRequestLinks(send, SCOPE, [frame({})]);
    expect(send).not.toHaveBeenCalled();
  });

  it("logs and carries on when the send fails (negative)", async () => {
    const send = vi.fn((_events: unknown[]) =>
      Promise.reject(new Error("inngest 503")),
    );
    await expect(
      sendPullRequestLinks(send, SCOPE, [frame({ "pr.url": URL_A })]),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ links: 1 }),
      expect.stringContaining("run/pull-request.linked"),
    );
  });
});
