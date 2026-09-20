// The draft a wizard is filling in (roadmap creation-spec §2, the mockup's
// `S.wz`). It lives in the browser only, for as long as the dialog is open,
// and it is never saved anywhere: the thing it describes exists when a person
// merges the pull request the last step opens.
//
// The store is a class rather than React state because the two ways of
// writing it differ on purpose. `write` changes the value and re-renders
// nothing (a keystroke in a description field); `update` changes it and asks
// React for one render (a choice that changes what is on screen).
import { useMemo, useState } from "react";
import type { DraftApi } from "./wizard";

class DraftStore<D extends object> {
  #value: D;

  constructor(initial: D) {
    this.#value = initial;
  }

  get value(): D {
    return this.#value;
  }

  merge(patch: Partial<D>): void {
    this.#value = { ...this.#value, ...patch };
  }
}

/** A draft that starts from `init()` and survives every render until the host remounts the wizard. */
export function useDraft<D extends object>(init: () => D): DraftApi<D> {
  const [store] = useState(() => new DraftStore(init()));
  const [, rerender] = useState(0);
  return useMemo<DraftApi<D>>(
    () => ({
      get draft() {
        return store.value;
      },
      write(patch) {
        store.merge(patch);
      },
      update(patch) {
        store.merge(patch);
        rerender((n) => n + 1);
      },
    }),
    [store],
  );
}
