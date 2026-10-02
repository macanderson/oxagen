// triage-fixtures.ts: the work item, priorities record, open work, and file
// tree the triage tests share. The priorities record is the example in
// agent-work-spec.html. recorded-response.json is one model output, recorded,
// for the item below.
import { readFileSync } from "node:fs";
import type { TriageDecision } from "../../types";
import type {
  TriageFileTree,
  TriageInput,
  TriageModelClient,
  TriageModelRequest,
  TriageOpenItem,
  TriagePriorities,
  TriageWorkItem,
} from "../triage-item";

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

/** The spec's priorities record, aintel.work.priorities. */
export const PRIORITIES: TriagePriorities = {
  lineage: "aintel.work.priorities",
  hash: "sha256:4b8e1f0a6c3d92e57b0a1c4f8e2d6b3a9c07e5f1d2b4a86c3e9f0d7b1a5c2e84",
  body: read("priorities.md"),
};

/** A paying customer's bug report, as the Zendesk collector brings it in. */
export const ITEM: TriageWorkItem = {
  id: "wi_01K5ZQ4M8T2DXW",
  collector: "support-zendesk",
  title: "Invoice export fails for accounts with a credit note",
  body: "Our finance team cannot export the March invoices. The export button returns an error whenever the account has a credit note.",
  labels: ["Bug"],
  requester: "Dana Ruiz (Acme Corp)",
  url: "https://aintel.zendesk.com/agent/tickets/4812",
};

/** The one open item the recorded response names as related. */
export const OPEN_WORK: TriageOpenItem[] = [
  {
    id: "wi_01K5YV0B3N7PRA",
    title: "Credit notes show the wrong total in the invoice list",
    labels: ["Bug"],
    priority: "P2",
    claims: ["src/invoices/**"],
  },
];

export const FILE_TREES: TriageFileTree[] = [
  {
    repo: "aintel/billing-service",
    paths: ["src/export/csv.ts", "src/export/csv.test.ts", "src/invoices/list.ts"],
  },
];

/** The recorded model output, parsed fresh on each call so a test can change its copy. */
export function recordedOutput(): Record<string, unknown> {
  return JSON.parse(read("recorded-response.json")) as Record<string, unknown>;
}

/** The recorded output as a decision. */
export function recordedDecision(): TriageDecision {
  return recordedOutput() as unknown as TriageDecision;
}

/** A model client that returns the given outputs in order and keeps every request. */
export function recordingClient(outputs: readonly unknown[]): {
  client: TriageModelClient;
  requests: TriageModelRequest[];
} {
  const requests: TriageModelRequest[] = [];
  const client: TriageModelClient = {
    complete(request) {
      requests.push(request);
      return Promise.resolve({ output: outputs[requests.length - 1], model: "triage-second", costUsd: 0.0021 });
    },
  };
  return { client, requests };
}

/** The triage input for ITEM, with a recording client over the given outputs. */
export function triageInputFor(
  outputs: readonly unknown[],
  item: TriageWorkItem = ITEM,
): { input: TriageInput; requests: TriageModelRequest[] } {
  const { client, requests } = recordingClient(outputs);
  return {
    input: { item, priorities: PRIORITIES, openWork: OPEN_WORK, fileTrees: FILE_TREES, model: client },
    requests,
  };
}
