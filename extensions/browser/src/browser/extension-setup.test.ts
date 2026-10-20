import { beforeEach, expect, it, vi } from "vitest";
import type { BrowserExtensionStatus } from "./extension-install.js";
import { runBrowserExtensionSetup } from "./extension-setup.js";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  install: vi.fn(),
  readToken: vi.fn(),
  connect: vi.fn(),
  status: vi.fn(),
  close: vi.fn(),
}));
vi.mock("./extension-install.js", () => ({
  browserExtensionStatus: mocks.inspect,
  installChromeExtensionBootstrap: mocks.install,
}));
vi.mock("./extension-relay/relay-auth.js", () => ({ readExtensionRelayToken: mocks.readToken }));
vi.mock("./extension-relay/owner-client.js", () => ({
  RelayOwnerClient: { connect: mocks.connect },
}));

function registration(overrides: Partial<BrowserExtensionStatus["registrations"][number]> = {}) {
  return {
    product: "chrome" as const,
    browser: "Chrome",
    manifestPath: "/private/manifest",
    extensionIds: [],
    state: "owned" as const,
    ...overrides,
  };
}
function installation(overrides: Partial<BrowserExtensionStatus> = {}): BrowserExtensionStatus {
  return {
    platform: "linux",
    platformSupport: "automatic",
    installedCopy: { path: "/private/copy", present: true, owned: true },
    bundledPath: "/private/bundle",
    approvedPaths: [],
    discovered: [],
    storeDiscovered: [],
    storeInstallRequests: [],
    registrations: [registration()],
    manualSetupRequired: true,
    issues: [],
    ...overrides,
  };
}
const options = { bundledDir: "/bundle", pluginRoot: "/plugin", cfg: {} };
const setup = (
  action: "install" | "inspect" | "verify",
  overrides: Partial<Parameters<typeof runBrowserExtensionSetup>[0]> = {},
) => runBrowserExtensionSetup({ ...options, action, ...overrides });
const approval = { product: "chrome" as const, enabled: false, awaitingApproval: true };
function expectRedacted(result: unknown, ...secrets: string[]) {
  for (const secret of ["synthetic-private-relay-key", ...secrets]) {
    expect(JSON.stringify(result)).not.toContain(secret);
  }
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspect.mockResolvedValue(installation());
  mocks.install.mockResolvedValue(installation());
  mocks.readToken.mockReturnValue("synthetic-private-relay-key");
  mocks.connect.mockResolvedValue({ status: mocks.status, close: mocks.close });
  mocks.status.mockResolvedValue({ ready: true, identity: { extensionVersion: "2.3.0" } });
  mocks.close.mockResolvedValue(undefined);
});

it("does not replace an unavailable saved profile or choose between conflicting registrations", async () => {
  const saved = installation({ registrations: [registration({ browserProfile: "work" })] });
  mocks.inspect.mockResolvedValue(saved);
  await expect(setup("install")).rejects.toThrow("existing extension browser profile");
  saved.registrations.push(registration({ product: "chromium", browserProfile: "other" }));
  await expect(setup("install")).rejects.toThrow("registrations disagree");
  expect(mocks.install).not.toHaveBeenCalled();
  await setup("install", { profile: "chrome" });
  expect(mocks.install).toHaveBeenCalledWith(expect.objectContaining({ browserProfile: "chrome" }));
});

it("keeps actual Chrome approval separate from automatic pairing", async () => {
  mocks.install.mockResolvedValue(installation({ storeDiscovered: [approval] }));
  const result = await setup("install");
  expect(result).toMatchObject({
    phase: "needs_browser_action",
    reason: "chrome_approval_required",
    nextAction: "approve_extension",
    installation: { installedProfiles: 1, discoveredProfiles: 0 },
  });
  expect(mocks.install).toHaveBeenCalledOnce();
  expect(mocks.readToken).not.toHaveBeenCalled();
});

it("does not let sibling browser installations mask an unavailable Chrome helper", async () => {
  mocks.inspect.mockResolvedValue(
    installation({
      registrations: [
        registration({ issue: "runtime unavailable" }),
        registration({ product: "chromium" }),
      ],
      storeDiscovered: [approval, { product: "chromium", enabled: true, awaitingApproval: false }],
      discovered: [{ product: "chrome-for-testing" }],
    }),
  );
  const result = await setup("inspect");
  expect(result).toMatchObject({
    phase: "blocked",
    reason: "native_host_unavailable",
    nextAction: "repair_native_host",
    installation: {
      nativeHostRegistered: false,
      installedProfiles: 1,
      discoveredProfiles: 0,
      awaitingApproval: true,
    },
  });
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.install).not.toHaveBeenCalled();
  expect(mocks.readToken).not.toHaveBeenCalled();
  expectRedacted(result, "/private");
});

it("proves the exact local profile even when configured Gateway uses an SSH loopback", async () => {
  const result = await setup("verify", {
    profile: "work",
    cfg: {
      gateway: { mode: "remote", remote: { url: "ws://127.0.0.1:18789" } },
      browser: { profiles: { work: { driver: "extension", cdpPort: 19444 } } },
    },
  });
  expect(mocks.connect).toHaveBeenCalledWith(
    expect.objectContaining({ profile: "work", port: 19444 }),
  );
  expect(result).toMatchObject({
    phase: "ready",
    connection: { state: "connected" },
    target: { profile: "work", relayPort: 19444 },
  });
  expect(result).not.toHaveProperty("gatewayLocal");
  expect(mocks.close).toHaveBeenCalledOnce();
  expectRedacted(result);
});

it.each(["missing key", "connection error"])(
  "reports %s without leaking credentials",
  async (failure) => {
    if (failure === "missing key") {
      mocks.readToken.mockReturnValue(null);
    } else {
      mocks.connect.mockRejectedValue(new Error("synthetic-private-relay-key"));
    }
    const result = await setup("verify");
    expect(result).toMatchObject({ connection: { state: "unavailable" } });
    expectRedacted(result);
    expect(mocks.install).not.toHaveBeenCalled();
    if (failure === "missing key") {
      expect(mocks.connect).not.toHaveBeenCalled();
    }
  },
);

it("rejects invalid profile and canceled request before install", async () => {
  await expect(setup("install", { profile: "openclaw" })).rejects.toThrow(
    "extension browser profile",
  );
  await expect(setup("install", { signal: AbortSignal.abort() })).rejects.toThrow();
  expect(mocks.install).not.toHaveBeenCalled();
});
