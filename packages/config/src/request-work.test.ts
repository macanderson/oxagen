import { describe, expect, it, vi } from "vitest";
import { createRequestWork, trackRequestWork } from "./request-work";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("request work", () => {
  it("retains admission after disconnect until detached work settles", async () => {
    const release = vi.fn();
    const work = createRequestWork(release);
    const task = deferred<number>();
    const pending = work.run(() => trackRequestWork(() => task.promise));
    work.close();
    work.close();
    expect(release).not.toHaveBeenCalled();
    task.resolve(7);
    await expect(pending).resolves.toBe(7);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("holds nested work until every promise completes", async () => {
    const release = vi.fn();
    const work = createRequestWork(release);
    const task = deferred<void>();
    let child: Promise<void> = Promise.resolve();
    await work.run(() => trackRequestWork(() => {
      child = trackRequestWork(() => task.promise);
    }));
    work.close();
    expect(release).not.toHaveBeenCalled();
    task.resolve();
    await child;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects late work after reservation release", async () => {
    const release = vi.fn();
    const work = createRequestWork(release);
    const late = vi.fn();
    work.close();
    await expect(work.run(() => trackRequestWork(late))).rejects.toThrow("request has ended");
    expect(late).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases after rejected work and does not alter the error", async () => {
    const release = vi.fn();
    const work = createRequestWork(release);
    const error = new Error("downstream failed");
    const result = work.run(() => trackRequestWork(() => {
      work.close();
      throw error;
    }));
    await expect(result).rejects.toBe(error);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not release completed work before the connection closes", async () => {
    const release = vi.fn();
    const work = createRequestWork(release);
    await work.run(() => trackRequestWork(() => 1));
    expect(release).not.toHaveBeenCalled();
    work.close();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("preserves concurrent request scopes and callers outside admission", async () => {
    const first = createRequestWork(vi.fn());
    const second = createRequestWork(vi.fn());
    first.close();
    await expect(first.run(() => trackRequestWork(() => 1))).rejects.toThrow();
    await expect(second.run(() => trackRequestWork(() => 2))).resolves.toBe(2);
    await expect(trackRequestWork(() => 3)).resolves.toBe(3);
    second.close();
  });
});
