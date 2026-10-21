import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewaySchedulerClock } from "../infra/gateway-scheduler.js";
import { createGatewaySchedulerClock } from "../test-utils/gateway-scheduler-clock.js";
import { getFreePort } from "../test-utils/ports.js";
import type { GatewayServer } from "./server-public.js";
import * as fixture from "./server-startup-state.test-support.js";

const schedulerClock = vi.hoisted(() => ({
  current: undefined as GatewaySchedulerClock | undefined,
}));

vi.mock("../infra/gateway-scheduler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/gateway-scheduler.js")>();
  return {
    ...actual,
    GatewayScheduler: class extends actual.GatewayScheduler {
      constructor(options: ConstructorParameters<typeof actual.GatewayScheduler>[0] = {}) {
        super({ ...options, clock: schedulerClock.current ?? options.clock });
      }
    },
  };
});

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const postgresConnection = typeof configured === "string" ? configured : undefined;

for (const engine of ["sqlite", "postgres"] as const) {
  it.skipIf(engine === "postgres" && !postgresConnection)(
    `prepares only the PostgreSQL recovery reader before readiness and joins close (${engine})`,
    async () => {
      const state = await fixture.createGatewayStartupTestState("gateway-recovery-reader", {
        OPENCLAW_RECOVERY_TEST_CONNECTION: engine === "postgres" ? postgresConnection : undefined,
      });
      state.envVars.OPENCLAW_TEST_MINIMAL_GATEWAY = undefined;
      const clock = createGatewaySchedulerClock();
      schedulerClock.current = clock.clock;
      const port = await getFreePort();
      const token = "gateway-recovery-reader-token";
      const prepared = createDeferred();
      const readers = await import("../config/sessions/session-transcript-worker-runtime.js");
      const { maintenanceLane } =
        await import("../config/sessions/session-transcript-worker-resources.js");
      const prewarm = vi
        .spyOn(readers, "prewarmSessionHistoryWorker")
        .mockReturnValue(prepared.promise);
      const postAttach = await import("./server-startup-post-attach.js");
      const startPostAttach = postAttach.startGatewayPostAttachRuntime;
      let prewarmsBeforeReady = 0;
      const sidecars = vi
        .spyOn(postAttach, "startGatewayPostAttachRuntime")
        .mockImplementation((params) =>
          startPostAttach({
            ...params,
            onSidecarsReady: () => {
              prewarmsBeforeReady = prewarm.mock.calls.filter(
                ([database, lane]) => database.agentId === "main" && lane === maintenanceLane,
              ).length;
              params.onSidecarsReady?.();
            },
          }),
        );
      const prefix = `gate_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      const client =
        engine === "postgres" ? new Client({ connectionString: postgresConnection }) : undefined;
      let server: GatewayServer | undefined;
      let close: Promise<void> | undefined;
      try {
        await client?.connect();
        await state.writeConfig({
          ...(engine === "postgres"
            ? {
                database: {
                  engine: "sqlite",
                  families: { agent: { engine: "postgres" } },
                  postgres: {
                    connection: {
                      source: "env",
                      provider: "default",
                      id: "OPENCLAW_RECOVERY_TEST_CONNECTION",
                    },
                    schemaPrefix: prefix,
                  },
                },
              }
            : {}),
          gateway: fixture.gatewayStartupTestConfig(port, token),
          plugins: { enabled: false },
          discovery: { mdns: { mode: "off" } },
        });
        state.applyEnv();
        // Resolve the configured engine before the fixture creates its auth-profile store.
        const { installGatewayDatabaseEngine } = await import("./server-database-engine.js");
        await installGatewayDatabaseEngine();
        await state.writeAuthProfiles({ version: 1, profiles: {} });
        const { startGatewayServerCore } = await import("./server-start.js");
        server = await startGatewayServerCore(port, fixture.gatewayStartupTestOptions(token));
        await server.startupSettled;
        expect(prewarmsBeforeReady).toBe(engine === "postgres" ? 1 : 0);
        expect(prewarm).toHaveBeenCalledTimes(engine === "postgres" ? 1 : 0);
        expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
        let closed = false;
        close = server.close().then(() => {
          closed = true;
        });
        if (engine === "postgres") {
          await nextTurn();
          expect(closed).toBe(false);
        }
        prepared.resolve();
        await close;
      } finally {
        prepared.resolve();
        await close;
        await server?.close();
        sidecars.mockRestore();
        prewarm.mockRestore();
        schedulerClock.current = undefined;
        await state.cleanup();
        const { resetDatabaseEngineSelectionForTest } =
          await import("../infra/database-engine/context.test-support.js");
        resetDatabaseEngineSelectionForTest();
        if (client) {
          try {
            const schemas = await client.query<{ schema_name: string }>(
              "SELECT schema_name FROM information_schema.schemata WHERE starts_with(schema_name, $1)",
              [`${prefix}_`],
            );
            for (const { schema_name } of schemas.rows) {
              await client.query(`DROP SCHEMA "${schema_name.replaceAll('"', '""')}" CASCADE`);
            }
          } finally {
            await client.end();
          }
        }
      }
    },
  );
}

