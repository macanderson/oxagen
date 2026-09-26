// What a model request carried, block by block, and what the assembler put in
// front of the model (ADR-200, #3894). The design of record draws both in the
// frame dialog (pages/run.md, The frame dialog; the mockup's `fdRequest` and
// `fdContext`): the `model.request` panel's Tools offered, Context frames,
// Prompt tokens, Prompt composition and Message stack, and the
// `context.assembled` panel's Budget, Used, Context frames and Assembled by.
// The app's frame view is the Governed actions tab's open frame, and the
// Context tab draws the same composition for the first request.
//
// Everything here is read from `get_run_context`. A block's tokens are its
// byte share of the prompt tokens the provider reported, so the blocks sum
// to that total and nothing is counted in the page. A block the recorder
// could not tell apart is not drawn, and a figure the record does not carry
// says not recorded.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  ContextAssembly,
  ContextBlock,
  ContextBlockKind,
  ContextWindow,
  RunContext,
} from "@/data/contracts/run-context";
import type { Read } from "@/data/read";
import type { SafePath } from "@/shared/safe-path";
import { eyebrowQuiet, linkText, mono } from "@/ui/control-styles";
import { formatCount, formatRatio } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { Fact, Facts, NoValue } from "./parts";

/** Each block's hue, the one the Cost tab's Prompt composition gives its part. */
export const BLOCK_HUE: Record<ContextBlockKind, string> = {
  system: "bg-dim",
  steering: "bg-kind-rule",
  tools: "bg-info",
  context: "bg-proven",
  conversation: "bg-success",
};

/** The frame types that record a model request: the window is drawn on these. */
const REQUEST_TYPES: ReadonlySet<string> = new Set([
  "llm_call",
  "model.engine_call_started",
  "model.request",
]);
/** The frames the assembler's manifest is sealed into. */
const ASSEMBLY_TYPES: ReadonlySet<string> = new Set([
  "steering.manifest",
  "context.assembled",
]);

/** Whether a frame of `type` carries a window to draw. */
export function drawsWindow(type: string | null): boolean {
  return type !== null && REQUEST_TYPES.has(type);
}

/** Whether a frame of `type` carries the assembler's manifest. */
export function drawsAssembly(type: string | null): boolean {
  return type !== null && ASSEMBLY_TYPES.has(type);
}

/**
 * The window recorded at `seq`, or null when that frame recorded none.
 *
 * @internal Exported for its test.
 */
export function windowAt(
  context: RunContext,
  seq: string,
): ContextWindow | null {
  return context.windows.find((entry) => entry.seq === seq) ?? null;
}

/**
 * The manifest summary sealed at `seq`, or null when none was.
 *
 * @internal Exported for its test.
 */
export function assemblyAt(
  context: RunContext,
  seq: string,
): ContextAssembly | null {
  return context.assemblies.find((assembly) => assembly.seq === seq) ?? null;
}

function blockOf(
  recorded: ContextWindow,
  kind: ContextBlockKind,
): ContextBlock | null {
  return recorded.blocks.find((block) => block.kind === kind) ?? null;
}

/**
 * The composition bar and its legend: one band per block that measured any
 * bytes, sized by its tokens, or by its bytes when the provider reported no
 * input. The bands are the blocks the row beneath names.
 */
