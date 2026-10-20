import { afterEach, expect, it, vi } from "vitest";
import { updateAuthProfileStoreWithLock } from "../../../agents/auth-profiles/store-runtime.js";
import { persistAuthProfileBatch } from "../../../agents/auth-profiles/upsert-with-lock.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  loadSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { ModelDefinitionConfig } from "../../../config/types.models.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { loadCronJobsStore, saveCronJobsStore } from "../../../cron/store.js";
import type { CronStoredJob } from "../../../cron/types.js";
import * as snapshots from "../../../infra/sqlite-snapshot.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { withDoctorConfigMaintenance } from "../../doctor-config-flow.test-support.js";
import { maybeRepairCronInferenceBindings } from "./inference-binding-migration.js";
import { inspectCronJobsForDoctor } from "./store-repair.js";

afterEach(() => vi.restoreAllMocks());

function withAccounts(run: (state: OpenClawTestState) => Promise<void>) {
  return withOpenClawTestState(
    {
      label: "cron-inference-accounts",
      env: { OPENAI_API_KEY: undefined, OPENAI_OAUTH_TOKEN: undefined },
    },
    async (state) => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("No external I/O in offline migration"),
      );
      await run(state);
    },
  );
}

function config(state: OpenClawTestState, model = "openai/gpt-5.5"): OpenClawConfig {
  return {
    agents: {
      entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
      defaults: { model },
    },
    plugins: { allow: ["openai"], slots: { memory: "none" } },
  };
}

function apiProfile(
  profileId: string,
  key: string,
  provider = profileId.slice(0, profileId.indexOf(":")),
) {
  return {
    profileId,
    credential: { type: "api_key" as const, provider, key },
  };
}

function saveProfiles(...profiles: Parameters<typeof persistAuthProfileBatch>[0]["profiles"]) {
  return persistAuthProfileBatch({ profiles });
}

function saveJobs(path: string, ...jobs: CronStoredJob[]) {
  return saveCronJobsStore(path, { version: 1, jobs });
}

function session(id: string, overrides: Partial<SessionEntry>) {
  return replaceSessionEntry(
    { agentId: "main", sessionKey: `agent:main:cron:${id}` },
    {
      sessionId: id,
      updatedAt: 1,
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
      ...overrides,
    },
  );
}

function configuredModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
}

function job(id: string, model?: string): CronStoredJob {
  return {
    id,
    name: id,
    agentId: "main",
    enabled: false,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Synthetic work", ...(model ? { model } : {}) },
    delivery: { mode: "none" },
    state: {},
  };
}

