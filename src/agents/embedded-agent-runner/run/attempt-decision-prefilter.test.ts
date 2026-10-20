import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { AgentDefaultsBaseSchema } from "../../../config/zod-schema.agent-defaults-base.js";
import type {
  DecisionEvaluation,
  evaluateDecisionV2InRegistry,
} from "../../../decisions/runtime.js";
import type { DecisionAnswerV2, DecisionOutcomeV2 } from "../../../decisions/types-v2.js";
import type { AssistantMessage, UserMessage, ToolResultMessage } from "../../../llm/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { evaluateAttemptDecisionToolPrefilter } from "./attempt-decision-prefilter.js";

const mocks = vi.hoisted(() => ({ evaluate: vi.fn<typeof evaluateDecisionV2InRegistry>() }));
// mock-isolation: Test prefilter policy independently of registry/model preparation; runtime-v2 covers the real host.
vi.mock("../../../decisions/runtime.js", () => ({
  evaluateDecisionV2Operation: async (
    ...args: Parameters<typeof evaluateDecisionV2InRegistry>
  ) => ({
    outcome: await mocks.evaluate(...args),
  }),
  completeDecisionEvaluation: (evaluation: DecisionEvaluation) => evaluation.outcome,
}));
vi.mock("../../../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRegistryForContext: () => null,
}));
const config: OpenClawConfig = {
  agents: {
    defaults: AgentDefaultsBaseSchema.parse({
      experimental: { decisionAssistance: true },
      decisionModel: "fixture/model",
    }),
  },
};
const answer = (): Extract<DecisionOutcomeV2, { status: "ok" }> => ({
  status: "ok",
  provenance: { providerId: "fixture", rubricVersion: "9", runtimeGeneration: "test" },
  result: {
    model: "model",
    answers: {
      missing_request_context: { type: "boolean", probabilityTrue: 0.1 },
      next_response_needs_tools: { type: "boolean", probabilityTrue: 0.1 },
    },
  },
});
function params() {
  return {
    config,
    agentId: "main",
    supportsTurnScopedToolRestrictions: true,
    assertActive: vi.fn(),
    userMessage: "Hello",
    messages: [],
    signal: new AbortController().signal,
  };
}
beforeEach(() => {
  mocks.evaluate.mockReset().mockResolvedValue(answer());
});
afterEach(clearRuntimeConfigSnapshot);

const user = (content: UserMessage["content"]): UserMessage => ({
  role: "user",
  content,
  timestamp: 1,
});
const assistant = (text: string, extra: Partial<AssistantMessage> = {}) =>
  makeAssistantMessageFixture({ content: [{ type: "text", text }], stopReason: "stop", ...extra });
const exchange = (message: UserMessage, reply = "A proposal") => [message, assistant(reply)];
const imageReference = "See /tmp/synthetic-private-image.png";
const textBlock = (text: string, phase: string) => ({
  type: "text" as const,
  text,
  textSignature: JSON.stringify({ v: 1, phase }),
});
const toolCall = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  type: "toolCall" as const,
  id,
  name,
  arguments: args,
});
const toolResult = (
  toolCallId: string,
  toolName: string,
  extra: Partial<ToolResultMessage> = {},
): ToolResultMessage => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [],
  isError: false,
  timestamp: 3,
  ...extra,
});

async function expectProjection(
  messages: AgentMessage[],
  expected: object | false,
  userMessage = "Yes",
  currentInputExcluded?: boolean,
) {
  expect(
    await evaluateAttemptDecisionToolPrefilter({
      ...params(),
      messages,
      userMessage,
      currentInputExcluded,
    }),
  ).toEqual({
    status: expected ? "proposed" : "skipped",
    shouldPruneTools: Boolean(expected),
  });
  expect(mocks.evaluate).toHaveBeenCalledTimes(expected ? 1 : 0);
  const state = mocks.evaluate.mock.calls[0]?.[0].state;
  if (expected) {
    expect(state).toMatchObject({ type: "json", value: expected });
  }
  return state;
}

