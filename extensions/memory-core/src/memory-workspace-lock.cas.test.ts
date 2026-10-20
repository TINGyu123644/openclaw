import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import { deleteShortTermLockEntryIfCurrent } from "./memory-workspace-lock.js";
import type { ShortTermLockEntry } from "./short-term-promotion-types.js";

vi.mock("./dreaming-state.js", () => ({
  SHORT_TERM_LOCK_NAMESPACE: "short-term-locks",
  memoryCoreStateReference: (namespace: string, workspace: string) => `${namespace}/${workspace}`,
  memoryCoreWorkspaceStateKey: (workspace: string) => workspace,
}));
const lockKey = "synthetic-workspace";
const expected: ShortTermLockEntry = { owner: "synthetic-owner", acquiredAt: 1 };
function createLockStore(replacement?: ShortTermLockEntry) {
  const rows = new Map([[lockKey, structuredClone(expected)]]);
  const unused = async () => {
    throw new Error("Unexpected lock-store operation");
  };
  const observation = (key: string) => ({
    value: structuredClone(rows.get(key)),
    comparison: JSON.stringify(rows.get(key)) ?? "missing",
  });
  const store = {
    observe: vi.fn(async (key: string) => observation(key)),
    compareAndApply: vi.fn<
      NonNullable<PluginStateKeyedStore<ShortTermLockEntry>["compareAndApply"]>
    >(async (key, comparison, intent) => {
      const current = observation(key);
      if (comparison !== current.comparison) {
        return { status: "conflict", current };
      }
      if (intent.action === "keep") {
        return { status: "unchanged" };
      }
      if (intent.action === "delete") {
        return { status: rows.delete(key) ? "applied" : "unchanged" };
      }
      rows.set(key, structuredClone(intent.value));
      return { status: "applied" };
    }),
    register: unused,
    registerIfAbsent: unused,
    async lookup(key: string) {
      return structuredClone(rows.get(key));
    },
    consume: unused,
    delete: unused,
    entries: unused,
    clear: unused,
  } satisfies PluginStateKeyedStore<ShortTermLockEntry>;
  if (replacement) {
    const compare = store.compareAndApply.getMockImplementation()!;
    store.compareAndApply.mockImplementationOnce(async (...args) => {
      rows.set(lockKey, structuredClone(replacement));
      return compare(...args);
    });
  }
  return store;
}

describe("memory workspace lock comparisons", () => {
  it.each([
    { owner: "replacement-owner", acquiredAt: expected.acquiredAt },
    { owner: expected.owner, acquiredAt: expected.acquiredAt + 1 },
  ])("preserves a replacement lock after a comparison conflict: %j", async (replacement) => {
    const store = createLockStore(replacement);

    await expect(deleteShortTermLockEntryIfCurrent(store, lockKey, expected)).resolves.toBe(false);
    expect(await store.lookup(lockKey)).toEqual(replacement);
  });

  it("retries a conflict while preserving the owner and acquisition-time predicate", async () => {
    const store = createLockStore({ ...expected, ownerStartTime: 456 });

    await expect(deleteShortTermLockEntryIfCurrent(store, lockKey, expected)).resolves.toBe(true);
    expect(await store.lookup(lockKey)).toBeUndefined();
  });

  it.each(["observe", "compareAndApply"] as const)(
    "requires %s before deletion",
    async (method) => {
      const store: PluginStateKeyedStore<ShortTermLockEntry> = createLockStore();
      store[method] = undefined;
      await expect(deleteShortTermLockEntryIfCurrent(store, lockKey, expected)).rejects.toThrow(
        "memory-core short-term lock store requires atomic comparisons",
      );
      expect(await store.lookup(lockKey)).toEqual(expected);
    },
  );
});
