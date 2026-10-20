import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { describe, expect, it, vi } from "vitest";

const managerDebug = { backend: "builtin", purpose: "default", managerMs: 7 } as const;

const mocks = vi.hoisted(() => ({
  manager: vi.fn(async () => ({ manager: null, debug: managerDebug, error: undefined })),
  authorize: vi.fn(),
  configure: vi.fn(),
}));

vi.mock("./memory/index.js", () => ({
  closeAllMemorySearchManagers: vi.fn(async () => {}),
  closeMemorySearchManager: vi.fn(async () => {}),
  getMemorySearchManager: mocks.manager,
}));

vi.mock("./session-search-visibility.js", () => ({
  filterMemorySearchHitsBySessionVisibility: mocks.authorize,
}));

vi.mock("./dreaming-state.js", () => ({
  configureMemoryCoreDreamingState: mocks.configure,
}));

import { runInMemoryTestBackgroundContext } from "./memory/background-context.test-support.js";
import { createMemoryRuntime } from "./runtime-provider.js";

const memoryRuntime = createMemoryRuntime({
  runInBackgroundContext: runInMemoryTestBackgroundContext,
});
const params = { cfg: {}, agentId: "main" };

describe("memoryRuntime", () => {
  it.each([{}, { purpose: "status" as const, inspectSources: true }])(
    "preserves manager metadata and forwards acquisition options: %j",
    async (options) => {
      const request = { ...params, ...options };
      const result = await memoryRuntime.getMemorySearchManager(request);
      expect(result.debug).toEqual(managerDebug);
      expect(mocks.manager).toHaveBeenCalledWith({
        ...request,
        runInBackgroundContext: runInMemoryTestBackgroundContext,
      });
    },
  );

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
      expect(mocks.manager).toHaveBeenCalledWith(request);
    }
  });

  it("binds the scoped state opener inside each lazy runtime instance", async () => {
    const openKeyedStore = vi.fn();

    await createMemoryRuntime({ openKeyedStore }).getMemorySearchManager(params);

    expect(mocks.configure).toHaveBeenCalledWith(openKeyedStore);
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
    mocks.authorize.mockResolvedValue([]);
    const request = {
      ...params,
      requesterSessionKey: "agent:main:voice:15550001234",
      sandboxed: false,
      hits,
    };
    await expect(memoryRuntime.authorizeSearchHits(request)).resolves.toEqual([]);
    expect(mocks.authorize).toHaveBeenCalledWith(request);
  });
});
