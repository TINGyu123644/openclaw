import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectLegacyWhatsAppCrontabHealthWarning,
  noteCronDeliveryTargetAdvisory,
  noteLegacyWhatsAppCrontabHealthCheck,
} from "./warnings.js";

const mocks = vi.hoisted(() => ({
  listReadOnlyChannelPluginsForConfig: vi.fn(),
  note: vi.fn(),
  runExec: vi.fn(),
}));

vi.mock("../../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.listReadOnlyChannelPluginsForConfig,
}));
vi.mock("../../../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("../../../process/exec.js", () => ({ runExec: mocks.runExec }));

afterEach(() => vi.clearAllMocks());

function job(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: "job", schedule: "0 * * * *", ...overrides };
}

function advisory(jobs: Array<Record<string, unknown>>, channels: string[] = []): string | null {
  mocks.note.mockClear();
  mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue(channels.map((id) => ({ id })));
  noteCronDeliveryTargetAdvisory({ cfg: {}, jobs });
  const body = mocks.note.mock.calls.at(-1)?.[0];
  return typeof body === "string" ? body : null;
}

describe("collectCronDeliveryTargetAdvisory", () => {
  it("advises when a concrete delivery channel has no active plugin", () => {
    const message = advisory([
      job({ id: "needs-doctor", delivery: { channel: "slack" } }),
      job({ id: "report", delivery: { mode: "announce", channel: "missing-channel" } }),
    ]);
    expect(message).not.toBeNull();
    for (const text of [
      "Automation delivery targets unavailable channels",
      "1 job announces",
      "Channels: missing-channel=1",
      "Examples: report -> missing-channel",
    ]) {
      expect(message).toContain(text);
    }
  });

  it("treats a channel alias as active when its canonical id is available", () => {
    expect(
      advisory([job({ delivery: { mode: "announce", channel: "gchat" } })], ["googlechat"]),
    ).toBeNull();
  });

  it("falls back to job name then <unnamed> in examples", () => {
    const message = advisory(
      ["Nightly digest", undefined].map((name) =>
        job({ id: undefined, name, delivery: { mode: "announce", channel: "ghost" } }),
      ),
      ["slack"],
    );
    expect(message).toContain("Nightly digest -> ghost");
    expect(message).toContain("<unnamed> -> ghost");
  });
});

describe("collectLegacyWhatsAppCrontabHealthWarning", () => {
  it("bounds the best-effort crontab read", async () => {
    mocks.runExec.mockRejectedValueOnce(new Error("crontab timed out"));

    await expect(
      collectLegacyWhatsAppCrontabHealthWarning({ platform: "linux" }),
    ).resolves.toBeNull();
    expect(mocks.runExec).toHaveBeenCalledWith("crontab", ["-l"], {
      logOutput: false,
      timeoutMs: 5_000,
    });
  });
});

it("warns about legacy ensure-whatsapp crontab entries on Linux", async () => {
  await noteLegacyWhatsAppCrontabHealthCheck({
    platform: "linux",
    readCrontab: async () => ({
      stdout: [
        "# keep comments ignored",
        "*/5 * * * * ~/.openclaw/bin/ensure-whatsapp.sh >> ~/.openclaw/logs/whatsapp-health.log 2>&1",
        "0 9 * * * /usr/bin/true",
        "",
      ].join("\n"),
    }),
  });

  for (const text of [
    "Legacy WhatsApp crontab health check detected",
    "systemd user bus environment is missing",
    "Matched 1 entry",
  ]) {
    expect(mocks.note).toHaveBeenCalledWith(expect.stringContaining(text), "Cron");
  }
});
