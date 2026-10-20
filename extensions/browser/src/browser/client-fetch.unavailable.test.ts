import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import "../test-support/browser-security.mock.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn<() => OpenClawConfig>(() => ({})),
  sourceConfig: null as OpenClawConfig | null,
  pluginRecord: undefined as
    | {
        id: string;
        status: "disabled" | "error" | "loaded";
        activationReason?: string;
        error?: string;
        failurePhase?: "validation" | "load" | "register";
      }
    | undefined,
  startBrowserControlServiceFromConfig: vi.fn<() => Promise<null>>(async () => null),
  dispatch: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: mocks.loadConfig,
  getRuntimeConfigSourceSnapshot: () => mocks.sourceConfig,
}));
vi.mock("../control-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../control-service.js")>()),
  createBrowserControlContext: vi.fn(() => ({})),
  startBrowserControlServiceFromConfig: mocks.startBrowserControlServiceFromConfig,
}));
vi.mock("./routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: () => ({ dispatch: mocks.dispatch }),
}));
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => ({
    pluginRegistry: { plugins: mocks.pluginRecord ? [mocks.pluginRecord] : [] },
  }),
}));

const { fetchBrowserJson } = await import("./client-fetch.js");

async function expectThrownBrowserFetchError(
  contains: string[],
  omits = ["Restart", "not installed", "not yet loaded"],
) {
  const result = await fetchBrowserJson("/tabs").catch((error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  if (!(result instanceof Error)) {
    throw new Error("Expected browser control refusal");
  }
  for (const text of contains) {
    expect(result.message).toContain(text);
  }
  for (const text of omits) {
    expect(result.message).not.toContain(text);
  }
}

describe("browser control availability diagnostics", () => {
  beforeEach(() => {
    mocks.loadConfig.mockReset().mockReturnValue({});
    mocks.sourceConfig = null;
    mocks.pluginRecord = undefined;
    mocks.startBrowserControlServiceFromConfig.mockReset().mockResolvedValue(null);
    mocks.dispatch.mockReset();
  });

  it.each([
    [
      "global plugin disablement",
      { plugins: { enabled: false } },
      ["plugins.enabled=false", "plugins.enabled=true", "openclaw plugins enable browser"],
    ],
    [
      "plugin denylist",
      { plugins: { deny: ["browser"] } },
      ["plugins.deny", "Remove", "openclaw plugins enable browser"],
    ],
    [
      "explicit plugin disablement",
      { plugins: { entries: { browser: { enabled: false } } } },
      ["plugins.entries.browser.enabled=false", "openclaw plugins enable browser"],
    ],
    [
      "browser config disablement",
      { browser: { enabled: false } },
      ["browser.enabled=false", "browser.enabled=true"],
    ],
    ["unrecorded availability", {}, ["openclaw doctor"]],
  ] satisfies [string, OpenClawConfig, string[]][])(
    "explains %s at the local dispatch boundary",
    async (_name, config, contains) => {
      mocks.loadConfig.mockReturnValue(config);

      await expectThrownBrowserFetchError(contains);
      expect(mocks.dispatch).not.toHaveBeenCalled();
    },
  );

  it("explains the source policy that refused startup despite runtime auto-enable", async () => {
    mocks.loadConfig.mockReturnValue({ plugins: { allow: ["browser"] } });
    mocks.sourceConfig = { plugins: { allow: ["telegram"] } };

    await expectThrownBrowserFetchError([
      '"browser" is not in plugins.allow',
      "Add",
      "openclaw plugins enable browser",
    ]);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { status: "error", failurePhase: "register", error: "registration timed out" },
    { status: "error", error: "plugin not installed: browser" },
    { status: "disabled", activationReason: "capability consent required" },
  ] as const)("preserves recorded $status refusal details", async (record) => {
    mocks.pluginRecord = { id: "browser", ...record };

    await expectThrownBrowserFetchError(
      [
        record.status === "error" ? record.error : record.activationReason,
        "openclaw doctor",
        "Do NOT retry the browser tool",
      ],
      ["Restart", "Retry the browser tool once"],
    );
  });
});
