import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import {
  withMemoryWorkspaceLock,
  withMemoryWorkspacePreparation,
} from "./memory-workspace-lock.js";

async function expectBlocked(
  order: string[],
  expected: string[],
  release: ReturnType<typeof createDeferred<void>>,
  pending: Promise<unknown>[],
) {
  try {
    await nextTurn();
    expect(order).toEqual(expected);
  } finally {
    release.resolve();
    await Promise.all(pending);
  }
}

describe("memory workspace ordering", () => {
  let caseId = 0;
  function setup() {
    const order: string[] = [];
    return {
      workspace: `/memory-workspace-test/case-${caseId++}`,
      entered: createDeferred<void>(),
      release: createDeferred<void>(),
      order,
    };
  }

  it("keeps preparations and writers in the same local FIFO", async () => {
    const { workspace, entered, release, order } = setup();
    const first = withMemoryWorkspacePreparation(workspace, async () => {
      order.push("first preparation");
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const writer = withMemoryWorkspaceLock(workspace, async () => {
      order.push("writer");
    });
    const last = withMemoryWorkspacePreparation(workspace, async () => {
      order.push("last preparation");
    });
    await expectBlocked(order, ["first preparation"], release, [first, writer, last]);
    expect(order).toEqual(["first preparation", "writer", "last preparation"]);
  });

  it("reenters a live write scope and serializes sibling preparations", async () => {
    const { workspace, entered, release, order } = setup();
    await withMemoryWorkspaceLock(workspace, async () => {
      const first = withMemoryWorkspacePreparation(workspace, async () => {
        order.push("first");
        entered.resolve();
        await release.promise;
        await withMemoryWorkspacePreparation(workspace, async () => {
          order.push("nested");
        });
      });
      const second = withMemoryWorkspacePreparation(workspace, async () => {
        order.push("second");
      });
      await entered.promise;
      await expectBlocked(order, ["first"], release, [first, second]);
    });
    expect(order).toEqual(["first", "nested", "second"]);
  });

  it("queues preparation resumed from an expired write scope behind the current writer", async () => {
    const { workspace, entered, release, order } = setup();
    const resume = createDeferred<void>();
    const attempted = createDeferred<void>();
    const retained = await withMemoryWorkspaceLock(workspace, async () => ({
      task: resume.promise.then(async () => {
        attempted.resolve();
        await withMemoryWorkspacePreparation(workspace, async () => {
          order.push("preparation");
        });
      }),
    }));
    const writer = withMemoryWorkspaceLock(workspace, async () => {
      entered.resolve();
      await release.promise;
      order.push("writer");
    });
    await entered.promise;
    resume.resolve();
    await attempted.promise;
    await expectBlocked(order, [], release, [writer, retained.task]);
    expect(order).toEqual(["writer", "preparation"]);
  });
});
