import fs from "node:fs/promises";
import path from "node:path";
import { appendMemoryHostEvent } from "openclaw/plugin-sdk/memory-host-events";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../api.js";
import plugin from "../index.js";

const registerMemoryCapability = vi.fn<OpenClawPluginApi["registerMemoryCapability"]>();
plugin.register(createTestPluginApi({ registerMemoryCapability }));
const publicArtifacts = registerMemoryCapability.mock.calls[0]?.[0].publicArtifacts;
if (!publicArtifacts) {
  throw new Error("expected memory-core to register public artifacts");
}

describe("memory-core public artifacts", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterAll);
  let fixtureRoot = "";
  beforeAll(() => {
    fixtureRoot = tempDirs.make("memory-core-public-artifacts-");
  });

  const config = (workspace: string): OpenClawConfig => ({
    agents: { entries: { main: { workspace } } },
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("lists public workspace artifacts with stable kinds", async () => {
    const workspaceDir = path.join(fixtureRoot, "workspace-stable-kinds");
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtureRoot);
    await fs.mkdir(path.join(workspaceDir, "memory", "dreaming"), { recursive: true });
    const files = [
      ["memory-root", "MEMORY.md", "# Durable Memory\n"],
      ["daily-note", "memory/2026-04-06.md", "# Daily Note\n"],
      ["dream-report", "memory/dreaming/2026-04-06.md", "# Dream Report\n"],
    ] as const;
    for (const [, relativePath, content] of files) {
      await fs.writeFile(path.join(workspaceDir, relativePath), content, "utf8");
    }
    const eventStoredAt = Date.parse("2026-04-07T09:30:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(eventStoredAt);
    const event: Parameters<typeof appendMemoryHostEvent>[1] = {
      type: "memory.recall.recorded",
      timestamp: "2026-04-06T12:00:00.000Z",
      query: "alpha",
      resultCount: 0,
      results: [],
    };
    await appendMemoryHostEvent(workspaceDir, event);

    const artifacts = await publicArtifacts.listArtifacts({ cfg: config(workspaceDir) });
    const eventArtifact = artifacts.find((artifact) => artifact.kind === "event-log");
    if (!eventArtifact) {
      throw new Error("expected memory event export");
    }
    expect(artifacts.filter((artifact) => artifact.kind !== "event-log")).toEqual(
      files.map(([kind, relativePath]) => ({
        kind,
        workspaceDir,
        relativePath,
        absolutePath: path.join(workspaceDir, relativePath),
        agentIds: ["main"],
        contentType: "markdown",
      })),
    );
    expect(eventArtifact.relativePath).toMatch(
      /^memory\/events\/[a-f0-9]{32}\/memory-host-events\.jsonl$/u,
    );
    await expect(fs.readFile(eventArtifact.absolutePath, "utf8")).resolves.toBe(
      `${JSON.stringify(event)}\n`,
    );
  });

  it("ignores lowercase memory root when only the legacy filename exists", async () => {
    const workspaceDir = path.join(fixtureRoot, "workspace-lowercase-root");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "memory.md"), "# Legacy Durable Memory\n", "utf8");

    await expect(
      publicArtifacts.listArtifacts({ cfg: config(workspaceDir) }),
    ).resolves.toStrictEqual([]);
  });
});
