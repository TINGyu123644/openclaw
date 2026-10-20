import { describe, expect, it } from "vitest";
import {
  buildThreadAwareOutboundSessionRoute,
  recoverCurrentThreadSessionId,
  type ChannelOutboundSessionRoute,
} from "./core.js";

const baseSessionKey = "agent:main:workspace:channel:c123";
const currentSessionKey = `${baseSessionKey}:thread:current-1`;
function baseRoute(
  overrides: Partial<ChannelOutboundSessionRoute> = {},
): ChannelOutboundSessionRoute {
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer: { kind: "channel", id: "c123" },
    chatType: "channel",
    from: "workspace:channel:c123",
    to: "channel:c123",
    ...overrides,
  };
}

describe("buildThreadAwareOutboundSessionRoute", () => {
  it("uses replyToId before threadId and recovered current-session thread by default", () => {
    const route = buildThreadAwareOutboundSessionRoute({
      route: baseRoute(),
      replyToId: "reply-1",
      threadId: "thread-1",
      currentSessionKey,
    });

    expect(route).toEqual(
      baseRoute({ sessionKey: `${baseSessionKey}:thread:reply-1`, threadId: "reply-1" }),
    );
  });

  it("keeps numeric delivery thread ids on the route while stringifying the session suffix", () => {
    const route = buildThreadAwareOutboundSessionRoute({ route: baseRoute(), threadId: 99 });
    expect(route).toEqual(baseRoute({ sessionKey: `${baseSessionKey}:thread:99`, threadId: 99 }));
  });

  it("recovers a current-session thread only when the base session matches", () => {
    expect(recoverCurrentThreadSessionId({ route: baseRoute(), currentSessionKey })).toBe(
      "current-1",
    );
    expect(
      recoverCurrentThreadSessionId({
        route: baseRoute(),
        currentSessionKey: "agent:main:workspace:channel:other:thread:current-1",
      }),
    ).toBeUndefined();
  });

  it("does not recover current-session threads across case-distinct Matrix rooms", () => {
    const matrixKey = "agent:main:matrix:channel:!Mixed:example.org";
    const route = baseRoute({
      sessionKey: matrixKey,
      baseSessionKey: matrixKey,
      peer: { kind: "channel", id: "!Mixed:example.org" },
      from: "matrix:room:!Mixed:example.org",
      to: "room:!Mixed:example.org",
    });

    expect(
      recoverCurrentThreadSessionId({
        route,
        currentSessionKey: "agent:main:matrix:channel:!mixed:example.org:thread:$Root",
      }),
    ).toBeUndefined();
  });

  it("lets providers veto current-session recovery", () => {
    const route = buildThreadAwareOutboundSessionRoute({
      route: baseRoute(),
      currentSessionKey,
      canRecoverCurrentThread: () => false,
    });

    expect(route).toEqual(baseRoute());
  });
});
