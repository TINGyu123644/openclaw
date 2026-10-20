import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { sanitizeChatHistoryMessages } from "../../gateway/chat-display-projection.sanitize.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.message.js";
import {
  createSandboxMediaContexts,
  createSandboxWorkspacePreparation,
  createSandboxMediaStageConfig,
  withSandboxMediaTempHome,
} from "../stage-sandbox-media.test-harness.js";
import { stageSandboxMedia } from "./stage-sandbox-media.js";

const sandboxMocks = vi.hoisted(() => ({ ensureSandboxWorkspaceForSession: vi.fn() }));
// mock-isolation: History rewriting owns synthetic workspaces without provisioning real sandboxes.
vi.mock("../../agents/sandbox/context.js", () => ({
  ...sandboxMocks,
  prepareSandboxWorkspaceForSession: async (...args: unknown[]) =>
    createSandboxWorkspacePreparation(await sandboxMocks.ensureSandboxWorkspaceForSession(...args)),
}));
beforeEach(() => sandboxMocks.ensureSandboxWorkspaceForSession.mockReset());

async function mediaFixture(home: string) {
  const source = path.join(home, ".openclaw", "media", "inbound", "synthetic.png");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, "synthetic image bytes");
  return {
    source,
    ...createSandboxMediaContexts(source),
    cfg: createSandboxMediaStageConfig(home),
    sessionKey: "agent:main:main",
    workspaceDir: path.join(home, "workspace"),
  };
}

it.each(["settled", "failed", "aborted"] as const)(
  "settles attribution before attachment staging (%s)",
  (outcome) =>
    withSandboxMediaTempHome("openclaw-attribution-media-", async (home) => {
      const fixture = await mediaFixture(home);
      const { workspaceDir } = fixture;
      sandboxMocks.ensureSandboxWorkspaceForSession.mockResolvedValue(null);
      const entered = createDeferred();
      const baseline = createDeferred();
      const controller = new AbortController();
      const failure = new Error("capture no longer active");
      const pending = stageSandboxMedia({
        ...fixture,
        abortSignal: controller.signal,
        awaitSessionDiffBaseline: () => {
          entered.resolve();
          return baseline.promise;
        },
      });
      void pending.catch(() => {});
      try {
        await awaitGateBeforeSettlement(entered.promise, pending, "Media bypassed attribution");
        expect(sandboxMocks.ensureSandboxWorkspaceForSession).not.toHaveBeenCalled();
        await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
        if (outcome === "failed") {
          baseline.reject(failure);
        } else {
          if (outcome === "aborted") {
            controller.abort(failure);
          }
          baseline.resolve();
        }
        if (outcome !== "settled") {
          await expect(pending).rejects.toBe(failure);
        } else {
          const result = await pending;
          expect(await fs.readFile(path.resolve(workspaceDir, result.staged.get(0)!), "utf8")).toBe(
            "synthetic image bytes",
          );
        }
        expect(sandboxMocks.ensureSandboxWorkspaceForSession).toHaveBeenCalledTimes(
          outcome === "settled" ? 1 : 0,
        );
      } finally {
        baseline.resolve();
        await pending.catch(() => undefined);
      }
    }),
);

describe.each([false, true])("history (sandbox=%s)", (sandbox) => {
  it.each(["path-only", "physical-alias", "managed-alias", "file-alias"])(
    "keeps %s images fetchable",
    (reference) =>
      withSandboxMediaTempHome("openclaw-staged-history-", async (home) => {
        const fixture = await mediaFixture(home);
        const { source, ctx, sessionCtx, workspaceDir } = fixture;
        const uri = "media://inbound/synthetic.png";
        const sandboxDir = path.join(home, "sandbox");
        sandboxMocks.ensureSandboxWorkspaceForSession.mockResolvedValue(
          sandbox ? { workspaceDir: sandboxDir, containerWorkdir: "/work" } : null,
        );
        ctx.media = [
          {
            path: reference === "managed-alias" ? uri : source,
            ...(reference === "physical-alias" ? { url: source } : {}),
            ...(reference === "managed-alias" ? { url: uri } : {}),
            ...(reference === "file-alias" ? { url: pathToFileURL(source).href } : {}),
            contentType: "image/png",
            kind: "image",
          },
        ];
        const result = await stageSandboxMedia(fixture);
        const stagedPath = result.staged.get(0)!;
        expect(stagedPath).not.toBe(source);
        expect(
          await fs.readFile(path.resolve(sandbox ? sandboxDir : workspaceDir, stagedPath), "utf8"),
        ).toBe("synthetic image bytes");
        expect(sessionCtx.media).toEqual(ctx.media);

        const persisted = buildPersistedUserTurnMessage({
          text: "Synthetic attachment",
          media: ctx.media,
        });
        const [history] = sanitizeChatHistoryMessages([persisted]);
        expect(history).toMatchObject({
          __openclaw: { media: [{ url: uri, contentType: "image/png", kind: "image" }] },
        });
        expect(JSON.stringify(history)).not.toContain(home);
        expect(JSON.stringify(history)).not.toContain("openclaw-staged-");
      }),
  );
});
