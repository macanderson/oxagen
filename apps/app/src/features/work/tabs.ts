// The tabs of the Work page and of Work setup, read from `?tab=`. An unknown
// or missing value opens the first tab, so an old or mistyped link still
// lands on a page.
import {
  WORK_PAGE_TABS,
  WORK_SETUP_TABS,
  type WorkPageTab,
  type WorkSetupTab,
} from "@/shared/safe-path";

export type { WorkPageTab, WorkSetupTab };

/** The Work page's tab for a `?tab=` value: Inbox when it names none. */
export function parseWorkTab(value: string | undefined): WorkPageTab {
  return WORK_PAGE_TABS.find((tab) => tab === value) ?? "inbox";
}

/** Work setup's tab for a `?tab=` value: Collectors when it names none. */
export function parseSetupTab(value: string | undefined): WorkSetupTab {
  return WORK_SETUP_TABS.find((tab) => tab === value) ?? "collectors";
}
