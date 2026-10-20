import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  registerAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "../../agents/workspace-access.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { resolveSkillDiscoveryLimits } from "../loading/skill-root-discovery.js";
import { readWorkspaceSkillSources } from "../loading/workspace-skill-source-reader.js";
import {
  resolveWorkspaceSkillSourcePlan,
  type WorkspaceSkillSourceRequest,
} from "../loading/workspace-skill-sources.js";
import { resolveSkillFileHost } from "../skill-file-host.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import * as remoteRefresh from "./refresh-remote.js";
import { getSkillsSnapshotVersion as versionOf } from "./refresh-state.js";
import * as refresh from "./refresh.js";
import { resolveReusableWorkspaceSkillSnapshot as resolveSnapshot } from "./session-snapshot.js";
import { serveWorkspaceSkills } from "./workspace-worker.js";

const releases: Array<() => void> = [];
const temporary = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await refresh.closeSkillsWatchers(true);
    } finally {
      releases.splice(0).forEach((release) => release());
      resetGatewayWorkAdmission();
      vi.restoreAllMocks();
      vi.useRealTimers();
      vi.unstubAllEnvs();
      cleanup();
    }
  }),
);
let fixtureRoot: string;
let workspaceDir: string;
async function mkdir(relative: string) {
  const directory = path.join(fixtureRoot, relative);
  await fs.mkdir(directory, { recursive: true });
  return directory;
}
beforeEach(async () => {
  fixtureRoot = temporary.make("skills-workspace-");
  workspaceDir = path.join(fixtureRoot, "workspace");
  await mkdir("workspace/skills");
  vi.stubEnv("OPENCLAW_STATE_DIR", await mkdir("state"));
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

async function waitForSkillsTurn() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function snapshot(params: Parameters<typeof resolveSnapshot>[0]) {
  return (await resolveSnapshot(params)).snapshot;
}

const writeAt = (root: string, name: string, description: string) =>
  writeSkill({ dir: path.join(root, name), name, description });
const sources = (root: string) => resolveWorkspaceSkillSourcePlan(root, { workspaceOnly: true });

function watchWorker(workspace: string, output: Writable) {
  const input = new PassThrough();
  const task = serveWorkspaceSkills({
    workspace,
    home: workspace,
    operation: "watch",
    input,
    output,
  });
  const request = JSON.stringify({ sourcePlan: sources(workspace) }) + "\n";
  const start = () => input.write(request);
  return { input, task, start };
}

async function expectRetirementPending(
  task: Promise<void>,
  subscription: { signal: AbortSignal; end: () => void },
) {
  await awaitGateBeforeSettlement(
    waitForSkillsTurn(),
    task,
    "Retirement settled before transport close",
  );
  expect(subscription.signal.aborted).toBe(true);
  return async () => {
    subscription.end();
    await task;
  };
}

it("retires remote subscriptions during Gateway drain and reacquires after runtime reset", async () => {
  const { params, subscriptions, access, gateway } = await remoteFixture();
  await resolveSnapshot(params);
  const original = subscriptions[0]!;
  const version = versionOf(gateway);

  markGatewayRestartDraining("stop (SIGTERM)");
  expect(original.signal.aborted).toBe(true);
  original.emit("change");
  expect(versionOf(gateway)).toBe(version);
  await refresh.ensureSkillsWatcher(params);
  expect(access.watchSkills).toHaveBeenCalledTimes(1);
  await access.watchSkills.mock.results[0]!.value;
  await waitForSkillsTurn();
  expect(versionOf(gateway)).toBe(version);

  // Teardown joins the retired transport; the next runtime gets a fresh signal.
  await refresh.closeSkillsWatchers(true);
  resetGatewayWorkAdmission();
  await refresh.ensureSkillsWatcher(params);
  expect(access.watchSkills).toHaveBeenCalledTimes(2);
  expect(subscriptions[1]!.signal.aborted).toBe(false);
  const restartedVersion = versionOf(gateway);
  original.emit("unavailable");
  expect(versionOf(gateway)).toBe(restartedVersion);
  subscriptions[1]!.emit("change");
  expect(versionOf(gateway)).toBeGreaterThan(restartedVersion);
});

it("waits for an agent's remote skills subscription to close before deletion completes", async () => {
  const { params, subscriptions } = await remoteFixture({ finishOnAbort: false });
  const closeStarted = createDeferred();
  await refresh.ensureSkillsWatcher({ ...params, agentId: "worker" });
  const subscription = subscriptions[0]!;
  subscription.signal.addEventListener("abort", () => closeStarted.resolve(), { once: true });
  const drain = refresh.closeSkillsWatchersForAgent({ agentId: "worker" });
  try {
    await awaitGateBeforeSettlement(
      closeStarted.promise,
      drain,
      "Agent drainage completed before remote watcher cancellation began",
    );
    await expectRetirementPending(drain, subscription);
  } finally {
    subscription.end();
  }
  await drain;
});

it("keeps a shared remote subscription until its last agent owner is removed", async () => {
  const { params, subscriptions, access } = await remoteFixture();
  await refresh.ensureSkillsWatcher({ ...params, agentId: "first" });
  await refresh.ensureSkillsWatcher({ ...params, agentId: "second" });
  expect(access.watchSkills).toHaveBeenCalledTimes(1);

  await refresh.closeSkillsWatchersForAgent({ agentId: "first" });
  expect(subscriptions[0]?.signal.aborted).toBe(false);

  await refresh.closeSkillsWatchersForAgent({ agentId: "second" });
  expect(subscriptions[0]?.signal.aborted).toBe(true);
});

async function remoteFixture(options: { finishOnAbort?: boolean } = {}) {
  const gateway = workspaceDir;
  const host = await mkdir("host");
  const writes = (description: string) => writeAt(path.join(host, "skills"), "guide", description);
  await writes("Original host instructions");
  type Watch = NonNullable<AgentWorkspaceAccess["watchSkills"]>;
  const subscriptions: Array<{
    emit: Parameters<Watch>[1];
    signal: AbortSignal;
    end: () => void;
  }> = [];
  const access = {
    bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
    loadSkills: vi.fn(async (_request: WorkspaceSkillSourceRequest) =>
      readWorkspaceSkillSources({
        sourcePlan: sources(host),
        limits: resolveSkillDiscoveryLimits(),
        additionalBins: [],
      }),
    ),
    watchSkills: vi.fn<Watch>(
      async (_request, emit, signal) =>
        new Promise<void>((end) => {
          subscriptions.push({ emit, signal, end });
          if (options.finishOnAbort !== false) {
            signal.addEventListener("abort", () => end(), { once: true });
          }
        }),
    ),
  };
  const release = registerAgentWorkspaceAccess(gateway, access);
  const config = { plugins: { enabled: false } };
  releases.push(release);
  const params = { workspaceDir: gateway, config };
  return { gateway, writes, subscriptions, access, release, params };
}

it("bounds remote subscriptions by recent access and invalidates evicted source readmission", async () => {
  const { gateway, access, subscriptions } = await remoteFixture();
  const sourcePlan = sources(gateway);
  const ensure = (index: number) =>
    remoteRefresh.ensureRemoteSkillsWatcher({
      watcherKey: `remote-${index}`,
      workspaceDir: gateway,
      executionWorkspaceDir: `/remote/workspace-${index}`,
      access,
      sourcePlan,
    });
  for (let index = 0; index < 128; index++) {
    await ensure(index);
  }
  await ensure(0);
  await ensure(128);
  expect(access.watchSkills).toHaveBeenCalledTimes(129);
  expect(subscriptions[0]!.signal.aborted).toBe(false);
  expect(subscriptions[1]!.signal.aborted).toBe(true);
  expect(subscriptions.filter(({ signal }) => !signal.aborted)).toHaveLength(128);

  const evictedVersion = versionOf(gateway);
  subscriptions[1]!.emit("change");
  expect(versionOf(gateway)).toBe(evictedVersion);
  await ensure(1);
  expect(versionOf(gateway)).toBeGreaterThan(evictedVersion);
  expect(subscriptions[2]!.signal.aborted).toBe(true);
  expect(access.watchSkills).toHaveBeenCalledTimes(130);
  expect(subscriptions.filter(({ signal }) => !signal.aborted)).toHaveLength(128);
});

it("joins remote replacement, disposal, and shutdown before releasing their callers", async () => {
  const fixtureOptions = { finishOnAbort: false };
  const { gateway, access, subscriptions } = await remoteFixture(fixtureOptions);
  const params = {
    watcherKey: JSON.stringify([gateway, undefined, undefined]),
    workspaceDir: gateway,
    access,
    sourcePlan: sources(gateway),
  };
  try {
    await remoteRefresh.ensureRemoteSkillsWatcher(params);
    const finishReplacement = await expectRetirementPending(
      remoteRefresh.ensureRemoteSkillsWatcher({
        ...params,
        executionWorkspaceDir: "/remote/replacement",
      }),
      subscriptions[0]!,
    );
    expect(access.watchSkills).toHaveBeenCalledTimes(1);
    const retiredVersion = versionOf(gateway);
    subscriptions[0]!.emit("unavailable");
    expect(versionOf(gateway)).toBe(retiredVersion);
    await finishReplacement();
    expect(access.watchSkills).toHaveBeenCalledTimes(2);

    const finishDisposal = await expectRetirementPending(
      refresh.ensureSkillsWatcher({
        workspaceDir: gateway,
        sourcePlan: params.sourcePlan,
        config: { plugins: { enabled: false }, skills: { load: { watch: false } } },
      }),
      subscriptions[1]!,
    );
    await finishDisposal();

    await remoteRefresh.ensureRemoteSkillsWatcher(params);
    const finishClosing = await expectRetirementPending(
      remoteRefresh.closeRemoteSkillsWatchers(),
      subscriptions[2]!,
    );
    await finishClosing();
  } finally {
    fixtureOptions.finishOnAbort = true;
    subscriptions.forEach(({ end }) => end());
  }
});

it("restores snapshot reuse only on verified availability, without adding a content revision", async () => {
  const { params, subscriptions, access, writes, gateway } = await remoteFixture();
  let saved = await snapshot(params);
  const subscription = subscriptions[0]!;
  subscription.emit("unavailable");
  await writes("Reconciled during outage");
  subscription.emit("change");
  saved = await snapshot({ ...params, existingSnapshot: saved });
  const afterChange = access.loadSkills.mock.calls.length;
  saved = await snapshot({ ...params, existingSnapshot: saved });
  expect(access.loadSkills).toHaveBeenCalledTimes(afterChange + 1);
  const version = versionOf(gateway);
  subscription.emit("available");
  expect(versionOf(gateway)).toBe(version);
  expect(await snapshot({ ...params, existingSnapshot: saved })).toBe(saved);
  expect(access.loadSkills).toHaveBeenCalledTimes(afterChange + 1);
  await writes("Changed under recovered coverage");
  subscription.emit("change");
  saved = await snapshot({ ...params, existingSnapshot: saved });
  expect(saved.prompt).toContain("Changed under recovered coverage");
  expect(access.loadSkills).toHaveBeenCalledTimes(afterChange + 2);
  subscription.emit("unavailable");
  await snapshot({ ...params, existingSnapshot: saved });
  expect(access.loadSkills).toHaveBeenCalledTimes(afterChange + 3);
  expect(access.watchSkills).toHaveBeenCalledOnce();
});

it("publishes initial availability and completed skill changes through the worker wire", async () => {
  const workspace = await mkdir("watch-worker");
  const write = (description: string) =>
    writeAt(path.join(workspace, "skills"), "guide", description);
  await write("Worker content");
  const output = new PassThrough();
  const messages: unknown[] = [];
  const received = { available: createDeferred(), change: createDeferred() };
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const message: unknown = JSON.parse(line);
      messages.push(message);
      if (message === "available" || message === "change") {
        received[message].resolve();
      }
    }
  });
  const { input, task, start } = watchWorker(workspace, output);
  start();
  await received.available.promise;
  expect(messages).toContain("available");
  await write("Later worker edit");
  await refresh.refreshSkillsDiscovery({ workspaceDir: workspace });
  await received.change.promise;
  expect(messages).toContain("change");
  input.end();
  await task;
  output.destroy();
});

