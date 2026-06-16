// fake-tx.ts — a fluent, queue-driven Drizzle transaction double for handler
// unit tests. Each call to select/insert/update returns a chainable thenable;
// the chain resolves (when awaited OR when a terminal like .limit/.returning/
// .orderBy/.groupBy is invoked) to the next result pushed via enqueue().
//
// This lets a handler issue several queries in sequence and have each resolve
// to a controlled fixture without brittle per-method chain counting.

export interface FakeTxController {
  /** The fake tx object to pass where a Drizzle Tx is expected. */
  tx: unknown;
  /** Queue one or more result values, consumed in FIFO order per query. */
  enqueue: (...results: unknown[]) => void;
  /** Reset the queue between tests. */
  reset: () => void;
}

export function createFakeTx(): FakeTxController {
  const queue: unknown[] = [];

  function nextResult(): unknown {
    return queue.length > 0 ? queue.shift() : [];
  }

  // A chain node is awaitable (then) and infinitely chainable. EVERY builder
  // method (select/from/where/orderBy/limit/returning/insert/values/update/
  // set/onConflictDoNothing/leftJoin/groupBy/…) returns the same chain, so the
  // handler can compose any sequence. The chain resolves to the next queued
  // result only when it is awaited — which is how every query terminates.
  function makeChain(): unknown {
    let consumed = false;
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_target, prop) {
        if (prop === "then") {
          // Awaiting the chain resolves to (and consumes) the next result once.
          return (onFulfilled: (v: unknown) => unknown) => {
            const value = consumed ? [] : nextResult();
            consumed = true;
            return Promise.resolve(value).then(onFulfilled);
          };
        }
        return () => proxy;
      },
    };
    const proxy: unknown = new Proxy({}, handler);
    return proxy;
  }

  const tx = {
    select: () => makeChain(),
    insert: () => makeChain(),
    update: () => makeChain(),
    delete: () => makeChain(),
  };

  return {
    tx,
    enqueue: (...results: unknown[]) => {
      queue.push(...results);
    },
    reset: () => {
      queue.length = 0;
    },
  };
}
