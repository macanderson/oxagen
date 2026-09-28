"use client";
// Text that ends in an ellipsis shows its whole value in a hover card when a
// pointer rests on it or focus lands on it. It covers every body cell of every
// table, where src/app/globals.css keeps text on one line, and any element
// marked `data-truncate` elsewhere. One card serves the page, as the mockup's
// `#rtip` does (mockups/components/src/tooltip.mjs). It listens on the
// document, so a table or a marked line a page adds later needs nothing from
// the page.
import { useEffect, useRef, useState } from "react";
import { HoverCard, HoverCardContent } from "@/ui/hover-card";

/**
 * How long a pointer rests on a cut value before the whole value shows.
 * @internal Exported for its component test.
 */
export const OPEN_DELAY_MS = 300;

/** How often, at most, the keyboard stops follow a table or line that changes. */
const SCAN_INTERVAL_MS = 200;

const BODY_CELL = "tbody :is(td, th):not([colspan])";

/**
 * Marks truncated text outside a table. An empty value shows the element's own
 * text; a value shows that instead, for text the element shortens itself.
 */
const TRUNCATE = "[data-truncate]";

/**
 * Marks a cell or marked element `markCutCells` made focusable, so it can give
 * the stop back.
 */
const CUT = "data-cell-cut";

const FOCUSABLE = `a[href], button, input, select, textarea, summary, [tabindex]:not([${CUT}])`;

/**
 * A control that acts when focused. A stop nested in one is an accessibility
 * fault, so a marked element inside one takes none. A box that takes focus only
 * to scroll, such as an open tab panel or a scroll area, is not a control.
 */
const CONTROL = `a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="option"], [role="radio"], [role="switch"], [role="tab"]`;

/** Whether `cell`, or anything in it, has text that runs past its own box. */
function isCut(cell: HTMLElement): boolean {
  for (const node of [cell, ...cell.querySelectorAll<HTMLElement>("*")])
    if (node.scrollWidth > node.clientWidth && node.textContent.trim() !== "")
      return true;
  return false;
}

/**
 * Gives a keyboard stop to each body cell whose text is cut and that holds
 * nothing focusable, so focus can reach it and show the whole value. An element
 * marked `data-truncate` outside a body cell takes one the same way, unless it
 * sits in a control; one inside a cell leaves the stop to the cell. A cell or
 * element whose text fits again gives the stop back. It measures every one
 * before it changes any, so the page lays out once.
 * @internal Exported for its component test.
 */
export function markCutCells(root: ParentNode): void {
  const changes: [HTMLElement, boolean][] = [];
  const weigh = (node: HTMLElement, focusable: boolean) => {
    const marked = node.hasAttribute(CUT);
    if (!marked && node.hasAttribute("tabindex")) return;
    const wanted = !focusable && isCut(node);
    if (wanted !== marked) changes.push([node, wanted]);
  };
  for (const cell of root.querySelectorAll<HTMLElement>(BODY_CELL))
    weigh(cell, cell.querySelector(FOCUSABLE) !== null);
  for (const line of root.querySelectorAll<HTMLElement>(TRUNCATE))
    if (line.closest(BODY_CELL) === null)
      weigh(line, line.parentElement?.closest(CONTROL) != null);
  for (const [node, wanted] of changes)
    if (wanted) {
      node.setAttribute(CUT, "");
      node.tabIndex = 0;
    } else {
      node.removeAttribute(CUT);
      node.removeAttribute("tabindex");
    }
}

/** What the keyboard stops follow: every table, and every marked element. */
const MEASURED = `table, ${TRUNCATE}`;

/** Whether a mutation touched a table or a marked element, or added one. */
function touchesMeasured(record: MutationRecord): boolean {
  const at =
    record.target instanceof Element
      ? record.target
      : record.target.parentElement;
  if (at != null && at.closest(MEASURED) !== null) return true;
  return [...record.addedNodes].some(
    (node) =>
      node instanceof Element &&
      (node.matches(MEASURED) || node.querySelector(MEASURED) !== null),
  );
}

/**
 * The element nearest `target`, up to and including its body cell, whose text
 * runs past its own box. Focus on a cut cell itself reads the whole cell. An
 * element marked `data-truncate` counts when its own text is cut, in a table
 * or not. Null when the target is in neither, sits in a value with its own
 * hover card, or every value in its path fits. A value with a title shows
 * nothing to a pointer, which the browser serves, but shows the card to focus,
 * which the browser gives nothing (#4674).
 * @internal Exported for its component test.
 */
export function clippedElement(
  target: EventTarget | null,
  focus = false,
): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const marked = target.closest<HTMLElement>(TRUNCATE);
  if (marked !== null) return isCut(marked) ? marked : null;
  const cell = target.closest(BODY_CELL);
  if (cell === null) return null;
  // A value with its own hover card shows the whole value already.
  const own = target.closest(
    focus ? "[data-hover-card]" : "[data-hover-card], [title]",
  );
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
  const given = node.getAttribute("data-truncate");
  if (given !== null && given.trim() !== "") return given.trim();
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
      show(clippedElement(event.target, true), 0);
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

  // The keyboard stops follow the layout: a table or marked element that
  // changes or resizes is measured again, at most once per interval. A line a
  // growing transcript adds is a change, and one a closed section shows
  // resizes from nothing.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resized: ResizeObserver | null = null;
    const watched = new Set<Element>();
    const scan = () => {
      timer = undefined;
      for (const node of watched)
        if (!node.isConnected) {
          resized?.unobserve(node);
          watched.delete(node);
        }
      for (const node of document.querySelectorAll(MEASURED))
        if (!watched.has(node)) {
          watched.add(node);
          resized?.observe(node);
        }
      markCutCells(document);
    };
    const schedule = () => {
      timer ??= setTimeout(scan, SCAN_INTERVAL_MS);
    };
    if (typeof ResizeObserver !== "undefined")
      resized = new ResizeObserver(schedule);
    const changed = new MutationObserver((records) => {
      if (records.some(touchesMeasured)) schedule();
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
    <HoverCard
      open={shown !== null}
      onOpenChange={(open) => {
        if (open) return;
        pendingRef.current = null;
        setShown(null);
      }}
    >
      <HoverCardContent
        anchor={shown?.anchor ?? null}
        side="top"
        align="start"
        alignOffset={0}
        sideOffset={6}
        collisionPadding={8}
        role="tooltip"
        data-testid="whole-value"
        className="pointer-events-none w-auto max-w-[min(34rem,calc(100vw-16px))] px-3 py-2 break-words whitespace-pre-line"
      >
        {shown?.text}
      </HoverCardContent>
    </HoverCard>
  );
}