it("refreshes Gateway Workshop edits alongside the existing host subscription", async () => {
  const { params, gateway, access, subscriptions } = await remoteFixture();
  const config = {
    ...params.config,
    agents: { entries: { main: { agentDir: path.join(gateway, "agent") } } },
  };
  const workshop = resolveWorkshopSkillsDir(config, "main");
  const write = (description: string) => writeAt(workshop, "authored", description);
  await write("Original Workshop instructions");
  const request = { ...params, config, agentId: "main" };
  const first = await snapshot(request);
  expect(first.prompt).toContain("Original Workshop instructions");
  await write("Updated Workshop instructions");
  await refresh.refreshSkillsDiscovery({ workspaceDir: gateway, reason: "workshop" });
  const updated = await snapshot({
    ...request,
    existingSnapshot: first,
  });
  expect(updated.prompt).toContain("Updated Workshop instructions");
  expect(access.watchSkills).toHaveBeenCalledTimes(1);
  expect(subscriptions[0]!.signal.aborted).toBe(false);
  await refresh.ensureSkillsWatcher({
    ...request,
    config: { ...config, skills: { load: { watch: false } } },
  });
  expect(subscriptions[0]!.signal.aborted).toBe(true);
});

it("reacquires a closed transport and rejects late events after binding retirement", async () => {
  const { params, gateway, subscriptions, access, release } = await remoteFixture();
  await refresh.ensureSkillsWatcher(params);
  subscriptions[0]!.end();
  await waitForSkillsTurn();
  await refresh.ensureSkillsWatcher(params);
  expect(access.watchSkills).toHaveBeenCalledTimes(2);
  const version = versionOf(gateway);
  subscriptions[0]!.emit("change");
  expect(versionOf(gateway)).toBe(version);
  release();
  expect(subscriptions[1]!.signal.aborted).toBe(true);
  subscriptions[1]!.emit("change");
  expect(versionOf(gateway)).toBe(version);
  await refresh.closeSkillsWatchers();
  await expect(refresh.ensureSkillsWatcher(params)).rejects.toThrow("Workspace access is stopped");
});