it("records the planner's first account for ambiguous jobs, keeps direct keys unbound and refuses missing accounts instead of pinning a previous fallback", async () => {
  await withAccounts(async (state) => {
    const base = config(state);
    const cfg: OpenClawConfig = {
      ...base,
      agents: {
        ...base.agents,
        defaults: {
          systemAgent: { agentId: "main" },
          model: "openai/gpt-5.5",
          models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } },
          modelPolicy: {
            allow: [
              "openai/gpt-5.5",
              "openai/gpt-5.4",
              "synthetic/model",
              "literal/model",
              "ollama/llama3.3",
            ],
          },
        },
      },
      models: {
        providers: {
          synthetic: {
            api: "openai-completions",
            auth: "api-key",
            baseUrl: "https://invalid.test/v1",
            apiKey: "synthetic:stored",
            models: [configuredModel("model")],
          },
          literal: {
            api: "openai-completions",
            auth: "api-key",
            baseUrl: "https://literal.invalid.test/v1",
            apiKey: "synthetic-direct-key",
            models: [configuredModel("model")],
          },
          ollama: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            models: [configuredModel("llama3.3")],
          },
        },
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    await saveProfiles(
      apiProfile("openai:a", "synthetic-a"),
      apiProfile("openai:b", "synthetic-b"),
      apiProfile("synthetic:stored", "synthetic-stored-key"),
      apiProfile("synthetic:other", "synthetic-other-key"),
      apiProfile("literal:stored", "synthetic-literal-stored-key"),
    );
    await updateAuthProfileStoreWithLock({
      updater(store) {
        // The usual first account is rate-limited while Doctor runs; that must not move the job.
        store.usageStats = { "openai:a": { cooldownUntil: Date.now() + 60_000 } };
        return true;
      },
    });
    const sessionScope = { agentId: "main", sessionKey: "agent:main:cron:session" };
    await session("session", {
      sessionId: "selected",
      authProfileOverride: "openai:b",
      authProfileOverrideSource: "user",
    });
    await session("previous-fallback", {
      sessionId: "fallback",
      providerOverride: "synthetic",
      modelOverride: "model",
      modelOverrideSource: "auto",
      modelProvider: "synthetic",
      model: "model",
    });
    await session("native-session", {
      sessionId: "native-selected",
      agentRuntimeOverride: "codex",
      authProfileOverride: "openai:a",
      authProfileOverrideSource: "user",
    });
    await session("native-locked", {
      modelSelectionLocked: true,
      agentHarnessId: "codex",
      authProfileOverride: "openai:a",
      authProfileOverrideSource: "user",
    });
    const selectedSession = loadSessionEntry(sessionScope);
    const original = [
      job("explicit", "openai/gpt-5.5@openai:a"),
      job("session"),
      job("ambiguous"),
      job("missing", "openai/gpt-5.5@openai:missing"),
      job("previous-fallback"),
      job("direct", "literal/model"),
      job("provider-account", "synthetic/model"),
      job("native-config", "openai/gpt-5.4@openai:a"),
      job("native-session"),
      job("native-locked"),
      job("local", "ollama/llama3.3"),
      { ...job("deleted-agent"), agentId: "deleted" },
      job("unavailable-model", "openai/does-not-exist"),
    ];
    const storePath = state.statePath("cron", "jobs.json");
    await saveJobs(storePath, ...original);
    const malformedPath = state.statePath("inactive-cron", "jobs.json");
    const laterPath = state.statePath("z-later-cron", "jobs.json");
    await saveJobs(malformedPath, job("malformed", "openai/gpt-5.5@openai:a"));
    await saveJobs(laterPath, job("after-malformed", "openai/gpt-5.5@openai:a"));
    // Reproduce persisted legacy bytes rejected by current creation; no runtime load repairs it.
    runOpenClawStateWriteTransaction(({ db }) => {
      db.prepare(
        "UPDATE cron_jobs SET job_json = json_set(job_json, '$.sessionTarget', 'session:') WHERE job_id = 'malformed'",
      ).run();
    });
    await withDoctorConfigMaintenance(async () => {
      const malformedBefore = (await inspectCronJobsForDoctor({ env: process.env })).jobs.find(
        (entry) => entry.id === "malformed",
      );
      expect(malformedBefore?.definition?.sessionTarget).toBe("session:");
      const preview = await maybeRepairCronInferenceBindings({ cfg, shouldRepair: false });
      expect(preview.changes).toEqual([]);
      expect(preview.warnings.join("\n")).toContain("openclaw doctor --fix");
      expect((await loadCronJobsStore(storePath)).jobs).toEqual(original);
      const result = await maybeRepairCronInferenceBindings({ cfg, shouldRepair: true });
      const warnings = result.warnings.join("\n");
      expect(warnings).toContain("malformed");
      expect(warnings).toContain("invalid cron sessionTarget session id");
      // Several eligible accounts: the run's first planned account is recorded, not refused.
      expect(warnings).not.toContain("More than one inference account");
      expect(result.changes.join("\n")).toContain(
        "Automation ambiguous (ambiguous): retain openai:a for openai/gpt-5.5",
      );
      expect(result.changes.join("\n")).toContain("Also eligible: openai:b");
      expect(warnings).toContain("openai:missing");
      // A provider-config key needs no adoption: the job keeps running on it unbound.
      expect(warnings).not.toContain("Automation direct (direct)");
      expect(warnings).toContain("deleted-agent");
      expect(warnings).toContain("unavailable-model");
      expect(warnings).toContain("modelPolicy.allow");
      expect(warnings).toContain("native-config");
      expect(warnings).toContain("native-session");
      expect(warnings).toContain("native-locked");
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(warnings).not.toContain("synthetic-direct-key");
      const saved = (await loadCronJobsStore(storePath)).jobs;
      // A previous auto fallback is not the job's account: it keeps the default's first account.
      expect(Object.fromEntries(saved.map((j) => [j.id, j.inferenceBinding]))).toMatchObject({
        explicit: { profileId: "openai:a", source: "user" },
        session: { profileId: "openai:b", source: "user" },
        ambiguous: { profileId: "openai:a", source: "auto" },
        "previous-fallback": { provider: "openai", profileId: "openai:a" },
        "provider-account": { provider: "synthetic", profileId: "synthetic:stored" },
      });
      expect((await loadCronJobsStore(laterPath)).jobs[0]?.inferenceBinding).toMatchObject({
        profileId: "openai:a",
      });
      expect(
        (await inspectCronJobsForDoctor({ env: process.env })).jobs.find(
          (entry) => entry.id === "malformed",
        ),
      ).toEqual(malformedBefore);
      for (const id of [
        "missing",
        "direct",
        "local",
        "deleted-agent",
        "unavailable-model",
        "native-config",
        "native-session",
        "native-locked",
      ]) {
        expect(saved.find((j) => j.id === id)).toEqual(original.find((j) => j.id === id));
      }
      expect(loadSessionEntry(sessionScope)).toEqual(selectedSession);
    });
  });
});