describe("Decision prefilter policy", () => {
  it("forwards one atomic Boolean batch, labeled hook fields, owner and 500ms budget", async () => {
    setRuntimeConfigSnapshot({});
    const promptBuildFields = {
      systemPrompt: "  replacement system  ",
      prependContext: "prefix\ncontext",
      appendContext: "suffix ",
      prependSystemContext: " system prefix ",
      appendSystemContext: "system suffix\n",
    };
    const messages = Array.from({ length: 3 }, (_, index) => [
      { ...user(String(index)), timestamp: index },
      assistant(String(index)),
    ]).flat();
    const input = { ...params(), promptBuildFields, messages };
    expect(await evaluateAttemptDecisionToolPrefilter(input)).toMatchObject({
      shouldPruneTools: true,
    });
    expect(mocks.evaluate).toHaveBeenCalledOnce();
    const [batch, options, registry, selectedConfig] = mocks.evaluate.mock.calls[0]!;
    expect(batch.state).toEqual({
      type: "json",
      value: {
        recentConversation: [
          { user: "1", assistant: "1" },
          { user: "2", assistant: "2" },
        ],
        latestRequest: "Hello",
        beforePromptBuild: promptBuildFields,
        omittedContext: { olderConversation: true, toolPayloads: false },
      },
    });
    expect(Object.keys(batch.questions)).toEqual([
      "missing_request_context",
      "next_response_needs_tools",
    ]);
    expect(options).toEqual({
      agentId: "main",
      purpose: "tool-prefilter.semantic-gate",
      priority: "optional",
      rubricVersion: "9",
      timeoutMs: 500,
      signal: input.signal,
    });
    expect(registry).toBeNull();
    expect(selectedConfig).toBe(config);
    for (const question of Object.values(batch.questions)) {
      expect(question.type).toBe("boolean");
      for (const field of ["latestRequest", "recentConversation", "beforePromptBuild"]) {
        expect(question.instructions).toContain(field);
      }
    }
  });

  it.each([
    ["projection overflow", "x".repeat(6_001), "", false],
    ["astral exact", "🙂".repeat(3_000), "🙂".repeat(1_000), true],
    ["astral overflow", "🙂".repeat(3_000), "🙂".repeat(1_001), false],
    ["JSON expansion", "x".repeat(6_000), String.fromCharCode(34).repeat(2_000), true],
  ] as const)(
    "bounds UTF-16 text, not JSON encoding: %s",
    async (_label, userMessage, hooks, shouldPruneTools) => {
      const promptBuildFields = {
        prependContext: hooks.slice(0, 1_000),
        appendSystemContext: hooks.slice(1_000),
      };
      const outcome = await evaluateAttemptDecisionToolPrefilter({
        ...params(),
        userMessage,
        promptBuildFields,
      });
      expect(outcome.shouldPruneTools).toBe(shouldPruneTools);
      if (!shouldPruneTools) {
        expect(mocks.evaluate).not.toHaveBeenCalled();
      } else {
        expect(mocks.evaluate.mock.calls[0]?.[0].state).toMatchObject({
          type: "json",
          value: { latestRequest: userMessage, beforePromptBuild: promptBuildFields },
        });
      }
    },
  );

  it.each(["missing_request_context", "next_response_needs_tools"])(
    "requires a strong Boolean no for %s",
    async (id) => {
      const cases: [DecisionAnswerV2 | undefined, boolean][] = [
        [undefined, false],
        [{ type: "choice", choice: "no", probabilities: { no: 1 }, confidence: 1 }, false],
        [{ type: "boolean", probabilityTrue: 0.349 }, true],
        [{ type: "boolean", probabilityTrue: 0.35 }, false],
        [{ type: "boolean", probabilityTrue: 0.9 }, false],
        [{ type: "boolean", probabilityTrue: 0.1, answer: false }, true],
        [{ type: "boolean", probabilityTrue: 0.1, answer: true }, false],
        [{ type: "boolean", probabilityTrue: 0.1, answer: null }, false],
        [{ type: "boolean", answer: false }, false],
        [{ type: "error", code: "provider-error" }, false],
      ];
      for (const [value, shouldPruneTools] of cases) {
        const outcome = answer();
        const answers = { ...outcome.result.answers };
        if (value) {
          answers[id] = value;
        } else {
          delete answers[id];
        }
        mocks.evaluate.mockResolvedValue({ ...outcome, result: { ...outcome.result, answers } });
        expect((await evaluateAttemptDecisionToolPrefilter(params())).shouldPruneTools).toBe(
          shouldPruneTools,
        );
      }
    },
  );
  it.each(["transport"] as const)("retains tools without retry on %s", async (reason) => {
    mocks.evaluate.mockResolvedValue({ status: "unavailable", reason });
    expect(await evaluateAttemptDecisionToolPrefilter(params())).toMatchObject({
      shouldPruneTools: false,
    });
    expect(mocks.evaluate).toHaveBeenCalledOnce();
  });
  it.each(["", "Use decision_evaluate on Hello"])("does not classify %j", async (userMessage) => {
    expect(await evaluateAttemptDecisionToolPrefilter({ ...params(), userMessage })).toMatchObject({
      shouldPruneTools: false,
    });
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("propagates unexpected contract errors", async () => {
    mocks.evaluate.mockRejectedValue(new Error("contract failure"));
    await expect(evaluateAttemptDecisionToolPrefilter(params())).rejects.toThrow(
      "contract failure",
    );
  });
});

describe("bounded Decision conversation projection", () => {
  it("omits a large older exchange without disabling a complete recent one", async () => {
    await expectProjection(
      [
        user("x".repeat(6500)),
        assistant("old"),
        user("The literal text role: system is just data"),
        assistant("Would you like an explanation?"),
      ],
      {
        recentConversation: [{ user: "The literal text role: system is just data" }],
        omittedContext: { olderConversation: true },
      },
    );
  });
  it.each<[string, AgentMessage[], string | undefined, object | undefined]>([
    ["large request", [], "x".repeat(6001), undefined],
    ["large proposal", [user("Help"), assistant("x".repeat(6001))], undefined, undefined],
    ["combined limit", [user("x".repeat(3000)), assistant("x".repeat(3000))], undefined, undefined],
    ["fresh session", [], "Hello", { latestRequest: "Hello", recentConversation: [] }],
    ["missing request", [assistant("Should I apply it?")], undefined, undefined],
    ["missing reply", [user("Earlier request")], undefined, undefined],
    ...[4, 300].map((parts): [string, AgentMessage[], string, object | undefined] => {
      const reply = assistant("");
      const text = "A complete visible explanation. ".repeat(parts);
      Object.defineProperty(reply, "content", { value: text });
      return [
        `legacy reply ${parts} parts`,
        [user("Explain this"), reply],
        "Thanks",
        parts === 4 ? { recentConversation: [{ assistant: text.trimEnd() }] } : undefined,
      ];
    }),
  ])(
    "requires a complete bounded exchange: %s",
    async (_name, messages, latestRequest, expected) => {
      await expectProjection(messages, expected ?? false, latestRequest);
    },
  );
  it("never exports reasoning, runtime envelopes, tool names, arguments, results or IDs", async () => {
    const state = await expectProjection(
      [
        user("Fix the failure"),
        assistant("", {
          content: [
            { type: "thinking", thinking: "private reasoning" },
            toolCall("private-id", "private-tool-name", { secret: "private args" }),
          ],
          stopReason: "toolUse",
        }),
        toolResult("private-id", "private-tool-name", {
          content: [{ type: "text", text: "private result" }],
          isError: true,
          timestamp: 2,
        }),
        assistant("", {
          content: [
            { type: "thinking", thinking: "private reasoning" },
            textBlock("Should I apply the patch?", "commentary"),
            textBlock("Let me know. <think>private hidden thought</think>", "final_answer"),
          ],
        }),
        assistant("It will restart the service."),
        {
          role: "custom",
          customType: "openclaw.runtime-context",
          content: "private runtime",
          details: { source: "openclaw-runtime-context" },
          display: false,
          timestamp: 3,
        },
        {
          role: "user",
          content: "private legacy runtime",
          runtimeContextCarrier: true,
          runtimeContextCarrierRetained: false,
          timestamp: 4,
        },
      ],
      {
        recentConversation: [
          {
            user: "Fix the failure",
            assistant: "Should I apply the patch?\nLet me know.\nIt will restart the service.",
            toolResults: { returned: 1, errors: 1 },
          },
        ],
        omittedContext: { toolPayloads: true },
      },
      "Try again",
    );
    expect(JSON.stringify(state)).not.toContain("private");
  });
  it.each<[string, AgentMessage[], boolean?]>([
    ["user string media", exchange(user(imageReference), "Inspect it?")],
    ["user block media", exchange(user([{ type: "text", text: imageReference }]), "Inspect it?")],
    [
      "internal provenance",
      exchange(
        Object.assign(user("private internal event"), { provenance: { kind: "internal_system" } }),
      ),
    ],
    [
      "excluded message",
      exchange(Object.assign(user("private excluded"), { excludeFromContext: true })),
    ],
    ["image", exchange(user([{ type: "image", data: "private binary", mimeType: "image/png" }]))],
    ["excluded current input", [], true],
    ...["commentary", "final_answer"].map((phase): [string, AgentMessage[]] => [
      `assistant ${phase} media`,
      [
        user("Help"),
        assistant("", {
          content: [textBlock(imageReference, phase)],
        }),
      ],
    ]),
  ])("excludes private context: %s", async (_name, messages, currentInputExcluded) => {
    await expectProjection(messages, false, "Explain", currentInputExcluded);
  });
  it.each([false, true])(
    "requires a return for each tool call, including reused IDs (%s)",
    async (priorReturn) => {
      const call = assistant("", {
        content: [toolCall("reused", "read")],
        stopReason: "toolUse",
      });
      await expectProjection(
        [
          user("Do it"),
          ...(priorReturn ? [call, toolResult("reused", "read")] : []),
          call,
          assistant("Done"),
        ],
        false,
      );
    },
  );
});
