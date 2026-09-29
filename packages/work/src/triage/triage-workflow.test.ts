import { describe, expect, it } from "vitest";
import { FIX_TEST_VERIFY_REVIEW, recordedDecision } from "./fixtures/triage-fixtures";
import {
  NO_WORKFLOW_QUESTION,
  type TriageWorkflowFile,
  applyTriageWorkflowMatch,
  matchTriageWorkflow,
} from "./triage-workflow";

function file(slug: string, match?: { labels?: string[]; collectors?: string[] }): TriageWorkflowFile {
  return { slug, workflow: match === undefined ? { stage: [] } : { match, stage: [] } };
}

const DOCS = file("document-review", { labels: ["Documentation"] });
const GITHUB = file("github-intake", { collectors: ["github-core"] });
const NO_MATCH = file("any-item");
const EMPTY_MATCH = file("empty-match", {});
const FILES = [NO_MATCH, EMPTY_MATCH, GITHUB, DOCS, FIX_TEST_VERIFY_REVIEW];

describe("matchTriageWorkflow", () => {
  it("matches the spec's workflow on a Bug from Zendesk", () => {
    expect(matchTriageWorkflow(FILES, { labels: ["Bug"], collector: "support-zendesk" })).toBe(FIX_TEST_VERIFY_REVIEW);
  });

  it("needs every key a [match] sets to fit", () => {
    expect(matchTriageWorkflow([FIX_TEST_VERIFY_REVIEW], { labels: ["Bug"], collector: "inbox" })).toBeNull();
    expect(matchTriageWorkflow([FIX_TEST_VERIFY_REVIEW], { labels: ["Feature"], collector: "github-core" })).toBeNull();
  });

  it("matches on labels alone or collectors alone", () => {
    expect(matchTriageWorkflow(FILES, { labels: ["Documentation"], collector: "inbox" })).toBe(DOCS);
    expect(matchTriageWorkflow(FILES, { labels: ["Feature"], collector: "github-core" })).toBe(GITHUB);
  });

  it("fits nothing with a missing or empty [match]", () => {
    expect(matchTriageWorkflow([NO_MATCH, EMPTY_MATCH], { labels: ["Bug"], collector: "support-zendesk" })).toBeNull();
  });

  it("takes the first match in slug order, whatever order the files come in", () => {
    const late = file("z-bugs", { labels: ["Bug"] });
    const early = file("a-bugs", { labels: ["Bug"] });
    const twin = file("a-bugs", { labels: ["Bug"] });
    expect(matchTriageWorkflow([late, early, twin], { labels: ["Bug"], collector: "inbox" })).toBe(early);
  });
});

describe("applyTriageWorkflowMatch", () => {
  const zendesk = { labels: ["Bug"], collector: "support-zendesk" };

  it("leaves a decision that is not triaged as it is", () => {
    const decision = { ...recordedDecision(), state: "needs_info" as const, workflow: null };
    expect(applyTriageWorkflowMatch(decision, zendesk, [])).toBe(decision);
  });

  it("sets the workflow whose [match] fits, over the model's slug", () => {
    const decision = { ...recordedDecision(), workflow: "document-review" };
    expect(applyTriageWorkflowMatch(decision, zendesk, FILES).workflow).toBe("fix-test-verify-review");
  });

  it("matches on the labels the decision adds", () => {
    const decision = recordedDecision();
    const result = applyTriageWorkflowMatch(decision, { labels: [], collector: "support-zendesk" }, FILES);
    expect(result.workflow).toBe("fix-test-verify-review");
  });

  it("keeps the model's slug when no [match] fits and a file has that slug", () => {
    const decision = { ...recordedDecision(), workflow: "any-item" };
    expect(applyTriageWorkflowMatch(decision, { labels: ["Feature"], collector: "inbox" }, FILES)).toBe(decision);
  });

  it("asks the workspace which workflow to run when none fits", () => {
    const decision = recordedDecision();
    const result = applyTriageWorkflowMatch(decision, { labels: ["Feature"], collector: "inbox" }, [DOCS]);
    expect(result).toEqual({
      ...decision,
      state: "needs_info",
      workflow: null,
      questions: [NO_WORKFLOW_QUESTION],
    });
  });
});
