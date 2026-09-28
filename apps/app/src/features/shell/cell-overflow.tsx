"use client";
// Text in a table cell never wraps: src/app/globals.css ends a long value with
// an ellipsis, and this shows the whole value when a pointer rests on it or
// focus lands in its cell. One tooltip serves every table on the page, as the
// mockup's `#rtip` does (mockups/components/src/tooltip.mjs). It listens on the
// document, so a table a page adds later needs nothing from the page.
import { Tooltip } from "@base-ui/react/tooltip";
import { useEffect, useRef, useState } from "react";

/** How long a pointer rests on a cut value before the whole value shows. */
export const OPEN_DELAY_MS = 300;

const BODY_CELL = "[data-shell-page] tbody :is(td, th):not([colspan])";

/**
 * The element nearest `target`, up to and including its body cell, whose text
 * runs past its own box. Null when the target is outside a body cell or every
 * value in its path fits.
 */
export function clippedElement(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const cell = target.closest(BODY_CELL);
  if (cell === null) return null;
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
  const pending = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (node: HTMLElement | null, delay: number) => {
      if (node === pending.current) return;
      clearTimeout(timer);
      pending.current = node;
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

  return (
    <Tooltip.Root
      open={shown !== null}
      onOpenChange={(open) => {
        if (open) return;
        pending.current = null;
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
            className="pointer-events-none max-w-[min(34rem,calc(100vw-16px))] rounded-md bg-tooltip-bg px-2 py-[5px] font-mono text-[11px] leading-[1.4] break-words whitespace-pre-line text-tooltip-fg shadow-sm">
            {shown?.text}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
