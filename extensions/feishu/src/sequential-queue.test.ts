import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSequentialQueue } from "./sequential-queue.js";

function gatedTask(
  enqueue: ReturnType<typeof createSequentialQueue>,
  key: string,
  label: string,
  order: string[],
) {
  const gate = createDeferred<void>();
  const started = createDeferred<void>();
  const done = enqueue(key, async () => {
    order.push(`${label}:start`);
    started.resolve();
    await gate.promise;
    order.push(`${label}:end`);
  });
  return { release: () => gate.resolve(), started: started.promise, done };
}

describe("createSequentialQueue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serializes tasks for the same key", async () => {
    const enqueue = createSequentialQueue();
    const order: string[] = [];
    const first = gatedTask(enqueue, "feishu:default:chat-1", "first", order);
    const second = enqueue("feishu:default:chat-1", async () => {
      order.push("second:start");
      order.push("second:end");
    });

    await first.started;
    expect(order).toEqual(["first:start"]);

    first.release();
    await Promise.all([first.done, second]);

    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("allows different keys to run concurrently", async () => {
    const enqueue = createSequentialQueue();
    const order: string[] = [];
    const first = gatedTask(enqueue, "feishu:default:chat-1", "chat-1", order);
    const second = gatedTask(enqueue, "feishu:default:chat-1:btw:om_2", "btw", order);
    await Promise.all([first.started, second.started]);
    expect(order).toEqual(["chat-1:start", "btw:start"]);

    first.release();
    second.release();
    await Promise.all([first.done, second.done]);

    expect(order).toContain("chat-1:end");
    expect(order).toContain("btw:end");
  });

  it("does not leak unhandled rejections when a queued task fails", async () => {
    const enqueue = createSequentialQueue();
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await expect(
        enqueue("feishu:default:chat-1", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandled).toStrictEqual([]);

      await expect(enqueue("feishu:default:chat-1", async () => {})).resolves.toBeUndefined();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("unblocks same-key work at the five-minute task deadline", async () => {
    vi.useFakeTimers();
    const timeouts: Array<{ key: string; timeoutMs: number }> = [];
    const enqueue = createSequentialQueue({
      onTaskTimeout: (key, timeoutMs) => {
        timeouts.push({ key, timeoutMs });
      },
    });
    const order: string[] = [];

    const stuck = gatedTask(enqueue, "feishu:default:chat-stuck", "stuck", order);

    const followUp = enqueue("feishu:default:chat-stuck", async () => {
      order.push("follow-up:ran");
    });

    await vi.advanceTimersByTimeAsync(299_999);
    expect(order).toEqual(["stuck:start"]);
    expect(timeouts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await followUp;

    expect(order).toEqual(["stuck:start", "follow-up:ran"]);
    expect(timeouts).toEqual([{ key: "feishu:default:chat-stuck", timeoutMs: 300_000 }]);

    stuck.release();
    await stuck.done;
  });
});
