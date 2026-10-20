import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { SubagentRegistryWriteError } from "../../agents/subagents/registry/subagent-registry-persistence.js";
import type * as SubagentRegistry from "../../agents/subagents/registry/subagent-registry.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { markAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";
import { accountAgentTurn } from "./agent-runner-result-accounting.js";
import { createTestFinalizationContext } from "./agent-runner-result-accounting.persistence.test-support.js";
import { prepareReplyAgentPayloads } from "./agent-runner-result-payloads.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import type { PendingContinuationSettlement } from "./get-reply.types.js";
import type { AdmittedFollowupTurn } from "./reply-agent-turn-preparation.js";
import { createMockFollowupRun } from "./test-helpers.js";
vi.mock("../../agents/subagents/registry/subagent-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SubagentRegistry>()),
  settleRequesterAfterSessionSpawns: settleRequester,
}));
const settleRequester = vi.hoisted(() =>
  vi.fn<typeof SubagentRegistry.settleRequesterAfterSessionSpawns>(async () => true),
);

const runId = "waiting-progress-run";
type ResultMeta = FinalizeReplyAgentRunInput["execution"]["result"]["meta"];

function createContext(meta: Partial<ResultMeta> = { yielded: true }): FinalizeReplyAgentRunInput {
  const sessionKey = "agent:main:waiting-progress";
  const followupRun = createMockFollowupRun({
    originatingChannel: "discord",
    run: { sessionKey, messageProvider: "discord", terminalReplyExpectation: "required" },
  });
  const replyOperation = createReplyOperation({
    sessionKey,
    sessionId: followupRun.run.sessionId,
    resetTriggered: false,
  });
  onTestFinished(() => replyOperation.complete());
  const context = createTestFinalizationContext(followupRun, replyOperation);
  return {
    ...context,
    activeSessionStore: undefined,
    cfg: {},
    replyToChannel: "discord",
    execution: {
      ...context.execution,
      result: {
        payloads: [],
        meta: { durationMs: 0, ...meta },
        acceptedSessionSpawns: [
          {
            runId: "index-worker-run",
            childSessionKey: "agent:main:subagent:index-worker",
            expectsCompletionMessage: true,
          },
        ],
      },
    },
    runId,
    sessionCtx: { Provider: "discord", Surface: "discord", To: "channel:C1" },
  };
}

function captureContinuation(context: FinalizeReplyAgentRunInput) {
  const pending = vi.fn<(settlement?: PendingContinuationSettlement) => void>();
  context.opts = { onPendingContinuation: pending };
  return {
    pending,
    settlement: () => expectDefined(pending.mock.calls[0]?.[0], "continuation settlement"),
  };
}

async function prepareContinuation(meta: Partial<ResultMeta> = { continuationPending: true }) {
  const context = createContext(meta);
  const capture = captureContinuation(context);
  expect(await prepare("ordinary", context)).toEqual([]);
  return { context, ...capture, settlement: capture.settlement() };
}

async function prepare(lane: "ordinary" | "queued", context: FinalizeReplyAgentRunInput) {
  const accounting = await accountAgentTurn(context);
  if (lane === "ordinary") {
    const prepared = await prepareReplyAgentPayloads({ context, accounting });
    return prepared.kind === "continue"
      ? prepared.guardedReplyPayloads
      : prepared.value
        ? [prepared.value]
        : [];
  }
  const turn: AdmittedFollowupTurn = {
    runId,
    queued: context.followupRun,
    operation: context.replyOperation,
    config: context.cfg,
    session: {
      kind: "session",
      key: expectDefined(context.followupRun.run.sessionKey, "queued requester session"),
      current: () => undefined,
      publish: () => undefined,
    },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
  };
  const decision = await resolveFollowupDeliveryDecision({
    turn,
    execution: { runId, outcome: context.execution },
    accounting,
    opts: { ...context.opts, isHeartbeat: context.isHeartbeat },
  });
  return decision.kind === "deliver" ? decision.payloads : [];
}

beforeEach(() => {
  settleRequester.mockReset().mockImplementation(async (params) => {
    params.assertCurrent?.();
    await Promise.resolve();
    params.assertCurrent?.();
    return true;
  });
});

