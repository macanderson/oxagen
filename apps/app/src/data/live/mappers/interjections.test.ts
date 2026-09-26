// toInterjectionItems over sample list_interjections outputs (#3839, #3941):
// the question, its run and its window carried through, the answer state
// carried with it, the host's `control.interject` body camelCased, and an
// empty string the contract let through read as not recorded.
import type { agentInterjectionList } from "@oxagen/oxagen/contracts/agent.interjection.list";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InterjectionItem } from "@/data/contracts/interjections";
import type { ContractOutput } from "@/server/kernel";
import { toInterjectionItems } from "./interjections";

type Item = ContractOutput<typeof agentInterjectionList>["items"][number];

const open: Item = {
  id: "inj_q8t1",
  runId: "tse_7k2m9q",
  agentKey: "acme.core.release-bot",
  question: "Which branch should the release cut from?",
  raisedAt: "2026-09-25T09:00:00.000Z",
  expiresAt: "2026-09-25T09:30:00.000Z",
  answeredAt: null,
  answer: null,
  answeredBy: null,
  kind: "question",
  raisedSeq: null,
  body: null,
  repository: null,
  path: null,
  receiptId: null,
};

const DIGEST = `sha256:${"a".repeat(64)}`;
const FOLDED = `sha256:${"b".repeat(64)}`;

/** A repository question the host raised, answered by a link. */
const linked: Item = {
  ...open,
  id: "inj_r3p0",
  question: "This repository is not linked to a workspace.",
  kind: "repo_unknown",
  raisedSeq: "3",
  body: {
    interjection_key: "01K6QW3D5N7TYBA2ZXC8VJ4M1P",
    reason: "repo_unknown",
    question: "This repository is not linked to a workspace.",
    remote_digest: DIGEST,
    remote_digest_folded: FOLDED,
    timeout_ms: 1_800_000,
    expires_at: "2026-09-25T09:30:00.000Z",
    on_timeout: "deny",
    paths: [
      {
        path: "link",
        workspace_slug: "core-platform",
        config_version: "skl_v7",
        skills_pinned: 7,
        linked_repositories: 2,
      },
      {
        path: "create",
        proposed_name: "edge-proxy",
        proposed_slug: "edge-proxy",
        skills_enabled: false,
      },
    ],
  },
  repository: "acme/edge-proxy",
  answeredAt: "2026-09-25T09:04:00.000Z",
  answer: "Link it to core-platform.",
  answeredBy: "usr_marcusbell",
  path: "link",
  receiptId: "rcp_01k6qw44",
};

describe("toInterjectionItems", () => {
  it("carries the question, its run, its agent, its window and its open answer state", () => {
    expect(toInterjectionItems({ items: [open], nextCursor: null })).toEqual([
      {
        id: "inj_q8t1",
        runId: "tse_7k2m9q",
        agentKey: "acme.core.release-bot",
        question: "Which branch should the release cut from?",
        raisedAt: "2026-09-25T09:00:00.000Z",
        expiresAt: "2026-09-25T09:30:00.000Z",
        answeredAt: null,
        answer: null,
        answeredBy: null,
        kind: "question",
        raisedSeq: null,
        body: null,
        repository: null,
        path: null,
        receiptId: null,
      },
    ]);
  });

  it("carries a repository question's frame, body, repository, answer and receipt, camelCased", () => {
    const [item] = toInterjectionItems({ items: [linked], nextCursor: null });
    expect(item).toMatchObject({
      kind: "repo_unknown",
      raisedSeq: "3",
      repository: "acme/edge-proxy",
      answeredAt: "2026-09-25T09:04:00.000Z",
      answer: "Link it to core-platform.",
      answeredBy: "usr_marcusbell",
      path: "link",
      receiptId: "rcp_01k6qw44",
    });
    expect(item?.body).toEqual({
      interjectionKey: "01K6QW3D5N7TYBA2ZXC8VJ4M1P",
      reason: "repo_unknown",
      question: "This repository is not linked to a workspace.",
      remoteDigest: DIGEST,
      remoteDigestFolded: FOLDED,
      timeoutMs: 1_800_000,
      expiresAt: "2026-09-25T09:30:00.000Z",
      onTimeout: "deny",
      paths: [
        {
          path: "link",
          workspaceSlug: "core-platform",
          configVersion: "skl_v7",
          skillsPinned: 7,
          linkedRepositories: 2,
        },
        {
          path: "create",
          proposedName: "edge-proxy",
          proposedSlug: "edge-proxy",
          skillsEnabled: false,
        },
      ],
    });
    expect(z.array(InterjectionItem).parse([item])).toEqual([item]);
  });

  it("leaves the folded digest out when the host sealed none, and keeps uncounted paths null", () => {
    const body = linked.body;
    if (body === null) throw new Error("the fixture carries a body");
    const { remote_digest_folded: _folded, ...unfolded } = body;
    const [item] = toInterjectionItems({
      items: [
        {
          ...linked,
          body: {
            ...unfolded,
            paths: [
              {
                ...body.paths[0],
                config_version: null,
                skills_pinned: null,
                linked_repositories: null,
              },
              { ...body.paths[1], proposed_name: null, proposed_slug: null },
            ],
          },
        },
      ],
      nextCursor: null,
    });
    expect(item?.body).not.toHaveProperty("remoteDigestFolded");
    expect(item?.body?.paths[0]).toMatchObject({
      configVersion: null,
      skillsPinned: null,
      linkedRepositories: null,
    });
    expect(item?.body?.paths[1]).toMatchObject({
      proposedName: null,
      proposedSlug: null,
    });
    expect(z.array(InterjectionItem).parse([item])).toEqual([item]);
  });

  it("reads an empty agent, answer, person or repository as not recorded (negative)", () => {
    const [item] = toInterjectionItems({
      items: [
        {
          ...linked,
          agentKey: "",
          answer: "",
          answeredBy: "",
          repository: "",
        },
      ],
      nextCursor: null,
    });
    expect(item).toMatchObject({
      agentKey: null,
      answer: null,
      answeredBy: null,
      repository: null,
    });
    expect(z.array(InterjectionItem).parse([item])).toEqual([item]);
  });

  it("keeps a null agent null and parses through the view", () => {
    const items = toInterjectionItems({
      items: [{ ...open, agentKey: null }],
      nextCursor: null,
    });
    expect(items[0]?.agentKey).toBeNull();
    expect(z.array(InterjectionItem).parse(items)).toEqual(items);
  });

  it("maps an empty page to an empty list", () => {
    expect(toInterjectionItems({ items: [], nextCursor: null })).toEqual([]);
  });
});
