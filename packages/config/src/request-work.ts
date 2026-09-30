import { AsyncLocalStorage } from "node:async_hooks";

/** A request keeps its admission reservation while its work is still running. */
export interface RequestWork {
  run<T>(operation: () => T): T;
  track<T>(operation: () => T | PromiseLike<T>): Promise<T>;
  close(): void;
}

const requestWork = new AsyncLocalStorage<RequestWork>();

export function createRequestWork(release: () => void): RequestWork {
  let active = 0;
  let closed = false;
  let released = false;
  const releaseIfIdle = (): void => {
    if (!closed || active !== 0 || released) return;
    released = true;
    release();
  };
  const work: RequestWork = {
    run: (operation) => requestWork.run(work, operation),
    async track(operation) {
      if (released) throw new Error("The request has ended. Start a new request.");
      active += 1;
      try {
        return await operation();
      } finally {
        active -= 1;
        releaseIfIdle();
      }
    },
    close() {
      closed = true;
      releaseIfIdle();
    },
  };
  return work;
}

/** Outside an HTTP admission scope, execute with the caller's usual lifetime. */
export async function trackRequestWork<T>(operation: () => T | PromiseLike<T>): Promise<T> {
  const work = requestWork.getStore();
  return work === undefined ? await operation() : work.track(operation);
}
