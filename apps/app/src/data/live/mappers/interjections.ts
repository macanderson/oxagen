// list_interjections output to the questions Fleet's waiting tile, the shell's
// approvals drawer and the Run page draw (#3839, #3941, ARCHITECTURE.md §3.4).
// Typed from the contract's output. The answer fields travel too: Fleet and
// the drawer read open questions, where they are null, and the Run page reads
// one run's questions answered or not.
//
// The `control.interject` body arrives as the host sealed it, in snake_case,
// and leaves camelCased. An empty string the contract did not refuse reads as
// not recorded, so it becomes null rather than a blank the page would print.
import type { agentInterjectionList } from "@oxagen/oxagen/contracts/agent.interjection.list";
import type { z } from "zod";
import type { InterjectionItem } from "@/data/contracts/interjections";
import type { ContractOutput } from "@/server/kernel";

type Item = ContractOutput<typeof agentInterjectionList>["items"][number];
type View = z.input<typeof InterjectionItem>;

/** A recorded string, or null when the writer left it empty. */
function recorded(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}

function bodyOf(body: Item["body"]): View["body"] {
  if (body === null) return null;
  const [link, create] = body.paths;
  return {
    interjectionKey: body.interjection_key,
    reason: body.reason,
    question: body.question,
    remoteDigest: body.remote_digest,
    ...(body.remote_digest_folded === undefined
      ? {}
      : { remoteDigestFolded: body.remote_digest_folded }),
    timeoutMs: body.timeout_ms,
    expiresAt: body.expires_at,
    onTimeout: body.on_timeout,
    paths: [
      {
        path: link.path,
        workspaceSlug: link.workspace_slug,
        configVersion: link.config_version,
        skillsPinned: link.skills_pinned,
        linkedRepositories: link.linked_repositories,
      },
      {
        path: create.path,
        proposedName: create.proposed_name,
        proposedSlug: create.proposed_slug,
        skillsEnabled: create.skills_enabled,
      },
    ],
  };
}

export function toInterjectionItems(
  out: ContractOutput<typeof agentInterjectionList>,
): View[] {
  return out.items.map((item) => ({
    id: item.id,
    runId: item.runId,
    agentKey: recorded(item.agentKey),
    question: item.question,
    raisedAt: item.raisedAt,
    expiresAt: item.expiresAt,
    answeredAt: item.answeredAt,
    answer: recorded(item.answer),
    answeredBy: recorded(item.answeredBy),
    kind: item.kind,
    raisedSeq: item.raisedSeq,
    body: bodyOf(item.body),
    repository: recorded(item.repository),
    path: item.path,
    receiptId: item.receiptId,
  }));
}
