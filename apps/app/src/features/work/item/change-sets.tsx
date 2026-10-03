"use client";
// The work item page's change sets in the browser (ADR-292): the item's own,
// and each send's. The shared views live in @/ui/change-set. This module binds
// their reads to this lane's actions, so a send's change set and a file's diff
// are read only when a person opens one.
import type { ChangeSet as ChangeSetView } from "@/data/contracts/changes";
import { ChangeSet, ChangeSetDisclosure } from "@/ui/change-set";
import { readChangeSet, readRevisionDiff } from "../actions";

type At = { org: string; ws: string };

function diffReader({ org, ws }: At) {
  return (revisionId: string, paths: string[]) =>
    readRevisionDiff(org, ws, revisionId, paths);
}

/** The work item's change set, as the page read it, one heading level under the panel's. */
export function ItemChangeSet({
  changeSet,
  at,
}: {
  changeSet: ChangeSetView;
  at: At;
}) {
  return (
    <ChangeSet changeSet={changeSet} loadDiff={diffReader(at)} headingLevel={3} />
  );
}

/** One send's change set, read by its work order the first time a person opens it. */
export function SendChangeSet({
  orderId,
  label,
  at,
}: {
  /** The send's work order, `wo_…`. */
  orderId: string;
  /** The disclosure's words, already translated. */
  label: string;
  at: At;
}) {
  return (
    <ChangeSetDisclosure
      label={label}
      load={() => readChangeSet(at.org, at.ws, "work_order", orderId)}
      loadDiff={diffReader(at)}
      testId="work-send-change-set"
    />
  );
}
