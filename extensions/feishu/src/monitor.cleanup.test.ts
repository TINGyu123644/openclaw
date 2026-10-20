import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { cleanupFeishuMonitorStateForTests } from "./monitor.cleanup.test-helpers.js";
import { botOpenIds } from "./monitor.state.js";
import { monitorWebSocket } from "./monitor.transport.js";
import type { ResolvedFeishuAccount } from "./types.js";

const createFeishuWSClientMock = vi.hoisted(() => vi.fn());
vi.mock("./client.js", () => ({ createFeishuWSClient: createFeishuWSClientMock }));

function createWsClient() {
  return { start: vi.fn(), close: vi.fn() };
}
async function startMonitor(accountId: string, ...clients: ReturnType<typeof createWsClient>[]) {
  for (const client of clients) {
    createFeishuWSClientMock.mockResolvedValueOnce(client);
  }
  const abortController = new AbortController();
  const runtime = createRuntimeSpies();
  botOpenIds.set(accountId, "ou_bot");
  const monitor = monitorWebSocket({
    account: {
      accountId,
      enabled: true,
      configured: true,
      appId: `cli_${accountId}`,
      appSecret: `secret_${accountId}`, // pragma: allowlist secret
      domain: "feishu",
      config: { enabled: true, connectionMode: "websocket" },
    } as ResolvedFeishuAccount,
    accountId,
    runtime,
    abortSignal: abortController.signal,
    eventDispatcher: {} as never,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(clients[0]?.start).toHaveBeenCalledTimes(1);
  return {
    runtime,
    async stop() {
      abortController.abort();
      await monitor;
      expect(botOpenIds.has(accountId)).toBe(false);
      expect(createFeishuWSClientMock).toHaveBeenCalledTimes(clients.length);
      for (const client of clients) {
        expect(client.close).toHaveBeenCalledTimes(1);
      }
    },
    async reportError(message: string) {
      const callbacks = createFeishuWSClientMock.mock.calls[0]?.[1];
      if (!callbacks || typeof callbacks !== "object") {
        throw new Error("expected Feishu websocket callbacks");
      }
      (callbacks as { onError?: (error: Error) => void }).onError?.(new Error(message));
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}
function errorMessage(runtime: ReturnType<typeof createRuntimeSpies>, ...fragments: string[]) {
  const message = String(runtime.error.mock.calls[0]?.[0] ?? "");
  expect(message).not.toContain("\n");
  expect(message).not.toContain("token_abc");
  for (const fragment of fragments) {
    expect(message).toContain(fragment);
  }
  return message;
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  vi.useRealTimers();
  await cleanupFeishuMonitorStateForTests();
  vi.clearAllMocks();
});
afterAll(() => {
  vi.doUnmock("./client.js");
  vi.resetModules();
});

describe("feishu websocket cleanup", () => {
  it.each(["start rejection", "SDK exhaustion"])("retries after %s", async (failure) => {
    const failed = createWsClient();
    const startRejected = failure === "start rejection";
    if (startRejected) {
      failed.start.mockRejectedValueOnce(
        new Error("connect failed\nAuthorization: Bearer token_abc appSecret=secret_abc"),
      );
    }
    const recovered = createWsClient();
    const monitor = await startMonitor("retry", failed, recovered);
    if (!startRejected) {
      await monitor.reportError("WebSocket reconnect exhausted after 3 attempts\nBearer token_abc");
      expect(botOpenIds.get("retry")).toBe("ou_bot");
    }
    expect(failed.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recovered.start).toHaveBeenCalledTimes(1);
    await monitor.stop();
    expect(monitor.runtime.error).toHaveBeenCalledTimes(1);
    const message = errorMessage(
      monitor.runtime,
      startRejected
        ? "WebSocket start failed, retrying in 1000ms"
        : "WebSocket connection ended, recreating client in 1000ms",
      "Bearer [redacted]",
    );
    if (startRejected) {
      expect(message).toContain("Authorization: Bearer [redacted]");
      expect(message).toContain("appSecret=[redacted]");
      expect(message).not.toContain("secret_abc");
    }
  });

  it("keeps the websocket client alive after recoverable sdk callback errors", async () => {
    const client = createWsClient();
    const monitor = await startMonitor("recoverable", client);
    await monitor.reportError("temporary callback failure\nBearer token_abc");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(createFeishuWSClientMock).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
    errorMessage(monitor.runtime, "WebSocket SDK reported recoverable error", "Bearer [redacted]");
    await monitor.stop();
  });

  it("clears identity without recreating a websocket when aborted during reconnect backoff", async () => {
    const client = createWsClient();
    const monitor = await startMonitor("abort-backoff", client);
    await monitor.reportError("WebSocket reconnect exhausted after 3 attempts");
    expect(client.close).toHaveBeenCalledTimes(1);
    await monitor.stop();
  });

  it("redacts close errors and truncates them without splitting surrogate pairs", async () => {
    const prefix = "access_token=[redacted] ";
    const padding = "x".repeat(499 - prefix.length);
    const client = createWsClient();
    client.close.mockImplementationOnce(() => {
      throw new Error(`access_token=secret_token\n${padding}😀tail`);
    });
    const monitor = await startMonitor("close-error", client);
    await monitor.stop();
    const message = errorMessage(monitor.runtime);
    expect(message).toBe(
      `feishu[close-error]: error closing WebSocket client: ${prefix}${padding}...`,
    );
    expect(message).not.toContain("secret_token");
  });
});
