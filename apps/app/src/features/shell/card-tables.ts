// Every list table on a page becomes a stack of cards on a phone (Mockups
// origin/main mc.html `cardTables`, ARCHITECTURE.md §1.2): a table with one
// header row and no grouped header gets `data-cards`, and each of its body
// cells the text of its column header as `data-label`, which src/ui/phone.css
// prints beside the value so nothing scrolls sideways. A table with grouped
// headers keeps its grid. Labelling runs over the page element the shell frame
// renders and again whenever that page changes, so a table a page adds is
// labelled without the page doing anything.
import { useEffect } from "react";

function labelCardTables(page: Element): void {
  for (const table of page.querySelectorAll("table")) {
    const head = table.tHead?.rows;
    const only = head?.length === 1 ? head.item(0) : null;
    const headers = only === null ? [] : [...only.cells];
    if (headers.length === 0 || headers.some((th) => th.colSpan > 1)) continue;
    const labels = headers.map((th) =>
      th.textContent.replace(/\s+/g, " ").trim(),
    );
    for (const body of table.tBodies)
      for (const row of body.rows)
        for (const [index, cell] of [...row.cells].entries()) {
          const label = labels[index];
          if (cell.colSpan === 1 && label)
            cell.setAttribute("data-label", label);
        }
    table.setAttribute("data-cards", "");
  }
}

export function useCardTables(): void {
  useEffect(() => {
    const page = document.querySelector("[data-shell-page]");
    if (page === null) return;
    labelCardTables(page);
    const observer = new MutationObserver(() => {
      labelCardTables(page);
    });
    observer.observe(page, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      observer.disconnect();
    };
  }, []);
}
