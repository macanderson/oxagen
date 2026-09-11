/**
 * A push-side async iterable: the engine loop pushes parts as frames arrive,
 * and the chat route reads them as `fullStream`. `end()` closes it; `fail()`
 * closes it with a rejection for the reader still waiting.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiting:
    | { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }
    | undefined;
  private done = false;
  private failure: unknown;

  push(item: T): void {
    if (this.done) return;
    if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = undefined;
      resolve({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    this.waiting?.resolve({ value: undefined, done: true });
    this.waiting = undefined;
  }

  fail(error: unknown): void {
    if (this.done) return;
    this.done = true;
    this.failure = error;
    this.waiting?.reject(error);
    this.waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          return Promise.resolve({
            value: this.items.shift() as T,
            done: false,
          });
        }
        if (this.done) {
          return this.failure !== undefined
            ? Promise.reject(this.failure)
            : Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve, reject) => {
          this.waiting = { resolve, reject };
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
