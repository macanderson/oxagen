"use client";
// Text in a table cell never wraps: src/app/globals.css ends a long value with
// an ellipsis, and this shows the whole value when a pointer rests on it or
// focus lands in its cell. One tooltip serves every table on the page, as the
// mockup's `#rtip` does (mockups/components/src/tooltip.mjs). It listens on the
// document, so a table a page adds later needs nothing from the page.
import { Tooltip } from "@base-ui/react/tooltip";
import { useEffect, useRef, useState } from "react";

/**
 * How long a pointer rests on a cut value before the whole value shows.
 * @internal Exported for its component test.
 */
export const OPEN_DELAY_MS = 300;

/** How often, at most, the keyboard stops follow a table that changes. */
const SCAN_INTERVAL_MS = 200;

const BODY_CELL = "tbody :is(td, th):not([colspan])";

/** Marks a cell `markCutCells` made focusable, so it can give the stop back. */
const CUT = "data-cell-cut";

const FOCUSABLE = `a[href], button, input, select, textarea, summary, [tabindex]:not([${CUT}])`;

/** Whether `cell`, or anything in it, has text that runs past its own box. */
function isCut(cell: HTMLElement): boolean {
  for (const node of [cell, ...cell.querySelectorAll<HTMLElement>("*")])
    if (node.scrollWidth > node.clientWidth && node.textContent.trim() !== "")
      return true;
  return false;
}

/**
 * Gives a keyboard stop to each body cell whose text is cut and that holds
 * nothing focusable, so focus can reach it and show the whole value. A cell
 * whose text fits again gives the stop back. It measures every cell before it
 * changes any, so the page lays out once.
 * @internal Exported for its component test.
 */
export function markCutCells(root: ParentNode): void {
  const changes: [HTMLElement, boolean][] = [];
  for (const cell of root.querySelectorAll<HTMLElement>(BODY_CELL)) {
    const marked = cell.hasAttribute(CUT);
    if (!marked && cell.hasAttribute("tabindex")) continue;
    const wanted = cell.querySelector(FOCUSABLE) === null && isCut(cell);
    if (wanted !== marked) changes.push([cell, wanted]);
  }
  for (const [cell, wanted] of changes)
    if (wanted) {
      cell.setAttribute(CUT, "");
      cell.tabIndex = 0;
    } else {
      cell.removeAttribute(CUT);
      cell.removeAttribute("tabindex");
    }
}

/** Whether a mutation touched a table, or added one. */
function touchesTable(record: MutationRecord): boolean {
  const at =
    record.target instanceof Element
      ? record.target
      : record.target.parentElement;
  if (at != null && at.closest("table") !== null) return true;
  return [...record.addedNodes].some(
    (node) =>
      node instanceof Element &&
      (node.matches("table") || node.querySelector("table") !== null),
  );
}

/**
 * The element nearest `target`, up to and including its body cell, whose text
 * runs past its own box. Focus on a cut cell itself reads the whole cell. Null
 * when the target is outside a body cell, sits in a value with its own hover
 * card or title, or every value in its path fits.
 * @internal Exported for its component test.
 */
export function clippedElement(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const cell = target.closest(BODY_CELL);
  if (cell === null) return null;
  // A value with its own hover card or title shows the whole value already.
  const own = target.closest("[data-hover-card], [title]");
  if (own !== null && cell.contains(own)) return null;
  for (
    let node: Element | null = target;
    node !== null;
    node = node.parentElement
  ) {
    if (
      node instanceof HTMLElement &&
      node.scrollWidth > node.clientWidth &&
      node.textContent.trim() !== ""
    )
      return node;
    if (node === cell) break;
  }
  // A cut cell with nothing focusable in it takes a keyboard stop of its own.
  if (target === cell && cell instanceof HTMLElement && isCut(cell))
    return cell;
  return null;
}

/**
 * The whole value, with a line break between a name and the sub-line under it.
 * innerText follows the layout; jsdom has none, so tests read textContent.
 */
function wholeText(node: HTMLElement): string {
  const text =
    typeof node.innerText === "string" ? node.innerText : node.textContent;
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

type Shown = { anchor: HTMLElement; text: string };

export function CellOverflow() {
  const [shown, setShown] = useState<Shown | null>(null);
  // The element the last event pointed at, so moving within it keeps the timer.
  const pendingRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (node: HTMLElement | null, delay: number) => {
      if (node === pendingRef.current) return;
      clearTimeout(timer);
      pendingRef.current = node;
      if (node === null) {
        setShown(null);
        return;
      }
      timer = setTimeout(() => {
        setShown({ anchor: node, text: wholeText(node) });
      }, delay);
    };
    const onPointerOver = (event: PointerEvent) => {
      show(clippedElement(event.target), OPEN_DELAY_MS);
    };
    // The pointer left the window: nothing on the page fires pointerover.
    const onPointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) show(null, 0);
    };
    const onFocusIn = (event: FocusEvent) => {
      show(clippedElement(event.target), 0);
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget === null) show(null, 0);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") show(null, 0);
    };
    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // The keyboard stops follow the layout: a table that changes or resizes is
  // measured again, at most once per interval.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resized: ResizeObserver | null = null;
    const tables = new Set<Element>();
    const scan = () => {
      timer = undefined;
      for (const table of tables)
        if (!table.isConnected) {
          resized?.unobserve(table);
          tables.delete(table);
        }
      for (const table of document.querySelectorAll("table"))
        if (!tables.has(table)) {
          tables.add(table);
          resized?.observe(table);
        }
      markCutCells(document);
    };
    const schedule = () => {
      timer ??= setTimeout(scan, SCAN_INTERVAL_MS);
    };
    if (typeof ResizeObserver !== "undefined")
      resized = new ResizeObserver(schedule);
    const changed = new MutationObserver((records) => {
      if (records.some(touchesTable)) schedule();
    });
    // A paged table (ui/list-table.tsx) shows a page by changing each row's
    // style, so a style, class, or hidden change counts as a change.
    changed.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden"],
    });
    window.addEventListener("resize", schedule);
    scan();
    return () => {
      clearTimeout(timer);
      changed.disconnect();
      resized?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return (
    <Tooltip.Root
      open={shown !== null}
      onOpenChange={(open) => {
        if (open) return;
        pendingRef.current = null;
        setShown(null);
      }}
    >
      <Tooltip.Portal>
        <Tooltip.Positioner
          anchor={shown?.anchor ?? null}
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-50"
        >
          <Tooltip.Popup
            role="tooltip"
            className="pointer-events-none max-w-[min(34rem,calc(100vw-16px))] rounded-md bg-tooltip-bg px-2 py-[5px] font-mono text-[11px] leading-[1.4] break-words whitespace-pre-line text-tooltip-fg shadow-sm"
          >
            {shown?.text}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
