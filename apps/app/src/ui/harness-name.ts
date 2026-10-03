// A harness by its product name ("Claude Code" for `claude-code`), from the
// `agents.harness` catalogue. A recorded identifier this build has no name
// for reads as it was recorded, so a new harness still says what it is.
import { useTranslations } from "next-intl";

const NAMED = [
  "stella",
  "claude-code",
  "codex",
  "cursor",
  "claude-agent-sdk",
  "custom",
] as const;

/** The product name for each recorded harness identifier. */
export function useHarnessName(): (harness: string) => string {
  const t = useTranslations("agents.harness");
  return (harness) => {
    const key = NAMED.find((name) => name === harness);
    return key === undefined ? harness : t(key);
  };
}