export function CompositionBar({ recorded }: { recorded: ContextWindow }) {
  const t = useTranslations("run.frames.window");
  const locale = useLocale();
  const drawn = recorded.blocks.filter((block) => block.bytes > 0);
  const size = (block: ContextBlock) => block.tokens ?? block.bytes;
  const whole = drawn.reduce((sum, block) => sum + size(block), 0);
  return (
    <div data-testid="window-composition" className="flex flex-col gap-[7px]">
      {/* `display:flex; height:12px; border-radius:6px; overflow:hidden; border:1px solid var(--border)` */}
      <div
        aria-hidden="true"
        className="flex h-3 overflow-hidden rounded-md border border-border bg-hl"
      >
        {drawn.map((block) => (
          <i
            key={block.kind}
            className={`block h-full ${BLOCK_HUE[block.kind]}`}
            style={{
              width: `${String(whole === 0 ? 0 : (size(block) / whole) * 100)}%`,
            }}
          />
        ))}
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-[11.5px] text-muted-foreground">
        {drawn.map((block) => (
          <li
            key={block.kind}
            data-testid="window-part"
            data-kind={block.kind}
            className="inline-flex items-center gap-[5px]"
          >
            <i
              aria-hidden="true"
              className={`inline-block size-2 rounded-[2px] ${BLOCK_HUE[block.kind]}`}
            />
            {t(`block.${block.kind}`)}{" "}
            <b className="font-semibold tabular-nums text-foreground">
              {block.tokens === null
                ? t("bytes", { count: formatCount(block.bytes, locale) })
                : t("tokens", { count: formatCount(block.tokens, locale) })}
            </b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A block's count and its tokens, or that the recorder did not tell it apart. */
function BlockFact({
  recorded,
  kind,
}: {
  recorded: ContextWindow;
  kind: "tools" | "context";
}) {
  const t = useTranslations("run.frames.window");
  const locale = useLocale();
  const block = blockOf(recorded, kind);
  if (block === null) return <>{t("notApart")}</>;
  const items = t(`items.${kind}`, { count: block.items });
  return (
    <>
      {block.tokens === null
        ? items
        : t("itemsWithTokens", {
            items,
            tokens: formatCount(block.tokens, locale),
          })}
    </>
  );
}

/** Heading of one section of the panel, with the one fact beside it. */
function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className={`${eyebrowQuiet} m-0`}>{title}</p>
        {aside === undefined ? null : (
          <span className="text-[11px] text-dim">{aside}</span>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * The `model.request` panel for the open frame: its provider and model, the
 * tools and context it offered, its prompt tokens and where they were
 * answered, the composition and the message stack.
 */
export function RequestWindow({
  read,
  seq,
  hrefOf,
}: {
  read: Read<RunContext>;
  seq: string;
  /** The link that opens a frame, for the completion the request was answered at. */
  hrefOf: (seq: string) => SafePath;
}) {
  const t = useTranslations("run.frames.window");
  const locale = useLocale();
  if (!read.ok) return <ReadFailure read={read} section={t("title")} />;
  const recorded = windowAt(read.value, seq);
  if (recorded === null)
    return (
      <p
        data-testid="window-none"
        className="m-0 text-[12.5px] text-muted-foreground"
      >
        {t("none")}
      </p>
    );
  return (
    <div data-testid="window-panel" className="flex min-w-0 flex-col gap-3.5">
      <Facts>
        <Fact label={t("provider")}>{recorded.provider ?? <NoValue />}</Fact>
        <Fact label={t("model")} code>
          {recorded.model ?? <NoValue />}
        </Fact>
        <Fact label={t("tools")}>
          <BlockFact recorded={recorded} kind="tools" />
        </Fact>
        <Fact label={t("context")}>
          <BlockFact recorded={recorded} kind="context" />
        </Fact>
        <Fact label={t("promptTokens")}>
          {recorded.promptTokens === null ? (
            <NoValue />
          ) : (
            <span data-testid="window-prompt-tokens">
              {formatCount(recorded.promptTokens, locale)}
            </span>
          )}
          {recorded.responseSeq === null || recorded.responseSeq === seq ? null : (
            <>
              {" "}
              <SafeLink
                to={hrefOf(recorded.responseSeq)}
                className={`${linkText} text-[12.5px]`}
              >
                {t("answeredAt", { seq: recorded.responseSeq })}
              </SafeLink>
            </>
          )}
        </Fact>
      </Facts>
      <Section
        title={t("composition")}
        aside={
          recorded.promptTokens === null
            ? t("compositionBytes")
            : t("compositionNote", {
                count: formatCount(recorded.promptTokens, locale),
              })
        }
      >
        <CompositionBar recorded={recorded} />
      </Section>
      <Section title={t("stack")}>
        <ol
          data-testid="window-stack"
          className="m-0 flex list-none flex-col gap-[7px] p-0"
        >
          {recorded.blocks.map((block) => (
            <li
              key={block.kind}
              data-testid="window-stack-row"
              data-kind={block.kind}
              className="flex min-w-0 items-center gap-2 rounded-lg border border-border border-l-[3px] border-l-rule bg-background px-[11px] py-2 text-[11px]"
            >
              <b className={`${mono} text-foreground`}>
                {t(`block.${block.kind}`)}
              </b>
              <span className="min-w-0 truncate text-dim">
                {t(`items.${block.kind}`, { count: block.items })}
              </span>
              <span className={`${mono} ml-auto flex-none text-dim`}>
                {block.tokens === null
                  ? t("bytes", { count: formatCount(block.bytes, locale) })
                  : t("tokens", { count: formatCount(block.tokens, locale) })}
              </span>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

/**
 * The `context.assembled` panel for the frame the assembler's manifest was
 * sealed into: the budget, what it spent and the headroom left, how many
 * candidates it put in the window and cut, and the digest of the text.
 */
export function AssembledContext({
  read,
  seq,
}: {
  read: Read<RunContext>;
  seq: string;
}) {
  const t = useTranslations("run.frames.assembled");
  const locale = useLocale();
  if (!read.ok) return <ReadFailure read={read} section={t("title")} />;
  const assembly = assemblyAt(read.value, seq);
  if (assembly === null)
    return (
      <p
        data-testid="assembled-none"
        className="m-0 text-[12.5px] text-muted-foreground"
      >
        {t("none")}
      </p>
    );
  const count = (value: number) => formatCount(value, locale);
  const headroom = Math.max(0, assembly.budgetTokens - assembly.spentTokens);
  return (
    <div data-testid="assembled-panel">
      <Facts>
        <Fact label={t("budget")}>
          {t("tokens", { count: count(assembly.budgetTokens) })}
        </Fact>
        <Fact label={t("used")}>
          <span data-testid="assembled-used">
            {assembly.budgetTokens === 0
              ? t("tokens", { count: count(assembly.spentTokens) })
              : t("usedValue", {
                  tokens: count(assembly.spentTokens),
                  share: formatRatio(
                    assembly.spentTokens / assembly.budgetTokens,
                    locale,
                  ),
                  headroom: count(headroom),
                })}
          </span>
        </Fact>
        <Fact label={t("frames")}>
          {t("framesValue", {
            included: assembly.included,
            cut: assembly.cut,
          })}
        </Fact>
        <Fact label={t("by")}>{t("assembler")}</Fact>
        <Fact label={t("digest")} code>
          {assembly.textDigest ?? t("noText")}
        </Fact>
      </Facts>
    </div>
  );
}
