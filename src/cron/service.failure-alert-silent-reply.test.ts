import { beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveConfiguredModelRefMock,
  resolveCronPayloadOutcomeMock,
  runEmbeddedAgentMock,
} from "./isolated-agent/run.test-harness.js";
import { cronTestDeps, cronTestInput } from "./service.fixture-builders.test-support.js";
import { CronService } from "./service.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("CronService silent failure alerts", { concurrent: false }, () => {
  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
  });

  it("persists a tool failure and emits the configured operator alert", async () => {
    const { resolveCronPayloadOutcome } = await vi.importActual<
      typeof import("./isolated-agent/helpers.js")
    >("./isolated-agent/helpers.js");
    resolveCronPayloadOutcomeMock.mockImplementation(resolveCronPayloadOutcome);
    const modelRef = { provider: "openai", model: "gpt-5.4" };
    resolveConfiguredModelRefMock.mockReturnValue(modelRef);
    mockRunCronFallbackPassthrough();
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "⚠️ 🛠️ Bash failed: mount unavailable", isError: true }],
      meta: { agentMeta: {}, finalAssistantVisibleText: "NO_REPLY" },
    });

    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-silent-failure-" },
      async (state) => {
        const cfg = {
          session: { store: "/tmp/store.json" },
          agents: { defaults: { model: `${modelRef.provider}/${modelRef.model}` } },
        };
        setRuntimeConfigSnapshot(cfg);
        const sendCronFailureAlert = vi.fn<NonNullable<CronServiceDeps["sendCronFailureAlert"]>>(
          async () => undefined,
        );
        const storePath = state.path("cron", "jobs.json");
        const cron = new CronService({
          ...cronTestDeps({ storePath }),
          cronConfig: {
            triggers: { enabled: true },
            failureAlert: { enabled: true, after: 1, cooldownMs: 0 },
          },
          sendCronFailureAlert,
          runIsolatedAgentJob: async (runParams) =>
            await runCronIsolatedAgentTurn({
              ...runParams,
              cfg,
              deps: {},
              sessionKey: `cron:${runParams.job.id}`,
            }),
        });
        try {
          await cron.start();
          const job = await cron.add({
            ...cronTestInput(),
            name: "mount check",
            payload: {
              kind: "agentTurn",
              message: "check mount",
              model: `${modelRef.provider}/${modelRef.model}`,
            },
            delivery: { mode: "none" },
          });

          await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

          const persisted = (await loadCronStore(storePath)).jobs.find(
            (candidate) => candidate.id === job.id,
          );
          expect(persisted?.state).toMatchObject({
            lastRunStatus: "error",
            lastError: expect.stringContaining("Bash failed"),
            consecutiveErrors: 1,
          });
          expect(persisted?.state.lastFailureAlertAtMs).toBeDefined();
          expect(sendCronFailureAlert).toHaveBeenCalledOnce();
          expect(sendCronFailureAlert.mock.calls[0]?.[0].payload.text).toContain(
            'Automation "mount check" failed 1 times',
          );
        } finally {
          cron.stop();
        }
      },
    );
  });
});
