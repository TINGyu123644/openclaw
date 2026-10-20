import { afterEach, describe, expect, it, vi } from "vitest";
import "./server-context.chrome-test-harness.js";
import * as cdpHelpers from "./cdp.helpers.js";
import { launchOpenClawChrome, isChromeReachable, isChromeCdpReady } from "./chrome.js";
import type { RunningChrome } from "./chrome.js";
import { fetchBrowserJson } from "./client-fetch.js";
import { createBrowserRouteContext } from "./server-context.js";
import { makeBrowserServerState, mockLaunchedChrome } from "./server-context.test-harness.js";

const service = vi.hoisted(() => ({
  context: vi.fn(),
  start: vi.fn(),
  state: vi.fn(),
  readTabs: vi.fn(),
}));
const startBrowser = (signal?: AbortSignal) =>
  fetchBrowserJson("/start", { method: "POST", timeoutMs: 20_000, signal });
const readTabs = () => fetchBrowserJson("/tabs", { timeoutMs: 20_000 });
const started = { ok: true, profile: "openclaw" };
// mock-isolation: keep the service in memory; real startup installs host relays and credentials.
vi.mock("../control-service.js", () => ({
  createBrowserControlContext: service.context,
  startBrowserControlServiceFromConfig: service.start,
  getBrowserControlState: service.state,
  stopBrowserControlService: vi.fn(async () => {}),
}));

function setup() {
  vi.useFakeTimers();
  const state = makeBrowserServerState();
  const context = createBrowserRouteContext({ getState: () => state });
  service.context.mockReturnValue(context);
  service.start.mockResolvedValue(state);
  service.state.mockReturnValue(state);
  service.readTabs.mockResolvedValue([]);
  vi.spyOn(cdpHelpers, "fetchJson").mockImplementation(service.readTabs);
  const entered = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<RunningChrome>();
  const running = mockLaunchedChrome(vi.mocked(launchOpenClawChrome), 1200);
  vi.mocked(isChromeReachable).mockResolvedValue(false);
  vi.mocked(isChromeCdpReady).mockResolvedValue(true);
  vi.mocked(launchOpenClawChrome).mockImplementation(async () => {
    entered.resolve();
    return await ready.promise;
  });
  const finishStartup = async () => {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(31_000);
    ready.resolve(running);
  };
  const expectRunning = () => {
    expect(state.profiles.get("openclaw")?.running).toBe(running);
    expect(launchOpenClawChrome).toHaveBeenCalledOnce();
  };
  return { state, entered, finishStartup, expectRunning };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("browser control cold start", () => {
  it("waits beyond the action budget for startup and reuses the browser", async () => {
    const { entered, finishStartup, expectRunning } = setup();
    const result = startBrowser().catch((error: unknown) => error);
    await entered.promise;
    const tabs = readTabs().catch((error: unknown) => error);
    await finishStartup();
    expect(await result).toEqual(started);
    expect(await tabs).toEqual({ running: true, tabs: [], canAutoResizeViewport: true });
    await expect(startBrowser()).resolves.toEqual(started);
    expectRunning();
  });

  it("abandons an expired caller without cancelling the shared launch", async () => {
    const { entered, finishStartup, expectRunning } = setup();
    const caller = new AbortController();
    const cancelled = expect(startBrowser(caller.signal)).rejects.toThrow(
      "caller deadline expired",
    );
    await entered.promise;
    setTimeout(() => caller.abort(new Error("caller deadline expired")), 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await cancelled;
    const next = startBrowser();
    await finishStartup();
    await expect(next).resolves.toEqual(started);
    expectRunning();
  });

  it("enforces the action deadline after startup completes", async () => {
    const { finishStartup } = setup();
    const start = startBrowser();
    await finishStartup();
    await start;
    const reading = Promise.withResolvers<void>();
    const tabList = Promise.withResolvers<[]>();
    service.readTabs.mockImplementationOnce(() => {
      reading.resolve();
      return tabList.promise;
    });
    const expired = expect(readTabs()).rejects.toThrow("timed out");
    await reading.promise;
    await vi.advanceTimersByTimeAsync(20_000);
    tabList.resolve([]);
    await expired;
  });

  it("bounds a stuck launch with the service startup deadline", async () => {
    const { entered, state } = setup();
    vi.mocked(launchOpenClawChrome).mockImplementationOnce(async (_resolved, _profile, options) => {
      const signal = options?.signal;
      if (!signal) {
        throw new Error("expected lifecycle-owned launch signal");
      }
      entered.resolve();
      return await new Promise<RunningChrome>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const reason: unknown = signal.reason;
            reject(reason instanceof Error ? reason : new Error("Browser startup aborted"));
          },
          { once: true },
        );
      });
    });
    const expired = expect(startBrowser()).rejects.toThrow(
      'Browser startup for profile "openclaw" did not finish within 120000ms',
    );
    await entered.promise;
    await vi.advanceTimersByTimeAsync(120_000);
    await expired;
    expect(state.profiles.get("openclaw")?.running).toBeNull();
  });
});
