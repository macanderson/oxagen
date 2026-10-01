// steering-repo/governance-pr.ts: the title and body of the steering PR
// `set_governance_mode` opens on `steering/governance` (#4766, ADR-232). Its
// own module, so the proposal views can print the body without loading the
// merge queue.

/** The steering PR's title. The diff names the mode, so the title does not. */
export const STEERING_GOVERNANCE_PR_TITLE =
  "Change the steering governance mode";

/**
 * The steering PR's body. A reused PR keeps the body it was opened with, so
 * the body names no mode: the diff is the only current statement of it.
 */
export const STEERING_GOVERNANCE_PR_BODY = [
  "This steering PR changes the `mode` key in `steering/governance.toml`, which decides",
  "who may merge a steering PR through Oxagen in this workspace. Every other setting",
  "in the file stays as it is.",
  "",
  "Read the diff for the mode being set. This description is not updated when the branch",
  "is, so the file is the only current statement of it.",
  "",
  "| Mode | Who merges through Oxagen |",
  "| --- | --- |",
  "| `solo` | the merger, with no other approval |",
  "| `team` | the merger, after a workspace member other than the author approves |",
  "| `regulated` | the merger, after a workspace member other than the author approves |",
  "",
  "Oxagen runs the `Oxagen steering` check before merging this PR through its merge queue.",
  "GitHub repository permissions govern direct pushes and merges in GitHub.",
  "Approve this PR here, then merge it from the steering page in Oxagen.",
  "The mode on the production branch stays in force until this change merges.",
].join("\n");
