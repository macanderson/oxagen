"use client";
// A page's own entry into a creation wizard (roadmap creation-spec §1, the
// entry-point table): Steering · Skills "Add a skill", and the Agent IAM,
// Tools and Steering buttons as their wizards land. It renders nothing for a
// kind the wizard host does not carry yet, so a page can place its button
// before its wizard ships and the button appears the day the kind is offered.
// Gold, because it is the one action the page is for (creation-spec §6).
import { CREATE_KINDS, type CreateKind, openCreate } from "@/shared/create";
import { buttonPrimary } from "./control-styles";

export function CreateButton({
  kind,
  label,
}: {
  kind: CreateKind;
  /** The page's own words for it: "Add a skill", "New agent". */
  label: string;
}) {
  if (!CREATE_KINDS.includes(kind)) return null;
  return (
    <button
      type="button"
      data-create={kind}
      className={buttonPrimary}
      onClick={() => {
        openCreate(kind);
      }}
    >
      {label}
    </button>
  );
}
