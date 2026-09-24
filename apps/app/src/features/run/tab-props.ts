// What every Run tab receives (pages/run.md, Tabs). The page makes the reads
// the header, the stat row, the side column and the tab counts share, derives
// the figures once (`runMetrics`), and hands the whole bundle to the open tab.
// A tab that needs a read of its own (the chain, a frame body, the price book
// per model) makes it itself from `source` and `ctx`, so opening one tab
// never costs the reads of another.
import type { AgentDetail } from "@/data/contracts/agents";
import type {
  RunCost,
  RunDetail,
  RunOutputs,
  RunTranscript,
  TranscriptKind,
} from "@/data/contracts/run";
import type { RunWork } from "@/data/contracts/run-work";
import type { RunRow } from "@/data/contracts/runs";
import type { PriceBook } from "@/data/contracts/spend";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import type { RunMetrics } from "./metrics";

/** Where the run lives: every link a tab draws is built from these. */
export type Place = { org: string; ws: string; runId: string };

/**
 * The chips a link opens the Transcript tab with: the contract's filter words,
 * where an empty list opens every chip, or `none`, which opens every chip off.
 */
export type KindFilter = readonly TranscriptKind[] | "none";

/** The URL's view of the run: the query values a tab reads. */
type RunView = {
  /** The transcript chips a link opens with: empty opens every chip, `none` opens none. */
  kinds: KindFilter;
  /** `?frames=`, the opaque cursor a later frames page was read from. */
  frames: string | null;
  /** `?body=`, the seq of the open frame; null when none is open. */
  body: string | null;
};

export type RunTabProps = {
  ctx: WsCtx;
  source: DataSource;
  run: RunRow;
  /** `get_run`: the row and the first page of frames. */
  detail: RunDetail;
  place: Place;
  view: RunView;
  metrics: RunMetrics;
  /** The whole-run transcript at `everything`, read to its end. */
  everything: Read<RunTranscript>;
  cost: Read<RunCost>;
  outputs: Read<RunOutputs>;
  /** `get_run_work`, started by the page and awaited where it is drawn. */
  work: Promise<Read<RunWork>>;
  /** `get_agent` for the run's agent; null when the run names none. */
  agent: Read<AgentDetail> | null;
  book: PriceBook | null;
  /**
   * Pins the instant a tab counts a clock from. Only a test passes it; the
   * page leaves it out.
   */
  now?: number;
};
