"use client";
// Create the first workspace, when the organization has none: its name, and
// where its steering repo goes and what it is called (#5196). The address
// follows the name on the server, and `create_workspace` starts the steering
// repo's provisioning in the same write. Once it answers, the page re-reads
// and shows that provisioning.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import {
  defaultRepoName,
  repoNameAccepted,
  SteeringRepoDestinationFields,
  steeringRepoDraftOf,
} from "@/features/steering-repo/client";
import { Field } from "@/ui/field";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import {
  createFirstWorkspace,
  readFirstWorkspaceDestinations,
} from "../actions";

type Refused = Extract<
  Awaited<ReturnType<typeof createFirstWorkspace>>,
  { ok: false }
>;

type NameError = "nameRequired" | "nameTooLong" | "nameInvalid" | "slugTaken";

type Refusal =
  | { at: "name"; key: NameError }
  | { at: "repoName" }
  | { at: "form"; key: "denied" }
  | { at: "form"; key: "failed"; code: string };

/** A refused name: the two the action checks, and any other the kernel refused. */
function invalidName(code: string): NameError {
  switch (code) {
    case "name_required":
      return "nameRequired";
    case "name_too_long":
      return "nameTooLong";
    default:
      return "nameInvalid";
  }
}

function refusalOf(result: Refused): Refusal {
  if (result.reason === "invalid" && result.field?.startsWith("steeringRepo"))
    return { at: "repoName" };
  if (result.reason === "invalid")
    return { at: "name", key: invalidName(result.code) };
  if (result.reason === "conflict" && result.code === "slug_taken")
    return { at: "name", key: "slugTaken" };
  if (result.reason === "denied") return { at: "form", key: "denied" };
  return {
    at: "form",
    key: "failed",
    code: result.reason === "pending_approval" ? result.reason : result.code,
  };
}

export function FirstWorkspaceForm({ org }: { org: string }) {
  const t = useTranslations("onboarding.welcome.workspace");
  const tRepo = useTranslations("repositories.steeringRepo.destination");
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    // The repository name field marks itself invalid while it holds a name the
    // contract would refuse, and says why under the field.
    if (!repoNameAccepted(event.currentTarget)) return;
    const steeringRepo = steeringRepoDraftOf(new FormData(event.currentTarget));
    setPending(true);
    setRefusal(null);
    try {
      const result = await createFirstWorkspace(org, name, steeringRepo);
      if (result.ok) {
        navigate.refresh();
        return;
      }
      setRefusal(refusalOf(result));
    } catch {
      setRefusal({ at: "form", key: "failed", code: "action_failed" });
    } finally {
      setPending(false);
    }
  }

  const nameError =
    refusal?.at === "name" ? t(`errors.${refusal.key}`) : undefined;

  return (
    <form
      noValidate
      aria-label={t("title")}
      data-testid="first-workspace-form"
      onSubmit={(e) => void onSubmit(e)}
      className="flex min-w-0 flex-col gap-4"
    >
      {refusal?.at === "form" ? (
        <FormAlert testId="first-workspace-refused">
          {refusal.key === "failed"
            ? t("errors.failed", { code: refusal.code })
            : t("errors.denied")}
        </FormAlert>
      ) : null}
      <Field
        id="ob-workspace-name"
        name="name"
        type="text"
        autoComplete="off"
        maxLength={120}
        required
        label={t("nameLabel")}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
        }}
        error={nameError}
        className="max-md:text-lg"
      />
      <SteeringRepoDestinationFields
        org={org}
        load={readFirstWorkspaceDestinations}
        defaultName={defaultRepoName(name)}
        idPrefix="ob-workspace"
        nameError={
          refusal?.at === "repoName" ? tRepo("repoNameInvalid") : undefined
        }
      />
      <div>
        <SubmitButton
          pending={pending}
          label={t("create")}
          pendingLabel={t("pending")}
          fullWidth={false}
          testId="first-workspace-create"
        />
      </div>
    </form>
  );
}