it("delivers an ordinary terminal failure", async () => {
  const context = createContext({});
  context.execution.result.acceptedSessionSpawns = undefined;
  context.execution = {
    ...context.execution,
    status: "failed",
    terminalFailurePayload: markAgentRunFailureReplyPayload({ text: "Terminal failure" }),
  };
  expect(await prepare("ordinary", context)).toMatchObject([
    { text: "Terminal failure", isError: true },
  ]);
});

const blockedText = "Blocked by before_agent_run policy";
it.each([
  ["silent", { terminalReply: { disposition: "silent" } }, true],
  ["message-tool sentinel", { finalAssistantRawText: "NO_REPLY" }, true],
  [
    "hook block",
    {
      livenessState: "blocked",
      finalAssistantRawText: blockedText,
      error: { kind: "hook_block", message: blockedText },
    },
    false,
  ],
] as const)("captures only model text: %s", async (kind, meta, optional) => {
  const context = createContext(meta);
  const onRawLlmResponse = vi.fn();
  context.opts = { onRawLlmResponse };
  if (optional) {
    context.followupRun.run.terminalReplyExpectation = "optional";
    context.execution.result.acceptedSessionSpawns = undefined;
  }
  if (kind === "message-tool sentinel") {
    context.execution.result.messagingToolSourceReplyPayloads = [
      { text: "delivered by message tool", sourceReplyFinal: true },
    ];
  }
  const payloads = await prepare("ordinary", context);
  if (optional) {
    expect(payloads).toEqual([]);
  }
  expect(onRawLlmResponse.mock.calls).toEqual(
    kind === "message-tool sentinel" ? [["NO_REPLY"]] : [],
  );
});

describe.each(["ordinary", "queued"] as const)("%s waiting status delivery", (lane) => {
  it.each(["explicit acknowledgment", "visible final", "optional turn", "delivered message"])(
    "selects waiting status for %s",
    async (selection) => {
      const context = createContext();
      const onPendingContinuation = vi.fn<(settlement?: PendingContinuationSettlement) => void>();
      if (selection === "explicit acknowledgment" || selection === "visible final") {
        context.opts = { onPendingContinuation };
      }
      const selected = { text: `${selection} selected` };
      if (selection === "optional turn") {
        context.followupRun.run.terminalReplyExpectation = "optional";
      } else if (selection === "delivered message") {
        context.execution.result.didDeliverSourceReplyViaMessageTool = true;
      } else if (selection === "explicit acknowledgment") {
        context.execution.result.meta.yieldAcknowledgment = ` ${selected.text} `;
        context.execution.result.payloads = [{ text: "Private plan", isReasoning: true }];
        if (lane === "queued") {
          context.followupRun.originatingChatType = "group";
          context.followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
          context.execution.result.payloads.push({ text: "Private partial output" });
        }
      } else {
        context.execution.result.meta.yieldAcknowledgment = "Still waiting.";
        context.execution.result.payloads = [selected];
      }
      const payloads = await prepare(lane, context);
      if (selection === "optional turn" || selection === "delivered message") {
        expect(payloads).toEqual([]);
        return;
      }
      expect(payloads.map((payload) => payload.text)).toEqual([selected.text]);
      if (selection === "explicit acknowledgment") {
        expect(getReplyPayloadMetadata(payloads[0] ?? {})).toMatchObject({
          continuationStatus: true,
          deliverDespiteSourceReplySuppression: true,
        });
        if (lane === "ordinary") {
          expect(onPendingContinuation.mock.calls).toEqual([[]]);
        }
      }
    },
  );
});

it.each([true, false])(
  "settles an implicit continuation once after delivery=%s",
  async (delivered) => {
    const context = createContext({
      continuationPending: true,
      yieldAcknowledgment: " ",
    });
    const { pending, settlement: getSettlement } = captureContinuation(context);
    context.execution.directBlockDeliveries = [
      { payload: { text: "Unpublished draft" }, outcome: "delivered-not-visible", pending: true },
    ];

    expect(await prepare("ordinary", context)).toEqual([]);

    expect(settleRequester).not.toHaveBeenCalled();
    expect(pending).toHaveBeenCalledOnce();
    const settlement = getSettlement();
    await Promise.all([settlement.settle(delivered), settlement.settle(!delivered)]);
    expect(settleRequester).toHaveBeenCalledOnce();
    expect(settleRequester.mock.calls[0]?.[0]).toMatchObject({
      requesterYielded: delivered,
    });
    await settlement.settle(!delivered);
    expect(settleRequester).toHaveBeenCalledOnce();
  },
);

