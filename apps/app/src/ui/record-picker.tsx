"use client";
// Record pickers: a person types part of a name, picks the record, and the
// form carries its id. Nobody copies a uuid out of another page.
//
// `RecordPicker` picks one record and `RecordMultiPicker` picks a set, shown
// as chips. Both follow the ARIA combobox pattern the ⌘K menu uses: focus
// stays in the input, the arrow keys move a highlight through the listbox, and
// Enter picks. The list renders in the page flow under the input, not in a
// floating layer, so a dialog's scroll area can never clip it.
//
// Each picker writes its value into a hidden input under `name`, in the same
// shape the plain text field it replaces sent: one id, or ids joined by
// `joiner`. The form's submit handler and its Server Action do not change.
//
// A field whose value is a pattern rather than a record (`github__*`,
// `claude-opus-*`) sets `freeform`: the registry's records are offered, and
// text the person types is kept as it is.
//
// Options come either as a list the page already holds or from `load`, a
// read-only Server Action the picker calls the first time it opens. The
// filter runs on the client, over the loaded list.
import { useTranslations } from "next-intl";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { inputBase, mono } from "./control-styles";

export type PickerOption = {
  /** What the form sends: an id, a slug, or a pattern. */
  value: string;
  /** What a person reads: the record's name. */
  label: string;
  /** A second line, such as the slug or id, drawn in mono. */
  detail?: string | undefined;
};

/** One loaded list. `partial` says the list stopped at a bound before the end. */
type OptionPage = {
  options: readonly PickerOption[];
  partial: boolean;
};

/** What `load` answers. An `ActionResult<OptionPage>` fits it. */
export type OptionLoad = { ok: true; value: OptionPage } | { ok: false };

type Source =
  | { status: "idle" | "loading" | "failed" }
  | { status: "ready"; page: OptionPage };

/** How many matches the list draws. Typing narrows the rest. */
const SHOWN = 50;

/** The options of a list that has not loaded, one array so memos keep. */
const NONE: readonly PickerOption[] = [];

/** The multi picker's box: the input recipe, lit by the focus inside it. */
const chipBox =
  "flex w-full min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-input-border bg-input-bg px-2 py-1.5 text-[13px] text-input-fg " +
  "hover:border-input-border-hover focus-within:border-input-border-focus focus-within:outline-2 focus-within:outline-offset-0 focus-within:outline-input-ring " +
  "aria-disabled:bg-input-disabled-bg aria-disabled:text-input-disabled-fg";

/**
 * Characters that end a typed entry in a freeform multi picker. A space does
 * not: a member's name has one, and the lists these pickers replace were
 * split on commas or lines.
 */
const SEPARATOR = /[,\n]+/;

/**
 * The options that match `query`, best first: a label or value that starts
 * with the query, then one with a word that starts with it, then any that
 * contain it. Case is ignored, and the detail line is searched too, so a
 * person can find a record by its slug or id.
 */
function rank(options: readonly PickerOption[], query: string): PickerOption[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...options];
  const scored: { option: PickerOption; score: number; at: number }[] = [];
  options.forEach((option, at) => {
    const label = option.label.toLowerCase();
    const value = option.value.toLowerCase();
    const detail = (option.detail ?? "").toLowerCase();
    let score = -1;
    if (label.startsWith(q) || value.startsWith(q)) score = 0;
    else if (
      label.split(/[\s_\-./:@]+/).some((word) => word.startsWith(q)) ||
      value.split(/[\s_\-./:@]+/).some((word) => word.startsWith(q))
    )
      score = 1;
    else if (label.includes(q) || value.includes(q) || detail.includes(q))
      score = 2;
    if (score >= 0) scored.push({ option, score, at });
  });
  scored.sort((a, b) => a.score - b.score || a.at - b.at);
  return scored.map((s) => s.option);
}

/** The picker's options: the list it was given, or the one `load` fetches on first open. */
function useSource(
  options: readonly PickerOption[] | undefined,
  load: (() => Promise<OptionLoad>) | undefined,
): [Source, () => void] {
  const [loaded, setLoaded] = useState<Source>({ status: "idle" });
  const startedRef = useRef(false);
  const ensure = useCallback(() => {
    if (startedRef.current || load === undefined) return;
    startedRef.current = true;
    setLoaded({ status: "loading" });
    load().then(
      (result) => {
        setLoaded(
          result.ok
            ? { status: "ready", page: result.value }
            : { status: "failed" },
        );
      },
      () => {
        setLoaded({ status: "failed" });
      },
    );
  }, [load]);
  const source = useMemo<Source>(
    () =>
      options !== undefined
        ? { status: "ready", page: { options, partial: false } }
        : loaded,
    [options, loaded],
  );
  return [source, ensure];
}

