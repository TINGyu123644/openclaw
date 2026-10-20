import { buildOpenAICompletionsParams } from "@openclaw/ai/transports";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import deepinfraPlugin from "./index.js";

function makeModel(id: string, api: Model["api"] = "openai-completions"): Model {
  return {
    api,
    id,
    provider: "deepinfra",
    name: "Synthetic model",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

const conversation = (content: unknown) => ({
  messages: [
    { role: "system", content },
    { role: "user", content: "Hi" },
  ],
});
const cachedText = (text: string) => ({
  type: "text",
  text,
  cache_control: { type: "ephemeral" },
});

async function registeredWrapper(base: StreamFn, modelId: string, cacheRetention?: string) {
  const provider = await registerSingleProviderPlugin(deepinfraPlugin);
  const wrapped = provider.wrapStreamFn?.({
    provider: "deepinfra",
    modelId,
    streamFn: base,
    extraParams: { cacheRetention },
  });
  if (!wrapped) {
    throw new Error("DeepInfra stream wrapper missing");
  }
  return wrapped;
}

async function capturePayload(params: {
  modelId: string;
  api?: "openai-completions" | "anthropic-messages";
  initialPayload: Record<string, unknown>;
  cacheRetention?: "none" | "short" | "long";
}) {
  let captured: Record<string, unknown> = {};
  let baseCalls = 0;
  let baseCacheRetention: unknown;
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    baseCalls += 1;
    baseCacheRetention = options?.cacheRetention;
    const payload = structuredClone(params.initialPayload);
    options?.onPayload?.(payload, _model);
    captured = payload;
    return createAssistantMessageEventStream();
  };

  const wrapped = await registeredWrapper(baseStreamFn, params.modelId, params.cacheRetention);
  void wrapped(makeModel(params.modelId, params.api), { messages: [] }, {});

  return { captured, baseCalls, baseCacheRetention };
}

describe("registered DeepInfra cache wrapper", () => {
  it.each([
    {
      modelId: "Anthropic/Claude-Sonnet-4-6",
      content: "system",
      expected: [cachedText("system")],
    },
    {
      modelId: "anthropic/claude-haiku-4-5",
      content: [
        { type: "text", text: "Block one" },
        { type: "text", text: "Block two" },
      ],
      expected: [{ type: "text", text: "Block one" }, cachedText("Block two")],
    },
  ])(
    "tags the final system block and user message for $modelId",
    async ({ modelId, content, expected }) => {
      const { captured, baseCalls } = await capturePayload({
        modelId,
        initialPayload: conversation(content),
      });
      expect(baseCalls).toBe(1);
      expect(captured.messages).toEqual([
        { role: "system", content: expected },
        { role: "user", content: [cachedText("Hi")] },
      ]);
    },
  );

  it.each(["none", "long"] as const)(
    "honors configured %s retention without inventing TTL support",
    async (cacheRetention) => {
      const { captured } = await capturePayload({
        modelId: "anthropic/claude-sonnet-4-6",
        cacheRetention,
        initialPayload: conversation("system"),
      });
      expect(JSON.stringify(captured).match(/"cache_control":/g) ?? []).toHaveLength(
        cacheRetention === "none" ? 0 : 2,
      );
      expect(JSON.stringify(captured)).not.toContain('"ttl"');
    },
  );

  it.each([
    { cacheRetention: "none", requiresStringContent: false },
    { cacheRetention: "short", requiresStringContent: true },
  ] as const)(
    "composes managed requests with $cacheRetention retention and string-only=$requiresStringContent",
    async ({ cacheRetention, requiresStringContent }) => {
      const model: Model<"openai-completions"> & {
        compat: { requiresStringContent: boolean };
      } = {
        ...makeModel("anthropic/claude-sonnet-4-6"),
        api: "openai-completions",
        compat: { requiresStringContent },
      };
      let payload: Record<string, unknown> = {};
      const base: StreamFn = (resolvedModel, context, options) => {
        payload = buildOpenAICompletionsParams(resolvedModel, context, {
          cacheRetention: options?.cacheRetention,
        });
        options?.onPayload?.(payload, resolvedModel);
        return createAssistantMessageEventStream();
      };
      const wrapped = await registeredWrapper(base, model.id, cacheRetention);
      void wrapped(model, {
        systemPrompt: "STABLE",
        messages: [{ role: "user", content: "Question", timestamp: 1 }],
      });
      expect(JSON.stringify(payload)).not.toContain("cache_control");
      expect(payload.messages).toEqual([
        { role: "system", content: "STABLE" },
        { role: "user", content: "Question" },
      ]);
    },
  );

  it("preserves native Anthropic Messages payloads and options", async () => {
    const initialPayload = {
      system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "question" }] }],
    };
    const { captured, baseCacheRetention } = await capturePayload({
      modelId: "anthropic/claude-sonnet-4-6",
      api: "anthropic-messages",
      cacheRetention: "long",
      initialPayload,
    });
    expect(captured).toEqual(initialPayload);
    expect(baseCacheRetention).toBeUndefined();
  });

  it("does not mutate payloads for non-anthropic model ids", async () => {
    const initialPayload = conversation("sys");
    const { captured, baseCalls, baseCacheRetention } = await capturePayload({
      modelId: "deepseek-ai/DeepSeek-V4-Flash",
      initialPayload,
    });

    expect(baseCalls).toBe(1);
    expect(captured).toEqual(initialPayload);
    expect(baseCacheRetention).toBeUndefined();
  });
});