it("joins accepted stdout writes after retiring skill discovery", async () => {
  const workspace = await mkdir("skills-watch-stdout");
  const written = createDeferred();
  const retired = createDeferred();
  const flushed = createDeferred();
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      written.resolve();
      void flushed.promise.then(() => callback());
    },
  });
  const originalClose = refresh.closeSkillsWatchers;
  vi.spyOn(refresh, "closeSkillsWatchers").mockImplementation((...args) => {
    const pending = originalClose(...args);
    void pending.then(retired.resolve, retired.reject);
    return pending;
  });
  const { input, task: worker, start } = watchWorker(workspace, output);
  try {
    start();
    await written.promise;
    expect(output.writableNeedDrain).toBe(true);
    input.end();
    await retired.promise;
    await awaitGateBeforeSettlement(
      waitForSkillsTurn(),
      worker,
      "Worker settled before stdout drained",
    );
    flushed.resolve();
    await worker;
    expect(output.writableLength).toBe(0);
  } finally {
    flushed.resolve();
    input.end();
    await worker;
    output.destroy();
  }
});

it("keeps canonical Gateway roots local through discovery, refresh, and host changes", async () => {
  const { params, access, release } = await remoteFixture();
  const canonical = await mkdir("canonical-project");
  const projectRoot = path.join(canonical, "skills");
  await writeAt(projectRoot, "guide", "Lower precedence project");
  const project = path.join(projectRoot, "project");
  const write = (description: string) => writeAt(projectRoot, "project", description);
  await write("Original project instructions");
  const canonicalParams = {
    ...params,
    executionWorkspaceDir: canonical,
    executionWorkspaceFileHost: "gateway" as const,
  };
  let saved = await snapshot(canonicalParams);
  expect(saved.resolvedSkills?.find((skill) => skill.name === "guide")?.description).toBe(
    "Original host instructions",
  );
  const projectSkill = saved.resolvedSkills?.find((skill) => skill.name === "project");
  expect(projectSkill).toMatchObject({ filePath: path.join(project, "SKILL.md") });
  expect(resolveSkillFileHost(projectSkill!)).toBe("gateway");
  expect(access.loadSkills.mock.lastCall?.[0].executionWorkspaceDir).toBeUndefined();
  expect(access.watchSkills.mock.lastCall?.[0].executionWorkspaceDir).toBeUndefined();
  await write("Changed project instructions");
  await refresh.refreshSkillsDiscovery({ workspaceDir: params.workspaceDir });
  saved = await snapshot({ ...canonicalParams, existingSnapshot: saved });
  expect(saved.prompt).toContain("Changed project instructions");
  // A remote explicit path with identical text is a different source identity.
  const remote = await resolveSnapshot({
    ...params,
    executionWorkspaceDir: canonical,
    existingSnapshot: saved,
  });
  expect(remote.shouldRefresh).toBe(true);
  expect(access.loadSkills.mock.lastCall?.[0].executionWorkspaceDir).toBe(canonical);
  expect(access.watchSkills.mock.lastCall?.[0].executionWorkspaceDir).toBe(canonical);
  release();
  await expect(resolveSnapshot({ ...canonicalParams, existingSnapshot: saved })).rejects.toThrow(
    "stopped or not ready",
  );
});
