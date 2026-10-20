import { expect, it, vi } from "vitest";
import { findSourceImportBackedges } from "../../../test/helpers/source-import-closure.js";
import type { SessionTranscriptWorkerRequest } from "./session-transcript-worker.types.js";

function expectIndependent(...args: Parameters<typeof findSourceImportBackedges>) {
  expect(findSourceImportBackedges(...args)).toEqual([]);
}

it("keeps history worker transport independent of host config loading", () => {
  expectIndependent("src/config/sessions/session-transcript-worker-runtime.ts", [
    "src/config/io.ts",
    "src/config/io.runtime.ts",
  ]);
});

it("keeps transcript title and topology workers independent of host config loading", () => {
  expectIndependent(
    [
      "src/gateway/session-transcript-title-reader.worker.ts",
      "src/config/sessions/combined-store-topology.worker.ts",
    ],
    ["src/config/io.ts", "src/config/io.runtime.ts", "src/config/sessions/session-accessor.ts"],
  );
});

const readOwners = [
  "src/config/sessions/session-transcript.worker.ts",
  "src/config/sessions/session-accessor.sqlite-branches.ts",
  "src/gateway/session-history-readonly-reader.ts",
  "src/gateway/session-transcript-preview-reader.ts",
  "src/gateway/server-methods/chat-history-page-kernel.ts",
  "src/gateway/session-history-snapshot.ts",
];

it("keeps history readers independent of host acquisition and decoration", () => {
  expectIndependent(readOwners, [
    "src/config/sessions/session-accessor.sqlite-scope.ts",
    "src/config/sessions/session-accessor.sqlite-active-projection.ts",
    "src/config/sessions/session-accessor.sqlite-delta.ts",
    "src/config/sessions/session-accessor.sqlite-history-events.ts",
    "src/config/sessions/session-transcript-reconcile.ts",
    "src/state/openclaw-agent-db.ts",
    "src/state/openclaw-agent-db-lifecycle.ts",
    "src/state/openclaw-agent-db-readonly.ts",
    "src/state/openclaw-state-db.ts",
    "src/gateway/current-user-profile-display.ts",
    "src/gateway/session-transcript-message.ts",
    "src/gateway/session-utils.fs.ts",
  ]);
});

it("keeps lazy readers independent of unrelated runtime barrels", () => {
  expectIndependent("src/gateway/session-history-worker-reader.ts", [
    "src/gateway/session-utils-store-sources.ts",
    "src/config/sessions/session-store-target-inventory.ts",
    "src/config/runtime-source-projection.ts",
  ]);
  expectIndependent(
    [
      "src/gateway/session-history-worker-reader.ts",
      "src/config/sessions/session-store-target-inventory.ts",
      "src/config/sessions/session-entry-read.worker.ts",
      "src/config/sessions/session-accessor.sqlite-model-context.ts",
    ],
    [
      "src/config/sessions/lifecycle.ts",
      "src/config/sessions/session-accessor.ts",
      "src/config/sessions/session-accessor.sqlite-entry-store.ts",
      "src/config/sessions/session-accessor.sqlite-read.ts",
      "src/config/sessions/session-accessor.sqlite-exact-read.ts",
      "packages/ai/src/transports.ts",
      "packages/ai/src/internal/default-runtime.ts",
      "packages/gateway-protocol/src/schema/users.ts",
    ],
  );
  expectIndependent("src/infra/session-cost-usage-worker.ts", [
    "src/config/io.ts",
    "src/config/io.runtime.ts",
    "src/config/sessions/session-accessor.ts",
    "packages/ai/src/transports.ts",
  ]);
});

const prewarm = vi.hoisted(() => ({
  read: vi.fn<(input: SessionTranscriptWorkerRequest) => Promise<unknown>>(),
  historyReader: vi.fn(() => ({})),
  historyPage: vi.fn(() => ({})),
  responsePage: vi.fn(() => ({})),
  historySnapshot: vi.fn(() => ({})),
}));

// mock-isolation: Observe lazy evaluation without loading the presentation graph being excluded.
vi.mock("../../gateway/session-history-worker-reader.js", () => prewarm.historyReader());
// mock-isolation: Observe lazy evaluation without loading the presentation graph being excluded.
vi.mock("../../gateway/server-methods/chat-history-page-kernel.js", () => prewarm.historyPage());
// mock-isolation: Observe lazy evaluation without loading the presentation graph being excluded.
vi.mock("../../gateway/server-methods/chat-history-response-page.js", () => prewarm.responsePage());
// mock-isolation: Observe lazy evaluation without loading the presentation graph being excluded.
vi.mock("../../gateway/session-history-snapshot.js", () => prewarm.historySnapshot());
// mock-isolation: Capture dispatch without installing native worker ports in the test process.
vi.mock("../../infra/worker-task-server.js", () => ({
  serveOwnedWorkerTasks(handler: (input: SessionTranscriptWorkerRequest) => Promise<unknown>) {
    prewarm.read.mockImplementation(handler);
  },
}));

it("prewarms maintenance without evaluating the foreground history presentation graph", async () => {
  await import("./session-transcript.worker.js");
  // Missing stores are allowed by startup prewarm; native admission/reuse has separate real-DB proof.
  const request = {
    kind: "prewarm" as const,
    database: { agentId: "main", path: "/synthetic/missing/openclaw-agent.sqlite" },
    env: {},
  };
  const modules = [
    prewarm.historyReader,
    prewarm.historyPage,
    prewarm.responsePage,
    prewarm.historySnapshot,
  ];
  for (const history of [false, true]) {
    await expect(prewarm.read({ ...request, history })).resolves.toMatchObject({
      ok: true,
      value: { kind: "prewarm" },
    });
    for (const loaded of modules) {
      expect(loaded).toHaveBeenCalledTimes(Number(history));
    }
  }
});