it.each(["settles", "closes", "repair-closes"] as const)(
  "holds post-ready maintenance until deferred startup %s",
  async (outcome) => {
    const clock = createGatewaySchedulerClock();
    schedulerClock.current = clock.clock;
    const port = await getFreePort();
    const state = await fixture.createGatewayStartupTestState(`gateway-post-ready-${outcome}`, {
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
    });
    state.envVars.OPENCLAW_TEST_MINIMAL_GATEWAY = undefined;
    const startup = createDeferred();
    const repairRelease = createDeferred();
    const resumed = vi.fn<(closing: boolean) => void>();
    const startMaintenance = vi.fn(async () => null);
    let server: GatewayServer | undefined;
    let realStartup: Promise<void> | undefined;
    let postReadyWork: Promise<void> | undefined;
    let closeOutcome: Promise<void> | undefined;
    let beforeReadyWake: void | Promise<void> = undefined;
    let repairWake: void | Promise<void> = undefined;
    const plugins = await import("./server-startup-plugins.js");
    const optionalRepair = vi
      .spyOn(plugins, "runGatewayPostReadyStartupMaintenance")
      .mockImplementation(async () => {
        await repairRelease.promise;
        throw new Error("synthetic optional repair failure");
      });
    const earlyModule = await import("./server-startup-early.js");
    const startEarlyRuntime = earlyModule.startGatewayEarlyRuntime;
    vi.spyOn(earlyModule, "startGatewayEarlyRuntime").mockImplementation(async (...args) => ({
      ...(await startEarlyRuntime(...args)),
      startMaintenance,
    }));
    const startupModule = await import("./server-startup-finish.js");
    const finishStartup = startupModule.finishGatewayStartup;
    vi.spyOn(startupModule, "finishGatewayStartup").mockImplementation(async (params) => {
      const result = await finishStartup(params);
      realStartup = result.startupSettled;
      const owner = params.kernelRuntime;
      postReadyWork = owner.connectionWork.track(() =>
        params.waitForPostReadyWork().then(() => resumed(owner.lifecycle.closePreludeStarted)),
      );
      const startupSettled = owner.connectionWork.track(async () => {
        await result.startupSettled;
        await startup.promise;
      });
      return { ...result, startupSettled };
    });
    try {
      const token = "gateway-post-ready-maintenance-token";
      await state.writeConfig({
        gateway: fixture.gatewayStartupTestConfig(port, token),
        plugins: { enabled: false },
        discovery: { mdns: { mode: "off" } },
      });
      state.applyEnv();
      const { startGatewayServerCore } = await import("./server-start.js");
      server = await startGatewayServerCore(port, fixture.gatewayStartupTestOptions(token));
      await realStartup;
      // Let both production grace periods elapse while published startup is pending.
      beforeReadyWake = clock.advanceBy(600);
      expect(startMaintenance).not.toHaveBeenCalled();
      expect(resumed).not.toHaveBeenCalled();

      if (outcome === "closes") {
        closeOutcome = server.close();
        await postReadyWork;
        expect(resumed).toHaveBeenCalledExactlyOnceWith(true);
        startup.resolve();
        await server.startupSettled;
        expect(clock.armedAtMs).toBeNull();
        await closeOutcome;
        await beforeReadyWake;
        expect(startMaintenance).not.toHaveBeenCalled();
      } else {
        startup.resolve();
        await server.startupSettled;
        await clock.advanceBy(499);
        expect(resumed).not.toHaveBeenCalled();
        repairWake = clock.advanceBy(1);
        await postReadyWork;
        await beforeReadyWake;
        expect(startMaintenance).toHaveBeenCalledOnce();
        await vi.waitFor(
          () => {
            repairWake = clock.advanceBy(1_000) ?? repairWake;
            expect(optionalRepair).toHaveBeenCalledOnce();
          },
          { timeout: 10_000, interval: 10 },
        );
        expect(resumed).toHaveBeenCalledExactlyOnceWith(false);
        const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
        expect(readiness.status).toBe(200);
        if (outcome === "repair-closes") {
          let closed = false;
          closeOutcome = server.close().then(() => {
            closed = true;
          });
          await Promise.resolve();
          expect(closed).toBe(false);
        }
        repairRelease.resolve();
        await repairWake;
        await closeOutcome;
        if (outcome === "settles") {
          // Failed optional repair must not suppress the periodic maintenance owner.
          expect(startMaintenance).toHaveBeenCalledOnce();
        }
      }
    } finally {
      startup.resolve();
      repairRelease.resolve();
      try {
        await closeOutcome;
        await server?.close();
        await postReadyWork;
        await beforeReadyWake;
        await repairWake;
        await state.cleanup();
      } finally {
        schedulerClock.current = undefined;
        vi.restoreAllMocks();
      }
    }
  },
);
