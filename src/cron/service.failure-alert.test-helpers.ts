import { expect, vi } from "vitest";
import { cronTestDeps, cronTestInput } from "./service.fixture-builders.test-support.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronJobCreate } from "./types.js";

type CronServiceParams = ConstructorParameters<typeof CronService>[0];
type RunIsolatedAgentJob = NonNullable<CronServiceParams["runIsolatedAgentJob"]>;
type IsolatedAgentRunResult = Awaited<ReturnType<RunIsolatedAgentJob>>;
type FailureAlertConfig = NonNullable<CronServiceParams["cronConfig"]>["failureAlert"];
type SendCronFailureAlert = NonNullable<CronServiceParams["sendCronFailureAlert"]>;
type RunCronFailureRepair = NonNullable<CronServiceParams["runCronFailureRepair"]>;
type RunScriptJob = NonNullable<CronServiceParams["runScriptJob"]>;

export function createTelegramDelivery(): NonNullable<CronJobCreate["delivery"]> {
  return { mode: "announce", channel: "telegram", to: "19098680" };
}

type FailureAlertParams = {
  scheduler: CronServiceParams["scheduler"];
  failureAlert?: FailureAlertConfig;
  runResult?: IsolatedAgentRunResult;
  useFallback?: boolean;
};

export function setupFailureAlertSuite() {
  const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
    prefix: "openclaw-cron-failure-alert-",
    baseTimeIso: "2026-01-01T00:00:00.000Z",
  });

  async function createFixture(params: FailureAlertParams) {
    const store = await makeStorePath();
    const runResult = params.runResult ?? {
      status: "error",
      error: "temporary upstream error",
    };
    const mocks = {
      sendCronFailureAlert: vi.fn<SendCronFailureAlert>(async () => undefined),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runCronFailureRepair: vi.fn<RunCronFailureRepair>(async () => undefined),
      runIsolatedAgentJob: vi.fn<RunIsolatedAgentJob>(async () => runResult),
      runScriptJob: vi.fn<RunScriptJob>(async () => runResult),
    };
    const { sendCronFailureAlert, ...deps } = mocks;
    const cron = new CronService({
      ...cronTestDeps({ storePath: store.storePath }),
      scheduler: params.scheduler,
      ...(params.failureAlert === undefined
        ? {}
        : { cronConfig: { failureAlert: params.failureAlert } }),
      log: noopLogger,
      ...deps,
      ...(params.useFallback ? {} : { sendCronFailureAlert }),
    });
    return {
      cron,
      ...mocks,
      addJob: (name: string, overrides?: Partial<CronJobCreate>) =>
        cron.add({
          ...cronTestInput(),
          name,
          payload: { kind: "agentTurn", message: "run report" },
          ...overrides,
        }),
    };
  }

  async function withFailureAlertCron(
    params: FailureAlertParams,
    run: (context: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  ): Promise<void> {
    const fixture = await createFixture(params);
    await fixture.cron.start();
    try {
      await run(fixture);
    } finally {
      fixture.cron.stop();
    }
  }

  return { withFailureAlertCron };
}

export function alertCallArg(
  sendCronFailureAlert: ReturnType<typeof vi.fn<SendCronFailureAlert>>,
  callIndex = sendCronFailureAlert.mock.calls.length - 1,
) {
  const alert = sendCronFailureAlert.mock.calls[callIndex]?.[0];
  if (!alert) {
    throw new Error(`expected failure alert call ${callIndex}`);
  }
  return { ...alert, ...alert.payload };
}

export function expectAlertFields(
  sendCronFailureAlert: ReturnType<typeof vi.fn<SendCronFailureAlert>>,
  expected: Record<string, unknown>,
  callIndex?: number,
) {
  const alert = alertCallArg(sendCronFailureAlert, callIndex);
  expect(alert).toEqual(expect.objectContaining(expected));
  return alert;
}

export function expectAlertTextContaining(
  sendCronFailureAlert: ReturnType<typeof vi.fn<SendCronFailureAlert>>,
  text: string,
  callIndex?: number,
): void {
  const alert = alertCallArg(sendCronFailureAlert, callIndex);
  expect(alert.text).toEqual(expect.stringContaining(text));
}