it.each(["ordinary", "queued"] as const)(
  "keeps a %s unauthored waiting status silent while a result is required",
  async (lane) => {
    const context = createContext({ continuationPending: true });
    context.followupRun.run.terminalReplyExpectation = "result-required";

    expect(await prepare(lane, context)).toEqual([]);
  },
);

it.each(["delivered", "cancelled", "aborted"] as const)(
  "settles an explicitly silent child continuation after %s",
  async (outcome) => {
    const { context, settlement } = await prepareContinuation({
      continuationPending: true,
      finalAssistantRawText: "NO_REPLY",
      terminalReply: { disposition: "silent" },
    });
    if (outcome === "aborted") {
      expect(context.replyOperation.abortByUser()).toBe(true);
    }
    await settlement.settle(outcome !== "cancelled");
    expect(settleRequester).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ requesterYielded: outcome === "delivered" }),
    );
  },
);

it.each(["refusal", "persistence failure"] as const)(
  "releases an implicit continuation after settlement %s",
  async (failure) => {
    const { settlement } = await prepareContinuation();
    settleRequester.mockImplementationOnce(async () => {
      if (failure === "persistence failure") {
        throw new Error("native settlement persistence failed");
      }
      return false;
    });

    await expect(Promise.all([settlement.settle(true), settlement.settle(true)])).rejects.toThrow(
      failure === "persistence failure"
        ? "native settlement persistence failed"
        : "accepted continuation children could not transfer terminal delivery",
    );
    expect(settleRequester).toHaveBeenCalledOnce();

    await settlement.settle(false);
    expect(settleRequester.mock.calls.map(([params]) => params.requesterYielded)).toEqual([
      true,
      false,
    ]);
    await settlement.settle(true);
    expect(settleRequester).toHaveBeenCalledTimes(2);
  },
);

it.each(["committed", "unknown"] as const)(
  "retains the %s settlement outcome when finalization requests non-yielded compensation",
  async (outcome) => {
    const { settlement } = await prepareContinuation();
    const failure = new SubagentRegistryWriteError(
      outcome,
      new Error("native outcome retained"),
      outcome === "committed" ? "published" : undefined,
    );
    settleRequester.mockRejectedValueOnce(failure);
    const first = settlement.settle(true);
    await expect(first).rejects.toBe(failure);
    const compensation = settlement.settle(false);
    expect(compensation).toBe(first);
    await expect(compensation).rejects.toBe(failure);
    expect(settleRequester).toHaveBeenCalledOnce();
  },
);

it.each(["replacement", "rebound key", "rebound session", "retained abort"] as const)(
  "settles the captured outbox after %s only while its original reply owner remains current",
  async (change) => {
    const { context, settlement } = await prepareContinuation();
    const operation = context.replyOperation;
    if (change === "replacement") {
      operation.complete();
      const replacement = createReplyOperation({
        sessionKey: operation.key,
        sessionId: operation.sessionId,
        resetTriggered: false,
      });
      onTestFinished(() => replacement.complete());
    } else if (change === "rebound key") {
      operation.updateSessionKey("agent:main:rebound-outbox");
    } else if (change === "rebound session") {
      operation.updateSessionId("rebound-outbox-session");
    } else {
      expect(operation.abortByUser()).toBe(true);
    }
    if (change === "retained abort") {
      await settlement.settle(false);
      expect(settleRequester).toHaveBeenCalledOnce();
      expect(settleRequester.mock.calls[0]?.[0].requesterYielded).toBe(false);
    } else {
      await expect(settlement.settle(false)).rejects.toThrow("original reply operation");
      expect(settleRequester).not.toHaveBeenCalled();
    }
  },
);
