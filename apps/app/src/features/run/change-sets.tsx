"use client";
// The Run page's change sets in the browser (ADR-292): the run's own, in the
// Changes panel, and each issue's, under the Issues tab. The shared views
// live in @/ui/change-set. This module binds their reads to this lane's
// actions, so a file's diff and an issue's change set are read only when a
// person opens one.
import type { ChangeSet as ChangeSetView } from "@/data/contracts/changes";
import {
  type Answer,
  ChangeSet,
  ChangeSetDisclosure,
  type LoadDiff,
} from "@/ui/change-set";
import { readChangeSet, readRevisionDiff } from "./actions";

type At = { org: string; ws: string };

/**
 * The ui's diff loader, bound to this lane's action. The action answers an
 * `ActionResult`, which the ui reads as an `Answer`.
 */
function diffReader({ org, ws }: At): LoadDiff {
  return (revisionId, paths) => readRevisionDiff(org, ws, revisionId, paths);
}

/** The run's change set, as the page read it. */
export function RunChangeSet({
  changeSet,
  at,
}: {
  changeSet: ChangeSetView;
  at: At;
}) {
  return <ChangeSet changeSet={changeSet} loadDiff={diffReader(at)} />;
}

/** One issue's change set, read by its URL the first time a person opens it. */
export function IssueChangeSet({
  url,
  label,
  at,
}: {
  /** The issue's page, which `get_change_set` reads it by. */
  url: string;
  /** The disclosure's words, already translated. */
  label: string;
  at: At;
}) {
  return (
    <ChangeSetDisclosure
      label={label}
      load={(): Promise<Answer<ChangeSetView>> =>
        readChangeSet(at.org, at.ws, "issue", url)
      }
      loadDiff={diffReader(at)}
      testId="run-issue-change-set"
    />
  );
}