type BaseProps = {
  /** The visible input's id, so a label's `htmlFor` reaches it. */
  id: string;
  /** The hidden input's name, as the form reads it. */
  name?: string | undefined;
  options?: readonly PickerOption[] | undefined;
  load?: (() => Promise<OptionLoad>) | undefined;
  /** Keep typed text that matches no option as a value of its own. */
  freeform?: boolean | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: boolean | undefined;
  "data-testid"?: string | undefined;
};

type ListProps = {
  listId: string;
  source: Source;
  matches: PickerOption[];
  highlight: number;
  query: string;
  isChosen: (value: string) => boolean;
  /**
   * Offered after the matches when freeform text matches no option exactly,
   * so Enter picks the best match and the typed text is one arrow away.
   */
  typed: string | null;
  onPick: (value: string) => void;
  onHover: (index: number) => void;
  optionId: (index: number) => string;
  freeform: boolean;
};

function OptionList({
  listId,
  source,
  matches,
  highlight,
  query,
  isChosen,
  typed,
  onPick,
  onHover,
  optionId,
  freeform,
}: ListProps) {
  const t = useTranslations("ui.picker");
  const shown = matches.slice(0, SHOWN);
  const rows: { value: string; label: ReactNode; detail?: string }[] = [
    ...shown.map((o) => ({
      value: o.value,
      label: o.label,
      ...(o.detail === undefined ? {} : { detail: o.detail }),
    })),
    ...(typed === null
      ? []
      : [{ value: typed, label: t("useTyped", { value: typed }) }]),
  ];
  let status: string | null = null;
  if (source.status === "loading") status = t("loading");
  else if (source.status === "failed")
    status = t(freeform ? "failedFreeform" : "failed");
  else if (rows.length === 0)
    status = query.trim() === "" ? t("none") : t("noMatch", { query });
  const more = matches.length - shown.length;
  const partial = source.status === "ready" && source.page.partial;
  return (
    <div className="mt-1 overflow-hidden rounded-md border border-border bg-card text-card-foreground shadow-sm">
      {rows.length > 0 ? (
        <div
          id={listId}
          role="listbox"
          className="max-h-56 overflow-y-auto p-1"
        >
          {rows.map((row, i) => {
            const active = i === highlight;
            const chosen = isChosen(row.value);
            return (
              <div
                key={`${row.value}-${String(i)}`}
                id={optionId(i)}
                role="option"
                aria-selected={chosen}
                data-value={row.value}
                data-active={active ? "" : undefined}
                onMouseDown={(e) => {
                  e.preventDefault();
                }}
                onMouseMove={() => {
                  if (!active) onHover(i);
                }}
                onClick={() => {
                  onPick(row.value);
                }}
                className={`flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-[13px] ${
                  active ? "bg-accent text-accent-foreground" : ""
                }`}
              >
                <span
                  aria-hidden="true"
                  className="w-3 shrink-0 pt-px text-center"
                >
                  {chosen ? "✓" : ""}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{row.label}</span>
                  {row.detail !== undefined && row.detail !== row.label ? (
                    <span
                      className={`${mono} truncate text-xs text-muted-foreground`}
                    >
                      {row.detail}
                    </span>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      {status !== null || more > 0 || partial ? (
        <p
          role="status"
          className="border-t border-border px-3 py-2 text-xs text-muted-foreground first:border-t-0"
        >
          {status ?? (more > 0 ? t("more", { count: more }) : t("partial"))}
        </p>
      ) : null}
    </div>
  );
}

/** The keyboard and highlight state both pickers share. */
function useCombobox(rowCount: number) {
  const [open, setOpen] = useState(false);
  const [wanted, setWanted] = useState(0);
  const setHighlight = setWanted;
  // The list can shrink under the highlight as the query narrows it.
  const highlight = Math.min(wanted, Math.max(0, rowCount - 1));
  const move = (by: 1 | -1) => {
    if (rowCount === 0) return;
    setHighlight((i) => (Math.min(i, rowCount - 1) + by + rowCount) % rowCount);
  };
  return { open, setOpen, highlight, setHighlight, move };
}

/** The value of list row `i`: a shown match, then the typed row after them. */
function rowAt(
  i: number,
  matches: readonly PickerOption[],
  typed: string | null,
): string | null {
  const shown = Math.min(matches.length, SHOWN);
  if (i < shown) return matches[i]?.value ?? null;
  return i === shown ? typed : null;
}

/** The row the typed text offers in a freeform picker, or null when an option already says it. */
function typedRow(
  freeform: boolean,
  query: string,
  options: readonly PickerOption[],
): string | null {
  const text = query.trim();
  if (!freeform || text === "") return null;
  return options.some((o) => o.value === text) ? null : text;
}

export type RecordPickerProps = BaseProps & {
  value?: string | undefined;
  defaultValue?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
};

/** Pick one record by typing part of its name. */
export function RecordPicker({
  id,
  name,
  options,
  load,
  freeform = false,
  required,
  disabled,
  placeholder,
  value: controlled,
  defaultValue = "",
  onChange,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  "data-testid": testId,
}: RecordPickerProps) {
  const t = useTranslations("ui.picker");
  const [source, ensure] = useSource(options, load);
  const [own, setOwn] = useState(defaultValue);
  const value = controlled ?? own;
  const all = source.status === "ready" ? source.page.options : NONE;
  const labelOf = (v: string) => all.find((o) => o.value === v)?.label ?? v;
  // A prefilled value is shown by its label, so its list is read up front.
  const prefilled = value !== "";
  useEffect(() => {
    if (prefilled) ensure();
  }, [prefilled, ensure]);
  const [query, setQuery] = useState<string | null>(null);
  const text = query ?? (value === "" ? "" : labelOf(value));
  const matches = useMemo(
    () => (query === null ? [...all] : rank(all, query)),
    [all, query],
  );
  const typed = typedRow(freeform, query ?? "", all);
  const rowCount = Math.min(matches.length, SHOWN) + (typed === null ? 0 : 1);
  const { open, setOpen, highlight, setHighlight, move } =
    useCombobox(rowCount);
  const listId = useId();
  const optionId = (i: number) => `${listId}-o${String(i)}`;

  const rowValue = (i: number) => rowAt(i, matches, typed);

  const pick = (next: string) => {
    if (controlled === undefined) setOwn(next);
    onChange?.(next);
    setQuery(null);
    setOpen(false);
  };

  const openList = () => {
    ensure();
    setOpen(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) openList();
      else move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter" && open) {
      const next = rowValue(highlight);
      if (next !== null) {
        e.preventDefault();
        pick(next);
      }
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setQuery(null);
      setOpen(false);
    }
  };

  return (
    <div className="min-w-0" data-testid={testId}>
      <input
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-expanded={open && rowCount > 0}
        aria-controls={open && rowCount > 0 ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          open && rowCount > 0 ? optionId(highlight) : undefined
        }
        aria-describedby={describedBy}
        aria-invalid={invalid}
        required={required === true && value === ""}
        disabled={disabled}
        placeholder={placeholder ?? t("search")}
        value={text}
        onFocus={openList}
        onClick={openList}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          if (!open) openList();
          if (e.target.value === "" && value !== "") {
            if (controlled === undefined) setOwn("");
            onChange?.("");
          }
        }}
        onBlur={() => {
          if (freeform && query !== null && query.trim() !== "")
            pick(query.trim());
          else {
            setQuery(null);
            setOpen(false);
          }
        }}
        onKeyDown={onKeyDown}
        className={inputBase}
      />
      {name === undefined ? null : (
        <input type="hidden" name={name} value={value} />
      )}
      {open ? (
        <OptionList
          listId={listId}
          source={source}
          matches={matches}
          highlight={highlight}
          query={query ?? ""}
          isChosen={(v) => v === value}
          typed={typed}
          onPick={pick}
          onHover={setHighlight}
          optionId={optionId}
          freeform={freeform}
        />
      ) : null}
    </div>
  );
}

export type RecordMultiPickerProps = BaseProps & {
  value?: readonly string[] | undefined;
  defaultValue?: readonly string[] | undefined;
  onChange?: ((value: string[]) => void) | undefined;
  /** How the hidden input joins the values: ", " for a comma list, "\n" for one per line. */
  joiner?: string | undefined;
};

/** Pick a set of records, shown as chips, by typing part of each name. */
export function RecordMultiPicker({
  id,
  name,
  options,
  load,
  freeform = false,
  required,
  disabled,
  placeholder,
  value: controlled,
  defaultValue = [],
  onChange,
  joiner = ", ",
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  "data-testid": testId,
}: RecordMultiPickerProps) {
  const t = useTranslations("ui.picker");
  const [source, ensure] = useSource(options, load);
  const [own, setOwn] = useState<readonly string[]>(defaultValue);
  const values = controlled ?? own;
  const all = source.status === "ready" ? source.page.options : NONE;
  const [query, setQuery] = useState("");
  const matches = useMemo(() => rank(all, query), [all, query]);
  const typed = typedRow(freeform, query, all);
  const rowCount = Math.min(matches.length, SHOWN) + (typed === null ? 0 : 1);
  const { open, setOpen, highlight, setHighlight, move } =
    useCombobox(rowCount);
  const listId = useId();
  const optionId = (i: number) => `${listId}-o${String(i)}`;
  const inputRef = useRef<HTMLInputElement>(null);
  // A prefilled value is shown by its label, so its list is read up front.
  const prefilled = values.length > 0;
  useEffect(() => {
    if (prefilled) ensure();
  }, [prefilled, ensure]);

  const commit = (next: string[]) => {
    if (controlled === undefined) setOwn(next);
    onChange?.(next);
  };
  const add = (entries: readonly string[]) => {
    const fresh = entries.filter((v) => v !== "" && !values.includes(v));
    if (fresh.length > 0) commit([...values, ...fresh]);
  };
  const toggle = (v: string) => {
    if (values.includes(v)) commit(values.filter((x) => x !== v));
    else commit([...values, v]);
    setQuery("");
    setHighlight(0);
  };
  const remove = (v: string) => {
    commit(values.filter((x) => x !== v));
    inputRef.current?.focus();
  };

  const rowValue = (i: number) => rowAt(i, matches, typed);

  const openList = () => {
    ensure();
    setOpen(true);
  };

  /** Freeform text typed with separators becomes one chip per entry. */
  const takeTyped = (raw: string): boolean => {
    if (!freeform || !SEPARATOR.test(raw)) return false;
    const parts = raw.split(SEPARATOR);
    const rest = parts.pop() ?? "";
    add(parts.map((p) => p.trim()));
    setQuery(rest);
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) openList();
      else move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      const next = open ? rowValue(highlight) : null;
      if (next !== null) {
        e.preventDefault();
        toggle(next);
      } else if (freeform && query.trim() !== "") {
        e.preventDefault();
        add([query.trim()]);
        setQuery("");
      }
    } else if (e.key === "Backspace" && query === "" && values.length > 0) {
      commit(values.slice(0, -1));
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  const labelOf = (v: string) => all.find((o) => o.value === v)?.label ?? v;

  return (
    <div className="min-w-0" data-testid={testId}>
      <div className={chipBox} aria-disabled={disabled}>
        {values.map((v) => {
          const label = labelOf(v);
          return (
            <span
              key={v}
              data-chip={v}
              className="inline-flex max-w-full items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-xs text-foreground"
            >
              <span className={`truncate ${label === v ? mono : ""}`}>
                {label}
              </span>
              <button
                type="button"
                disabled={disabled}
                aria-label={t("remove", { label })}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(v);
                }}
                className="rounded px-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                ×
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-expanded={open && rowCount > 0}
          aria-controls={open && rowCount > 0 ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            open && rowCount > 0 ? optionId(highlight) : undefined
          }
          aria-describedby={describedBy}
          aria-invalid={invalid}
          required={required === true && values.length === 0}
          disabled={disabled}
          placeholder={values.length === 0 ? (placeholder ?? t("search")) : ""}
          value={query}
          onFocus={openList}
          onChange={(e) => {
            if (takeTyped(e.target.value)) return;
            setQuery(e.target.value);
            setHighlight(0);
            if (!open) openList();
          }}
          onBlur={() => {
            if (freeform && query.trim() !== "") add([query.trim()]);
            setQuery("");
            setOpen(false);
          }}
          onKeyDown={onKeyDown}
          className="min-w-[8ch] flex-1 bg-transparent py-0.5 outline-none placeholder:text-input-placeholder"
        />
      </div>
      {name === undefined ? null : (
        <input type="hidden" name={name} value={values.join(joiner)} />
      )}
      {open ? (
        <OptionList
          listId={listId}
          source={source}
          matches={matches}
          highlight={highlight}
          query={query}
          isChosen={(v) => values.includes(v)}
          typed={typed}
          onPick={toggle}
          onHover={setHighlight}
          optionId={optionId}
          freeform={freeform}
        />
      ) : null}
    </div>
  );
}
