import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { replaceSessionEntry } from "./session-accessor.js";
import {
  resolveExistingAgentSessionStoreTargetsReadOnlyResult as readTargets,
  type SessionStoreTargetsReadCache,
} from "./targets-read-availability.worker.js";

afterEach(() => clearRuntimeConfigSnapshot());

const missingStoreConfig = (home: string): OpenClawConfig => ({
  session: { store: path.join(home, "custom", "{agentId}", "sessions.sqlite") },
});
const fixedStoreConfig = (store: string, owner = true): OpenClawConfig => ({
  session: { store },
  agents: {
    ownership: "explicit",
    ...(owner
      ? { defaults: { sessionStore: { agentId: "main" } }, entries: { main: {}, ops: {} } }
      : { entries: { ops: {}, research: {} } }),
  },
});
const write = (agentId: string, key = "main", updatedAt = 1, storePath?: string) =>
  replaceSessionEntry(
    { agentId, storePath, sessionKey: `agent:${agentId}:${key}` },
    { sessionId: key === "main" ? `${agentId}-session` : key, updatedAt },
  );

describe("session store availability", () => {
  it("uses admitted per-agent availability without probing session rows", async () => {
    await withTempHome(async () => {
      setRuntimeConfigSnapshot({});
      await write("main", "existing");
      const resolve = () => readTargets({}, "main");
      expect(resolve()).toMatchObject({ available: true, targets: [{ agentId: "main" }] });
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      try {
        await write("main", "new", 2);
        prepare.mockClear();
        expect(resolve()).toMatchObject({ available: true, targets: [{ agentId: "main" }] });
        expect(
          prepare.mock.calls.filter(([query]) => /from\s+"?session_nodes\b/i.test(query)),
        ).toEqual([]);
      } finally {
        prepare.mockRestore();
      }
    });
  });

  it("reads cross-agent rows from a migrated fixed store", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "shared.sqlite");
      const cfg = fixedStoreConfig(storePath);
      setRuntimeConfigSnapshot(cfg);
      await write("main", "main", 1, storePath);
      await write("ops", "main", 1, storePath);
      const cache: SessionStoreTargetsReadCache = new Map();

      expect(readTargets(cfg, "main", { cache })).toEqual({
        available: true,
        targets: [{ agentId: "main", storePath }],
      });
      expect(readTargets(cfg, "ops", { cache })).toEqual({
        available: true,
        targets: [{ agentId: "ops", storePath }],
      });
      expect(cache.size).toBe(1);
    });
  });

  it("does not let a missing configured store poison readable discovered siblings", async () => {
    await withTempHome(async (home) => {
      setRuntimeConfigSnapshot({});
      // The configured candidate is absent during migration; its discovered sibling is live.
      await replaceSessionEntry(
        { agentId: "main", sessionKey: "agent:main:main" },
        { sessionId: "live-session", updatedAt: 1 },
      );
      const cfg = missingStoreConfig(home);

      setRuntimeConfigSnapshot(cfg);
      const result = readTargets(cfg, "main");

      // A false absence here would destroy live worker placements.
      expect(result.available).toBe(true);
      if (result.available) {
        expect(result.targets.length).toBeGreaterThan(0);
      }
    });
  });

  it("reports database-missing only when no candidate store exists", async () => {
    await withTempHome(async (home) => {
      const cfg = missingStoreConfig(home);

      setRuntimeConfigSnapshot(cfg);
      expect(readTargets(cfg, "main")).toEqual({
        available: false,
        reason: "database-missing",
      });
    });
  });

  it("reads ownerless fixed-store rows under the requested agent", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "ownerless-shared.sqlite");
      const cfg = fixedStoreConfig(storePath, false);
      setRuntimeConfigSnapshot(cfg);
      await write("ops", "main", 1, storePath);

      expect(readTargets(cfg, "ops")).toEqual({
        available: true,
        targets: [{ agentId: "ops", storePath }],
      });
    });
  });
});
