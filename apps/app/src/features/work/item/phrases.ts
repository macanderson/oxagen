// The sentences the head and the dialogs share: when something happened, and
// why an action is held back. Hooks, with no directive, so the server
// components and the client islands word a held action the same way.
import { useTranslations } from "next-intl";
import { useFormatter } from "@/ui/formatter";
import type { ActionBlock } from "./view";

/** An instant as the page prints it: the month, the day, and the time, in the viewer's zone. */
export function useWhen(): (at: string) => string {
  const format = useFormatter();
  return (at) =>
    format.dateTime(new Date(at), {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
}

/** The reason an action is held back, as the disabled button's description and the blocked dialog's line. */
export function useBlockText(): (block: ActionBlock) => string {
  const t = useTranslations("workItem.blocked");
  const gate = useTranslations("workItem.gate");
  return (block) => {
    switch (block.kind) {
      case "control":
        return t("control");
      case "approve":
        return t("approve");
      case "targets":
        return t("targets");
      case "noApprovedBrief":
        return t("noApprovedBrief");
      case "noSendKey":
        return t("noSendKey");
      case "needsRepository":
        return t("needsRepository");
      case "gate":
        switch (block.block) {
          case null:
            return gate("closed");
          case "check_failed":
            return block.detail === null
              ? gate("check_failed")
              : gate("check_failedNamed", { check: block.detail });
          case "check_missing":
            return block.detail === null
              ? gate("check_missing")
              : gate("check_missingNamed", { check: block.detail });
          default:
            return gate(block.block);
        }
    }
  };
}
