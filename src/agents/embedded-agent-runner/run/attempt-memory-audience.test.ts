import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSessionOwner } from "../../../plugins/memory-audience.test-support.js";

const mocks = vi.hoisted(() => ({
  providerRuntime: undefined as unknown,
  warn: vi.fn(),
  info: vi.fn(),
}));

// mock-isolation: the fake session owner replaces SQLite generation facts.
vi.mock("../../../config/sessions/session-delivery-generation.js", async () => {
  const { fakeSessionGenerationModule } =
    await import("../../../plugins/memory-audience.test-support.js");
  return fakeSessionGenerationModule;
});
// mock-isolation: the fake session owner replaces worker-thread session reads.
vi.mock("../../../config/sessions/session-entry-read-runtime.js", async () => {
  const { fakeSessionEntryReadModule } =
    await import("../../../plugins/memory-audience.test-support.js");
  return fakeSessionEntryReadModule;
});
vi.mock("../../../plugins/memory-state.js", () => ({
  resolveLoadedMemoryProviderKind: () => (mocks.providerRuntime ? "native" : undefined),
}));
// mock-isolation: captures the attempt's log levels without emitting them.
vi.mock("../logger.js", () => ({ log: { warn: mocks.warn, info: mocks.info, debug: vi.fn() } }));

import { resolveEmbeddedAttemptMemoryAudience } from "./attempt-memory-audience.js";

const ROOT_KEY = "agent:main:root";
const CHILD_KEY = "agent:main:subagent:child";
const STORE_PATH = "/tmp/openclaw-attempt-memory-audience/main.sqlite";

const attempt = {
  agentId: "main",
  sessionKey: CHILD_KEY,
  sessionId: "child-session",
  senderIsOwner: false,
  admission: { entry: { sessionId: "child-session", updatedAt: 1 }, storePath: STORE_PATH },
};

// A spawned child whose receipt names its parent's incarnation at spawn time.
function spawnedChildAttempt(kind: "stale" | "unverified") {
  mocks.providerRuntime = {};
  const parent = {
    sessionId: randomUUID(),
    lifecycleRevision: randomUUID(),
    chatType: "direct" as const,
    updatedAt: 1,
  };
  const child = {
    sessionId: randomUUID(),
    lifecycleRevision: randomUUID(),
    updatedAt: 1,
    spawnedBy: ROOT_KEY,
    parentSessionKey: ROOT_KEY,
    spawnedBySessionId: parent.sessionId,
    parentSessionLifecycleRevision: parent.lifecycleRevision,
    spawnedBySenderIsOwner: true,
  };
  fakeSessionOwner.rows.set(ROOT_KEY, parent);
  fakeSessionOwner.rows.set(CHILD_KEY, child);
  if (kind === "stale") {
    fakeSessionOwner.rows.set(ROOT_KEY, { ...parent, lifecycleRevision: randomUUID() });
  } else {
    fakeSessionOwner.pendingKeys.add(ROOT_KEY);
  }
  return {
    ...attempt,
    sessionId: child.sessionId,
    admission: { entry: child, storePath: STORE_PATH },
  };
}

describe("embedded attempt memory audience", () => {
  beforeEach(() => {
    mocks.providerRuntime = undefined;
    mocks.warn.mockReset();
    mocks.info.mockReset();
    fakeSessionOwner.reset();
  });

  it("resolves no audience, lineage, or leases for a legacy memory owner", async () => {
    const resolved = await resolveEmbeddedAttemptMemoryAudience(attempt);

    expect(resolved.memoryAudience).toBeUndefined();
    expect(fakeSessionOwner).toMatchObject({ workerReads: [], activeLeases: 0 });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it.each(["stale", "unverified"] as const)(
    "denies %s lineage with the appropriate repair log",
    async (kind) => {
      const resolved = await resolveEmbeddedAttemptMemoryAudience(spawnedChildAttempt(kind));
      expect(resolved.memoryAudience).toBeUndefined();
      if (kind === "stale") {
        expect(mocks.warn).toHaveBeenCalledOnce();
        const [message] = mocks.warn.mock.calls[0] as [string];
        expect(message).toContain(`session ${CHILD_KEY} has stale lineage`);
        expect(message).toContain("Respawn or recreate it from a current session");
      } else {
        expect(mocks.warn).not.toHaveBeenCalled();
        expect(mocks.info).toHaveBeenCalledWith(
          expect.stringContaining("could not verify the lineage"),
          expect.objectContaining({ kind: "unverified" }),
        );
        expect(fakeSessionOwner.activeLeases).toBe(0);
      }
    },
  );
});
