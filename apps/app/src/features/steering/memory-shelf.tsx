"use client";
// The Library's Memory shelf body (roadmap pages/steering-memory.md): the
// aggregation strip, the precedence note, the Recalled memory table, and the
// memory and memforget dialogs.
//
// The rows are the workspace's active `:AgentMemory` nodes as list_memories
// reads them. The strip is derived from those rows and nothing else, so it
// can never disagree with the table: Memories is the row count and By class
// counts the Class column. What the node does not record prints "not
// recorded" with the issue that tracks it, never a figure: its force, its
// scope, the run and frame it came from, the recall counter, and where the
// assembler places it against a published record. The token cost is the
// assembler's budget unit over the body, computed from the words.
//
// Nothing here is authored. A memory leaves the shelf by being forgotten,
// which retracts it (./actions.ts `forgetMemory`) and touches no run, or it
// is promoted: the record wizard opens with its words in the description, and
// the record becomes binding at merge.
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState, useTransition } from "react";
import type { MemoryItem } from "@/data/contracts/steering";
import { CREATE_DESCRIPTION_MAX, openCreate } from "@/shared/create";
import { Badge } from "@/ui/badge";
import {
  buttonPrimary,
  buttonSecondary,
  panel,
  panelFooter,
  panelHeader,
  panelTitle,
  statNote,
  statStrip,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { cell, numericCell, Table } from "@/ui/table";
import { useActionFailure } from "./action-failure";
import { forgetMemory } from "./actions";
import { STEERING_GAPS } from "./gaps";
import { useDate } from "./section";
import { budgetTokens } from "./tokens";
import { type SteeringAt, steeringLink } from "./view";
import { useNavigate } from "@/ui/navigation";

const CLASSES = ["OBSERVATION", "RULE", "FACT"] as const;

const note =
  "border-l-2 border-gold py-0.5 pl-3 text-[12.5px] text-muted-foreground";
const buttonDanger = `${buttonSecondary} border-error/40 text-error-ink hover:border-error`;

/** The assembler's budget unit over the line a memory would be delivered as. */
export function memoryTokens(memory: MemoryItem): number {
  return budgetTokens(`- ${memory.body}`);
}

/** The strip's figures, each derived from the rows beneath it. */
export function memoryStrip(memories: readonly MemoryItem[]) {
  const byClass = CLASSES.map(
    (cls) =>
      [cls, memories.filter((m) => m.memoryClass === cls).length] as const,
  ).filter(([, count]) => count > 0);
  const people = memories.filter((m) => m.writtenBy === "person").length;
  return {
    memories: memories.length,
    people,
    others: memories.length - people,
    byClass,
  };
}

function NotRecordedCell({ gap }: { gap: number }) {
  const t = useTranslations("steering.bodies.memory");
  return (
    <span
      className="text-muted-foreground"
      data-not-recorded=""
      title={t("gapTitle", { issue: String(gap) })}
    >
      {t("notRecorded")}
    </span>
  );
}

function ClassBadge({ memoryClass }: { memoryClass: string }) {
  return (
    <Badge tone="quiet" dot={false} data-class={memoryClass}>
      <span className="font-mono">{memoryClass}</span>
    </Badge>
  );
}

function Tile({
  term,
  value,
  basis,
  testId,
}: {
  term: string;
  value: ReactNode;
  basis: string;
  testId: string;
}) {
  return (
    <div className={statTile} data-testid={testId}>
      <span className={statTerm}>{term}</span>
      <span className={statValue}>{value}</span>
      <span className={statNote}>{basis}</span>
    </div>
  );
}

function MemoryDialog({
  memory,
  onClose,
  onForget,
}: {
  memory: MemoryItem;
  onClose: () => void;
  onForget: () => void;
}) {
  const t = useTranslations("steering.bodies.memory");
  const locale = useLocale();
  const date = useDate();
  const tokens = memoryTokens(memory);
  return (
    <SheetDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={memory.body}
      subtitle={t("dialog.subtitle")}
      testId="memory-dialog"
      footer={
        <>
          <button type="button" className={buttonDanger} onClick={onForget}>
            {t("dialog.forget")}
          </button>
          <button
            type="button"
            className={buttonPrimary}
            onClick={() => {
              onClose();
              openCreate("record", {
                description: memory.body.slice(0, CREATE_DESCRIPTION_MAX),
              });
            }}
          >
            {t("dialog.promote")}
          </button>
        </>
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
        <dt className="text-muted-foreground">{t("dialog.class")}</dt>
        <dd data-term="class">
          <ClassBadge memoryClass={memory.memoryClass} />{" "}
          <span className="text-muted-foreground">
            {t("dialog.forceNotRecorded")}
          </span>
        </dd>
        <dt className="text-muted-foreground">{t("dialog.scope")}</dt>
        <dd>
          <NotRecordedCell gap={STEERING_GAPS.memory} />
        </dd>
        <dt className="text-muted-foreground">{t("dialog.origin")}</dt>
        <dd className="font-mono text-[11.5px]" data-term="origin">
          {t("provenance", {
            ref: memory.publicRef,
            source: memory.source,
            who: memory.writtenBy,
          })}
        </dd>
        <dt className="text-muted-foreground">{t("dialog.recalled")}</dt>
        <dd>
          <NotRecordedCell gap={STEERING_GAPS.memory} />
        </dd>
        <dt className="text-muted-foreground">{t("dialog.cost")}</dt>
        <dd data-term="cost">
          {t("dialog.costValue", { count: formatCount(tokens, locale) })}
        </dd>
        <dt className="text-muted-foreground">{t("dialog.since")}</dt>
        <dd className="font-mono text-[12px]" data-term="since">
          {date(memory.createdAt)}
        </dd>
      </dl>
      <p className={`${note} mt-3`} data-term="position">
        {t("dialog.position", { issue: String(STEERING_GAPS.assembler) })}
      </p>
    </SheetDialog>
  );
}

function ForgetDialog({
  memory,
  at,
  onClose,
  onForgotten,
}: {
  memory: MemoryItem;
  at: SteeringAt;
  onClose: () => void;
  onForgotten: (ref: string) => void;
}) {
  const t = useTranslations("steering.bodies.memory");
  const failure = useActionFailure();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <SheetDialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      dismissible={!pending}
      title={t("forget.title")}
      closeLabel={t("forget.keep")}
      testId="memory-forget"
      footer={
        <button
          type="button"
          className={buttonDanger}
          disabled={pending}
          onClick={() => {
            setError(null);
            start(async () => {
              const result = await forgetMemory(at.org, at.ws, memory.ref);
              if (result.ok) onForgotten(memory.publicRef);
              else setError(failure(result));
            });
          }}
        >
          {pending ? t("forget.pending") : t("forget.confirm")}
        </button>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        <p className={note}>{t("forget.body")}</p>
        <p className={note}>{t("forget.other")}</p>
        {error === null ? null : (
          <FormAlert testId="memory-forget-error">{error}</FormAlert>
        )}
      </div>
    </SheetDialog>
  );
}

export function MemoryShelfBody({
  at,
  memories,
  total,
}: {
  at: SteeringAt;
  /** The active memories the shelf read, newest first. */
  memories: readonly MemoryItem[];
  /** Every active memory in the workspace. */
  total: number;
}) {
  const t = useTranslations("steering.bodies.memory");
  const locale = useLocale();
  const router = useNavigate();
  const [open, setOpen] = useState<{
    ref: string;
    step: "memory" | "forget";
  } | null>(null);
  const [forgotten, setForgotten] = useState<string | null>(null);
  const strip = memoryStrip(memories);
  const selected =
    open === null ? null : (memories.find((m) => m.ref === open.ref) ?? null);
  const notRecorded = (
    <span className="text-[15px] font-medium text-muted-foreground">
      {t("notRecorded")}
    </span>
  );
  return (
    <div className="flex flex-col gap-3.5" data-testid="shelf-memory">
      <div className={statStrip}>
        <Tile
          testId="tile-memories"
          term={t("tiles.memories")}
          value={formatCount(strip.memories, locale)}
          basis={t("tiles.memoriesNote")}
        />
        <Tile
          testId="tile-sources"
          term={t("tiles.sources")}
          value={notRecorded}
          basis={t("tiles.sourcesNote", {
            people: formatCount(strip.people, locale),
            others: formatCount(strip.others, locale),
          })}
        />
        <Tile
          testId="tile-recalled"
          term={t("tiles.recalled")}
          value={notRecorded}
          basis={t("tiles.recalledNote")}
        />
        <Tile
          testId="tile-by-class"
          term={t("tiles.byClass")}
          value={
            <span className="block pt-1.5 text-[15px] font-bold">
              {strip.byClass.map(([cls, count], index) => (
                <span key={cls} data-class-count={cls}>
                  {index === 0 ? null : " · "}
                  <span className="font-mono">{cls}</span>{" "}
                  {formatCount(count, locale)}
                </span>
              ))}
            </span>
          }
          basis={t("tiles.byClassNote")}
        />
      </div>
      <p className={note} data-testid="memory-lead">
        {t.rich("lead", {
          b: (chunks) => (
            <b className="font-semibold text-foreground">{chunks}</b>
          ),
          code: (chunks) => (
            <code className="font-mono text-[12px]">{chunks}</code>
          ),
        })}
      </p>
      {forgotten === null ? null : (
        <p role="status" className="text-[13px] text-foreground">
          {t("forgotten", { ref: forgotten })}
        </p>
      )}
      <section
        aria-labelledby="steering-memory-title"
        data-testid="memory-panel"
        className={panel}
      >
        <div className={panelHeader}>
          <h3 id="steering-memory-title" className={panelTitle}>
            {t("title")}
          </h3>
          <Badge tone="quiet" dot={false} data-testid="memory-count">
            {formatCount(memories.length, locale)}
          </Badge>
        </div>
        <Table
          label={t("title")}
          columns={[
            { label: t("columns.memory") },
            { label: t("columns.class") },
            { label: t("columns.force") },
            { label: t("columns.scope") },
            { label: t("columns.lastRecalled") },
            { label: t("columns.tokens"), numeric: true },
            { label: t("columns.assembler") },
          ]}
        >
          {memories.map((memory) => (
            <tr
              key={memory.ref}
              data-memory={memory.publicRef}
              className="cursor-pointer"
              onClick={() => {
                setOpen({ ref: memory.ref, step: "memory" });
              }}
            >
              <td className={`${cell} max-w-[46ch]`}>
                {/* The row's keyboard way in: a button answers Enter and Space. */}
                <button
                  type="button"
                  className="block text-left font-medium text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  aria-label={t("open", { ref: memory.publicRef })}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpen({ ref: memory.ref, step: "memory" });
                  }}
                >
                  {memory.body}
                </button>
                <span className="mt-0.5 block break-all font-mono text-[11px] text-dim">
                  {t("provenance", {
                    ref: memory.publicRef,
                    source: memory.source,
                    who: memory.writtenBy,
                  })}
                </span>
              </td>
              <td className={cell}>
                <ClassBadge memoryClass={memory.memoryClass} />
              </td>
              <td className={cell}>
                <NotRecordedCell gap={STEERING_GAPS.memory} />
              </td>
              <td className={cell}>
                <NotRecordedCell gap={STEERING_GAPS.memory} />
              </td>
              <td className={cell}>
                <NotRecordedCell gap={STEERING_GAPS.memory} />
              </td>
              <td className={numericCell}>
                <span title={t("tokensTitle")}>
                  {t("tokens", {
                    count: formatCount(memoryTokens(memory), locale),
                  })}
                </span>
              </td>
              <td className={cell}>
                <NotRecordedCell gap={STEERING_GAPS.assembler} />
              </td>
            </tr>
          ))}
        </Table>
        <div className={panelFooter}>
          <SafeLink
            to={steeringLink(at, { tab: "compiler" })}
            className={buttonSecondary}
          >
            {t("compiler")}
          </SafeLink>
          <span className="flex-1 text-[12px]">{t("compilerNote")}</span>
        </div>
        {memories.length < total ? (
          <p
            data-testid="memory-truncated"
            className="border-t border-border px-4 py-2.5 text-[12px] text-muted-foreground"
          >
            {t("truncated", {
              read: formatCount(memories.length, locale),
              total: formatCount(total, locale),
            })}
          </p>
        ) : null}
      </section>
      {selected !== null && open?.step === "memory" ? (
        <MemoryDialog
          memory={selected}
          onClose={() => {
            setOpen(null);
          }}
          onForget={() => {
            setOpen({ ref: selected.ref, step: "forget" });
          }}
        />
      ) : null}
      {selected !== null && open?.step === "forget" ? (
        <ForgetDialog
          memory={selected}
          at={at}
          onClose={() => {
            setOpen(null);
          }}
          onForgotten={(ref) => {
            setOpen(null);
            setForgotten(ref);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
