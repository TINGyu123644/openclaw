import { describe, expect, expectTypeOf, it } from "vitest";
import type { ChannelProgressDraftCompositorSnapshot } from "../channels/progress-draft-compositor.types.js";
import * as schemas from "./bundled-channel-config-schema.js";
import type {
  ChannelInboundEnvelopeInput,
  createChannelInboundEnvelopeBuilder as ChannelBuilder,
  createChannelInboundEnvelopeBuilderAsync as AsyncChannelBuilder,
  resolveChannelInboundRouteEnvelope as ChannelRoute,
  resolveInboundSessionEnvelopeContext as SessionContext,
  resolveInboundSessionEnvelopeContextAsync as AsyncSessionContext,
} from "./channel-inbound.js";
import type { inspectConversationBinding } from "./conversation-binding-inspection-runtime.js";
import type {
  createInboundEnvelopeBuilder as InboundBuilder,
  resolveInboundRouteEnvelopeBuilder as RouteBuilder,
  resolveInboundRouteEnvelopeBuilderWithRuntime as RuntimeRouteBuilder,
} from "./inbound-envelope.js";
import type { ReplyDispatchRuntimeInfo } from "./reply-runtime.js";
import type { PluginRuntime } from "./runtime-store.js";
import type {
  SessionBindingRecord as Binding,
  SessionBindingService as Bindings,
} from "./session-binding-runtime.js";
import type { readSessionUpdatedAt, readSessionUpdatedAtAsync } from "./session-store-runtime.js";
import {
  createLegacyCompatChannelDmPolicy,
  promptLegacyChannelAllowFromForAccount,
} from "./setup-runtime.js";
import type {
  AccountScopedConversationBindingManager as BindingManager,
  AccountScopedConversationBindingRecord as AccountBinding,
} from "./thread-bindings-runtime.js";

type RuntimeSession = PluginRuntime["channel"]["session"];
type Timestamp = number | undefined;
type TimestampCallback = (params: { storePath: string; sessionKey: string }) => Timestamp;
type EnvelopeBuilder = (input: ChannelInboundEnvelopeInput) => string;
type BuiltEnvelope = { storePath: string; body: string };

describe("shipped external channel compatibility", () => {
  it("retains the synchronous binding selectors shipped in 2026.9.8", () => {
    expectTypeOf<Bindings["listBySession"]>().toEqualTypeOf<
      (targetSessionKey: string) => Binding[]
    >();
    expectTypeOf<Bindings["resolveByConversation"]>().returns.toEqualTypeOf<Binding | null>();
    expectTypeOf<BindingManager["getByConversationId"]>().toEqualTypeOf<
      (conversationId: string) => AccountBinding | undefined
    >();
    expectTypeOf<typeof inspectConversationBinding>().returns.toEqualTypeOf<
      { status: "available"; binding: Binding | null } | { status: "unavailable" }
    >();
  });

  it("retains synchronous envelope results and timestamp callbacks shipped in 2026.9.8", () => {
    expectTypeOf<typeof readSessionUpdatedAt>().returns.toEqualTypeOf<Timestamp>();
    expectTypeOf<RuntimeSession["readSessionUpdatedAt"]>().returns.toEqualTypeOf<Timestamp>();
    expectTypeOf<typeof ChannelBuilder>().returns.toEqualTypeOf<EnvelopeBuilder>();
    expectTypeOf<
      ReturnType<typeof ChannelRoute>["buildEnvelope"]
    >().toEqualTypeOf<EnvelopeBuilder>();
    expectTypeOf<
      ReturnType<typeof SessionContext>["previousTimestamp"]
    >().toEqualTypeOf<Timestamp>();
    expectTypeOf<
      Parameters<typeof InboundBuilder>[0]["readSessionUpdatedAt"]
    >().toEqualTypeOf<TimestampCallback>();
    expectTypeOf<ReturnType<typeof InboundBuilder>>().returns.toEqualTypeOf<BuiltEnvelope>();
    expectTypeOf<
      ReturnType<typeof RouteBuilder>["buildEnvelope"]
    >().returns.toEqualTypeOf<BuiltEnvelope>();
    type RuntimeTimestampCallback = Parameters<
      typeof RuntimeRouteBuilder
    >[0]["runtime"]["session"]["readSessionUpdatedAt"];
    expectTypeOf<RuntimeTimestampCallback>().toEqualTypeOf<TimestampCallback>();
    expectTypeOf<
      ReturnType<typeof RuntimeRouteBuilder>["buildEnvelope"]
    >().returns.toEqualTypeOf<BuiltEnvelope>();
  });

  it("adds awaited timestamp preparation without changing released input shapes", () => {
    expectTypeOf<typeof readSessionUpdatedAtAsync>().returns.toEqualTypeOf<Promise<Timestamp>>();
    expectTypeOf<Parameters<typeof readSessionUpdatedAtAsync>>().toEqualTypeOf<
      Parameters<typeof readSessionUpdatedAt>
    >();
    expectTypeOf<RuntimeSession["readSessionUpdatedAtAsync"]>().returns.toEqualTypeOf<
      Promise<Timestamp>
    >();
    expectTypeOf<Parameters<RuntimeSession["readSessionUpdatedAtAsync"]>>().toEqualTypeOf<
      Parameters<RuntimeSession["readSessionUpdatedAt"]>
    >();
    expectTypeOf<Parameters<typeof AsyncChannelBuilder>>().toEqualTypeOf<
      Parameters<typeof ChannelBuilder>
    >();
    expectTypeOf<typeof AsyncChannelBuilder>().returns.toEqualTypeOf<Promise<EnvelopeBuilder>>();
    expectTypeOf<Parameters<typeof AsyncSessionContext>>().toEqualTypeOf<
      Parameters<typeof SessionContext>
    >();
    expectTypeOf<typeof AsyncSessionContext>().returns.toEqualTypeOf<
      Promise<ReturnType<typeof SessionContext>>
    >();
  });

  it("retains named config schema exports used by published channel packages", () => {
    for (const schema of [
      schemas.SlackConfigSchema,
      schemas.DiscordConfigSchema,
      schemas.SignalConfigSchema,
      schemas.MSTeamsConfigSchema,
    ]) {
      expect(schema.safeParse({ legacySetting: true })).toMatchObject({ success: true });
      expect(schema.toJSONSchema({ target: "draft-07" })).toMatchObject({ type: "object" });
    }
  });

  it("retains setup helpers used by published Slack and Discord packages", () => {
    expect(createLegacyCompatChannelDmPolicy).toBeTypeOf("function");
    expect(promptLegacyChannelAllowFromForAccount).toBeTypeOf("function");
  });

  it("keeps the 2026.9.8 receipt progress handoff source-compatible", () => {
    type ReleasedReceipt = {
      channel: string;
      accountId?: string;
      to: string;
      threadId?: string | number;
      messageId: string;
      text: string;
      snapshot: ChannelProgressDraftCompositorSnapshot;
    };
    expectTypeOf<ReplyDispatchRuntimeInfo["adoptProgressContinuation"]>().toEqualTypeOf<
      ((this: void, receipt: ReleasedReceipt) => Promise<boolean>) | undefined
    >();
  });
});
