import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import * as cronStore from "../../../cron/store.js";
import { loadCronStore, saveCronStore } from "../../../cron/store.js";
import type { CronJob } from "../../../cron/types.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { repairLegacyCronStoreWithoutPrompt } from "./legacy-repair.js";

const makeJob = (overrides: Partial<CronJob> = {}): CronJob => ({
  id: "legacy",
  name: "Legacy",
  enabled: true,
  createdAtMs: 1,
  updatedAtMs: 1,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "main",
  wakeMode: "now",
  payload: { kind: "systemEvent", text: "keep me" },
  state: {},
  ...overrides,
});

async function expectArchived(file: string, bytes: string | Buffer) {
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(`${file}.migrated`)).toEqual(Buffer.from(bytes));
}

const repair = (store: string) => repairLegacyCronStoreWithoutPrompt({ cfg: { cron: { store } } });

async function writeSources(
  fixture: OpenClawTestState,
  jobs: unknown[],
  state: CronJob["state"] = { lastRunAtMs: 11 },
  history: Record<string, string> = {},
) {
  const files = {
    "jobs.json": JSON.stringify({ version: 1, jobs }),
    "jobs-state.json": JSON.stringify({ version: 1, jobs: { legacy: { updatedAtMs: 12, state } } }),
    ...history,
  };
  const originals = new Map<string, string>();
  for (const [file, bytes] of Object.entries(files)) {
    originals.set(await fixture.writeText(`cron/${file}`, bytes), bytes);
  }
  return originals;
}

it("imports pre-July cron jobs and runtime state, preserves current jobs, and archives all history", async () => {
  await withOpenClawTestState({ label: "cron-pre-july" }, async (fixture) => {
    const storePath = fixture.statePath("cron", "jobs.json");
    const current = makeJob({
      id: "current",
      enabled: false,
      updatedAtMs: 8,
      state: { lastRunAtMs: 7 },
    });
    await saveCronStore(storePath, { version: 1, jobs: [current] });
    const retained = (await loadCronStore(storePath)).jobs[0];
    const legacy = makeJob({ name: "Legacy definition" });
    const originals = await writeSources(
      fixture,
      [{ ...current, name: "Stale copy" }, legacy, { ...legacy, id: undefined, name: "Idless" }],
      { lastRunAtMs: 11, lastStatus: "ok" },
      {
        "runs/legacy.jsonl": '{"ts":11,"jobId":"legacy","action":"finished","status":"ok"}\n',
        "runs/other.jsonl": "unparseable historical line\n",
      },
    );
    const result = await repair(storePath);
    const jobs = (await loadCronStore(storePath)).jobs;
    expect(jobs).toHaveLength(3);
    expect(jobs.find((job) => job.id === "current")).toEqual(retained);
    expect(jobs.find((job) => job.id === "legacy")).toMatchObject({
      name: "Legacy definition",
      state: { lastRunAtMs: 11, lastStatus: "ok" },
      updatedAtMs: 12,
    });
    expect(jobs.find((job) => job.name === "Idless")?.id).toMatch(/^cron-migrated-2-/);
    for (const [filePath, bytes] of originals) {
      await expectArchived(filePath, bytes);
      expect(result.warnings.join("\n")).toContain(`${filePath}.migrated`);
    }
    expect(result.warnings.join("\n")).toContain("Historical runs remain readable");
    expect(await repair(storePath)).toEqual({
      changes: [],
      warnings: [],
    });
    expect((await loadCronStore(storePath)).jobs).toEqual(jobs);
    await fs.writeFile(storePath, originals.get(storePath)!);
    await repair(storePath);
    expect((await loadCronStore(storePath)).jobs).toEqual(jobs);
  });
});

it("archives uninterpretable cron definitions with actionable recovery instead of blocking Doctor", async () => {
  await withOpenClawTestState({ label: "cron-malformed-legacy" }, async (fixture) => {
    const storePath = await fixture.writeText("cron/jobs.json", "{truncated legacy definition");
    const result = await repair(storePath);
    await expectArchived(storePath, "{truncated legacy definition");
    expect(result.warnings.join("\n")).toContain(
      `Recover job definitions from ${storePath}.migrated`,
    );
    expect(result.warnings.join("\n")).toContain("openclaw automations add");
    expect((await loadCronStore(storePath)).jobs).toEqual([]);
  });
});

it.each(["load", "commit"])(
  "retains cron sources after a SQLite %s failure and archives only after retry",
  async (phase) => {
    await withOpenClawTestState({ label: "cron-import-retry" }, async (fixture) => {
      const storePath = fixture.statePath("cron", "jobs.json");
      const originals = await writeSources(fixture, [makeJob()]);
      const db = openOpenClawStateDatabase().db;
      const rejection =
        "CREATE TRIGGER reject_legacy_cron BEFORE INSERT ON cron_jobs BEGIN SELECT RAISE(ABORT, 'synthetic cron import failure'); END";
      const save = cronStore.saveCronJobsStore;
      const fault =
        phase === "commit"
          ? vi
              .spyOn(cronStore, "saveCronJobsStore")
              .mockImplementationOnce((target, store, options) =>
                save(target, store, {
                  ...options,
                  transactionHooks: {
                    ...options?.transactionHooks,
                    beforeWrite: (connection, schema) => {
                      options?.transactionHooks?.beforeWrite?.(connection, schema);
                      connection.exec(rejection);
                    },
                  },
                }),
              )
          : undefined;
      if (phase === "load") {
        db.exec(rejection);
      }
      try {
        await expect(repair(storePath)).rejects.toThrow(
          phase === "load"
            ? "unexpected trigger reject_legacy_cron"
            : "synthetic cron import failure",
        );
        for (const [file, bytes] of originals) {
          expect(await fs.readFile(file, "utf8")).toBe(bytes);
        }
      } finally {
        fault?.mockRestore();
        if (phase === "load") {
          db.exec("DROP TRIGGER reject_legacy_cron");
        }
      }
      expect((await loadCronStore(storePath)).jobs).toEqual([]);
      await repair(storePath);
      expect((await loadCronStore(storePath)).jobs).toMatchObject([
        { id: "legacy", state: { lastRunAtMs: 11 } },
      ]);
      for (const [file, bytes] of originals) {
        await expectArchived(file, bytes);
      }
    });
  },
);
