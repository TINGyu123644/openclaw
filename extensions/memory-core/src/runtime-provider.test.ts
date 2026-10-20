import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { describe, expect, it, vi } from "vitest";

const managerDebug = {
  backend: "builtin" as const,
  purpose: "default" as const,
  managerMs: 7,
};

const getMemorySearchManagerMock = vi.hoisted(() =>
  vi.fn(async () => ({
    manager: null,
    debug: managerDebug,
    error: undefined,
  })),
);
const filterMemorySearchHitsBySessionVisibilityMock = vi.hoisted(() => vi.fn());
const configureMemoryCoreDreamingStateMock = vi.hoisted(() => vi.fn());

vi.mock("./memory/index.js", () => ({
  closeAllMemorySearchManagers: vi.fn(async () => {}),
  closeMemorySearchManager: vi.fn(async () => {}),
  getMemorySearchManager: getMemorySearchManagerMock,
}));

vi.mock("./session-search-visibility.js", () => ({
  filterMemorySearchHitsBySessionVisibility: filterMemorySearchHitsBySessionVisibilityMock,
}));

vi.mock("./dreaming-state.js", () => ({
  configureMemoryCoreDreamingState: configureMemoryCoreDreamingStateMock,
}));

import { runInMemoryTestBackgroundContext } from "./memory/background-context.test-support.js";
import { createMemoryRuntime } from "./runtime-provider.js";

const memoryRuntime = createMemoryRuntime({
  runInBackgroundContext: runInMemoryTestBackgroundContext,
});
const params = { cfg: {}, agentId: "main" };

describe("memoryRuntime", () => {
  it("preserves manager debug metadata", async () => {
    const result = await memoryRuntime.getMemorySearchManager(params);
    expect(result.debug).toEqual(managerDebug);
    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({
      ...params,
      runInBackgroundContext: runInMemoryTestBackgroundContext,
    });
  });

  it("forwards optional diagnostic source inspection", async () => {
    const diagnostic = { ...params, purpose: "status" as const, inspectSources: true };
    await memoryRuntime.getMemorySearchManager(diagnostic);
    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({
      ...diagnostic,
      runInBackgroundContext: runInMemoryTestBackgroundContext,
    });
  });

  it("keeps local-service acquisition scoped to each runtime instance", async () => {
    const requests = ["first", "second"].map((agentId) => ({
      cfg: params.cfg,
      agentId,
      acquireLocalService: vi.fn(async () => undefined),
    }));
    await Promise.all(
      requests.map(({ acquireLocalService, ...request }) =>
        createMemoryRuntime({ acquireLocalService }).getMemorySearchManager(request),
      ),
    );
    for (const request of requests) {
      expect(getMemorySearchManagerMock).toHaveBeenCalledWith(request);
    }
  });

  it("binds the scoped state opener inside each lazy runtime instance", async () => {
    const openKeyedStore = vi.fn();
    configureMemoryCoreDreamingStateMock.mockClear();

    await createMemoryRuntime({ openKeyedStore }).getMemorySearchManager(params);

    expect(configureMemoryCoreDreamingStateMock).toHaveBeenCalledWith(openKeyedStore);
  });

  it("delegates raw-hit authorization to the canonical session visibility filter", async () => {
    const hits: MemorySearchResult[] = [
      {
        source: "sessions",
        path: "sessions/private.jsonl",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "private",
      },
    ];
    filterMemorySearchHitsBySessionVisibilityMock.mockResolvedValue([]);
    const request = {
      ...params,
      requesterSessionKey: "agent:main:voice:15550001234",
      sandboxed: false,
      hits,
    };
    await expect(memoryRuntime.authorizeSearchHits(request)).resolves.toEqual([]);
    expect(filterMemorySearchHitsBySessionVisibilityMock).toHaveBeenCalledWith(request);
  });
});