it.each([
  { name: "unbound session", linked: false, originalPresent: true },
  { name: "linked account", linked: true, originalPresent: true },
  { name: "missing linked account", linked: true, originalPresent: false },
])("respects $name when migrating personal-account jobs", async ({ linked, originalPresent }) => {
  await withAccounts(async (state) => {
    const personalId =
      "personal:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
    const cfg: OpenClawConfig = {
      ...config(state, "openai/gpt-5.4"),
      auth: { order: { openai: [personalId, "openai:shared"] } },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    await saveProfiles(
      apiProfile("openai:shared", "synthetic-shared"),
      ...(originalPresent ? [apiProfile(personalId, "synthetic-personal", "openai")] : []),
    );
    const sessionScope = { agentId: "main", sessionKey: "agent:main:cron:personal-selection" };
    if (linked) {
      await session("personal-selection", {
        sessionId: "original-linked-session",
        authProfileOverride: personalId,
        authProfileOverrideSource: "user-link",
      });
    }
    const originalSession = loadSessionEntry(sessionScope);
    const original = job("personal-selection");
    const storePath = state.statePath("cron", "jobs.json");
    await saveJobs(storePath, original);
    await withDoctorConfigMaintenance(async () => {
      const result = await maybeRepairCronInferenceBindings({ cfg, shouldRepair: true });
      if (linked) {
        expect(result.changes).toEqual([]);
        const warnings = result.warnings.join("\n");
        expect(warnings).toContain("inference account was not migrated");
        expect(warnings).toContain('Selected auth profile "personal:');
        expect(warnings).toContain("is unavailable");
        expect(warnings).toContain("openai/gpt-5.5@<profileId>");
        expect((await loadCronJobsStore(storePath)).jobs).toEqual([original]);
      } else {
        // Without a prior selection, the unattended planner skips personal accounts.
        expect(result.changes.join("\n")).toContain("retain openai:shared");
        expect(result.changes.join("\n")).not.toContain(personalId);
        expect((await loadCronJobsStore(storePath)).jobs[0]?.inferenceBinding).toMatchObject({
          profileId: "openai:shared",
        });
      }
      expect(loadSessionEntry(sessionScope)).toEqual(originalSession);
    });
  });
});

it.each(["job edit", "account replacement", "backup failure"] as const)(
  "leaves jobs unchanged when %s prevents safe migration",
  async (change) => {
    await withAccounts(async (state) => {
      const cfg = config(state);
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      await saveProfiles({
        profileId: "openai:a",
        credential:
          change === "job edit"
            ? { type: "api_key", provider: "openai", key: "synthetic-original" }
            : {
                type: "oauth",
                provider: "openai",
                access: "synthetic-original-access",
                refresh: "synthetic-refresh",
                expires: Date.now() + 3_600_000,
                accountId: "synthetic-account",
              },
      });
      const storePath = state.statePath("cron", "jobs.json");
      const original = job("guarded");
      await saveJobs(storePath, original);
      const snapshot = snapshots.createVerifiedSqliteSnapshot;
      vi.spyOn(snapshots, "createVerifiedSqliteSnapshot").mockImplementationOnce(async (params) => {
        if (change === "backup failure") {
          throw new Error("Synthetic backup unavailable");
        }
        if (change === "job edit") {
          await saveJobs(storePath, { ...original, name: "Edited after inspection" });
        } else {
          await saveProfiles(apiProfile("openai:a", "synthetic-replacement"));
        }
        return snapshot(params);
      });
      await withDoctorConfigMaintenance(async () => {
        const result = await maybeRepairCronInferenceBindings({ cfg, shouldRepair: true });
        expect(result.changes).toEqual([]);
        expect(snapshots.createVerifiedSqliteSnapshot).toHaveBeenCalledOnce();
        expect(result.warnings.join("\n")).toContain("not committed");
        if (change === "backup failure") {
          expect(result.warnings.join("\n")).toContain("Synthetic backup unavailable");
        }
        expect((await loadCronJobsStore(storePath)).jobs[0]).toEqual(
          change === "job edit" ? { ...original, name: "Edited after inspection" } : original,
        );
      });
    });
  },
);
