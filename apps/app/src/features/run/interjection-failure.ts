// The sentence a refused answer to a run's repository question shows (#3941).
// `answer_interjection` refuses on its own reasons, then runs
// `link_repository` or `create_workspace`, and a refusal from either reaches
// here with its reason intact. The kit reads the failure
// (`@/ui/action-failure`); only the vocabulary is this page's.
//
// Two invalid answers are told apart by the field they name, not by their
// code: the kernel refuses a slug or a name that fails the contract's own
// schema as `invalid_input`, and says which field in `field`.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";
import { readFailure, unanswered } from "@/ui/action-failure";

type AnswerFailure = Exclude<ActionResult<unknown>, { ok: true }>;

const WORDS = {
  refused: {
    org_role_required: "orgRoleRequired",
    no_principal: "noPrincipal",
    interjection_answered: "answered",
    interjection_expired: "expired",
    interjection_answer_shape: "answerShape",
    interjection_repository_unresolved: "repositoryUnresolved",
    slug_taken: "slugTaken",
    main_repo_claimed: "mainRepoClaimed",
    github_not_connected: "githubNotConnected",
    github_not_authorized: "githubNotAuthorized",
    installation_unreachable: "installationUnreachable",
    repository_not_installed: "repositoryNotInstalled",
  },
  invalid: {
    interjection_choice: "choice",
  },
} as const;

/** The create field an invalid answer names, when it names one. */
const FIELDS = {
  "create.slug": "slug",
  "create.name": "name",
} as const;

function fieldOf(failure: AnswerFailure): "slug" | "name" | null {
  if (failure.reason !== "invalid" || failure.field === undefined) return null;
  return Object.hasOwn(FIELDS, failure.field)
    ? FIELDS[failure.field as keyof typeof FIELDS]
    : null;
}

export function useAnswerFailure(): (failure: AnswerFailure) => string {
  const t = useTranslations("run.interjection.failure");
  return (failure) => {
    const field = fieldOf(failure);
    if (field !== null) return t(field);
    const reading = readFailure(WORDS, failure);
    switch (reading.kind) {
      case "named":
        return t(reading.key);
      case "refused":
        return t("refused", { code: reading.code });
      case "invalid":
        return t("invalid");
      case "pendingApproval":
        return t("pendingApproval", {
          accessRequestId: reading.accessRequestId,
        });
      case "unavailable":
        return t("unavailable", { code: reading.code });
    }
  };
}

/** An answer that threw before the seam answered, as the seam would name it. */
export const UNANSWERED: AnswerFailure = unanswered("action_failed");
