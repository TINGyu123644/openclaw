import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  chunkMarkdownTextWithMode,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";

const { createMessage, deleteMessage } = vi.hoisted(() => ({
  createMessage: vi.fn(async () => ({ code: 0, data: { message_id: "om_model_wait" } })),
  deleteMessage: vi.fn(async () => ({ code: 0 })),
}));

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createFeishuClient: () => ({
    im: { message: { create: createMessage, delete: deleteMessage } },
  }),
}));

describe("Feishu model-wait card lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    { name: "wait-only card", previousText: "" },
    { name: "existing assistant and work progress", previousText: "Earlier answer." },
  ])("retracts a model wait before fallback output with $name", async ({ name, previousText }) => {
    const publishedTexts: unknown[] = [];
    vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async ({ url, init }) => {
      const path = new URL(url).pathname;
      if (typeof init?.body !== "string") {
        throw new Error("Expected a serialized Feishu request body");
      }
      const body: Record<string, unknown> = JSON.parse(init.body);
      if (path.endsWith("/elements/content/content")) {
        publishedTexts.push(body.content);
      }
      const data = path.includes("/auth/")
        ? { tenant_access_token: "owned-fixture-token", expire: 7200 }
        : { data: { card_id: "owned-model-wait-card" } };
      return {
        response: new Response(JSON.stringify({ code: 0, ...data }), {
          headers: { "content-type": "application/json" },
        }),
        finalUrl: url,
        release: async () => {},
      };
    });
    const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
      pluginId: "feishu",
      errorMessage: "Feishu runtime not initialized",
    });
    const previousRuntime = runtimeStore.tryGetRuntime();
    const runtime = createPluginRuntimeMock();
    Object.assign(runtime.channel.text, {
      resolveTextChunkLimit,
      resolveChunkMode,
      chunkTextWithMode,
      chunkMarkdownTextWithMode,
      convertMarkdownTables,
      resolveMarkdownTableMode: () => "preserve",
    });
    runtimeStore.setRuntime(runtime);
    const feishu = {
      enabled: true,
      appId: `owned-model-wait-${name}`,
      appSecret: "owned-fixture-secret",
      typingIndicator: false,
      renderMode: "card",
      streaming: { mode: "partial" },
    };
    const { dispatcherOptions: lifecycle, replyOptions: reply } = createFeishuReplyDispatcher({
      cfg: { channels: { feishu } },
      agentId: "main",
      chatId: "oc_owned_chat",
      sendTarget: "oc_owned_chat",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    const modelWait = (phase: "update" | "end", progressText?: string) =>
      reply.onItemEvent?.({
        itemId: "model-wait",
        kind: "model-wait",
        phase,
        progressText,
        suppressDurableProgress: true,
      });
    try {
      await lifecycle.onReplyStart?.();
      if (previousText) {
        reply.onPartialReply?.({ text: previousText });
        await reply.onItemEvent?.({
          itemId: "existing-work",
          kind: "tool",
          title: "Checking fixtures",
          progressText: "Looking up records",
        });
        await vi.advanceTimersByTimeAsync(160);
        expect(publishedTexts.at(-1)).toContain(previousText);
        expect(publishedTexts.at(-1)).toContain("Looking up records");
      }
      const waitText = "Waiting for the local model to respond";
      await modelWait("update", waitText);
      await vi.advanceTimersByTimeAsync(160);
      expect(publishedTexts.at(-1)).toContain(waitText);

      await modelWait("end");
      reply.onModelSelected?.({
        provider: "openai",
        model: "owned-fallback-model",
        thinkLevel: undefined,
      });
      await vi.advanceTimersByTimeAsync(160);
      if (previousText) {
        expect(publishedTexts.at(-1)).toContain(previousText);
        expect(publishedTexts.at(-1)).toContain("Looking up records");
        expect(publishedTexts.at(-1)).not.toContain(waitText);
        expect(deleteMessage).not.toHaveBeenCalled();
      } else {
        expect(deleteMessage).toHaveBeenCalledExactlyOnceWith({
          path: { message_id: "om_model_wait" },
        });
      }
    } finally {
      await lifecycle.onIdle?.();
      lifecycle.onCleanup?.();
      if (previousRuntime) {
        runtimeStore.setRuntime(previousRuntime);
      } else {
        runtimeStore.clearRuntime();
      }
    }
  });
});
