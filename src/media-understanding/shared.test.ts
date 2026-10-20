import {
  MAX_DATE_TIMESTAMP_MS,
  MAX_TIMER_TIMEOUT_MS,
} from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../version.js";

const { fetchWithSsrFGuardMock, shouldUseEnvHttpProxyForUrlMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn<typeof import("../infra/net/fetch-guard.js").fetchWithSsrFGuard>(),
  shouldUseEnvHttpProxyForUrlMock: vi.fn(() => false),
}));

vi.mock("../infra/net/fetch-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

vi.mock("../infra/net/proxy-env.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/proxy-env.js")>(
    "../infra/net/proxy-env.js",
  );
  return {
    ...actual,
    shouldUseEnvHttpProxyForUrl: shouldUseEnvHttpProxyForUrlMock,
  };
});

import { postJsonResponse } from "./provider-json-post.js";
import {
  createProviderOperationDeadline,
  fetchProviderDownloadResponse,
  fetchWithTimeoutGuarded,
  pollProviderOperationJson,
  postJsonRequest,
  postMultipartRequest,
  postTranscriptionRequest,
  resolveProviderHttpRequestConfig,
  resolveProviderHttpRequestConfigWithOriginTrust,
  resolveProviderOperationTimeoutMs,
  waitProviderOperationPollInterval,
} from "./shared.js";

describe("JSON submission response ownership", () => {
  it.each([
    ['{"id":"job-1"}', 200, true, undefined, { id: "job-1" }],
    ['["job-1"]', 200, false, undefined, ["job-1"]],
    ["[]", 200, true, "response: malformed JSON response", undefined],
    ["{", 200, false, "response: malformed JSON response", undefined],
    ['{"error":"bad request"}', 400, false, "submission", undefined],
  ] as const)(
    "releases the response for %s (%i, object=%s)",
    async (body, status, objectResponse, error, expected) => {
      const release = queueGuardedResponse(new Response(body, { status }));
      const params = {
        url: "https://provider.example/jobs",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: { prompt: "Synthetic submission" },
        fetchFn: fetch,
        errorLabel: "submission",
        responseLabel: "response",
      };
      const result = objectResponse
        ? postJsonResponse({ ...params, objectResponse: true })
        : postJsonResponse<unknown>(params);
      if (error) {
        await expect(result).rejects.toThrow(error);
      } else {
        await expect(result).resolves.toEqual(expected);
      }
      expect(release).toHaveBeenCalledExactlyOnceWith();
    },
  );
});

beforeEach(() => {
  shouldUseEnvHttpProxyForUrlMock.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

function getFirstGuardedFetchCall() {
  const [mockCall] = fetchWithSsrFGuardMock.mock.calls;
  expect(mockCall).toBeDefined();
  return mockCall![0];
}

function createTricklingResponse(status = 200): Response {
  const chunk = new TextEncoder().encode("{");
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(chunk);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

const pollLabel = "video generation task task-1";
const makeDeadline = (timeoutMs?: number, label = "video generation") =>
  createProviderOperationDeadline({ label, timeoutMs });
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body));
const busyResponse = () => new Response("busy", { status: 503, statusText: "Service Unavailable" });
function providerPollOptions(fetchFn: typeof fetch, timeoutMs?: number) {
  return {
    url: "https://api.example.com/v1/videos/task-1",
    headers: new Headers(),
    deadline: makeDeadline(timeoutMs, pollLabel),
    defaultTimeoutMs: 5_000,
    fetchFn,
    maxAttempts: 3,
    pollIntervalMs: 1_000,
    requestFailedMessage: "status failed",
    timeoutMessage: "task timed out",
    isComplete: (payload: { status?: string }) => payload.status === "completed",
  };
}

function downloadOptions(fetchFn: typeof fetch) {
  return {
    url: "https://cdn.example.com/video.mp4",
    init: { method: "GET" },
    fetchFn,
    provider: "test-video",
    requestFailedMessage: "download failed",
  };
}
type PollPayload = { status?: string; error?: { message?: string } };
function poll(
  fetchFn: typeof fetch,
  timeoutMs?: number,
  options: Partial<Parameters<typeof pollProviderOperationJson<PollPayload>>[0]> = {},
) {
  return pollProviderOperationJson<PollPayload>({
    ...providerPollOptions(fetchFn, timeoutMs),
    ...options,
  });
}
function postOptions(body: unknown = { ok: true }) {
  return { url: "https://api.example.com/v1/test", headers: new Headers(), body, fetchFn: fetch };
}
function queueGuardedResponse(response: Response) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response,
    finalUrl: "https://api.example.com",
    release,
  });
  return release;
}

function mockGuardedFetch(finalUrl = "https://example.com") {
  fetchWithSsrFGuardMock.mockResolvedValue({
    response: new Response(null, { status: 200 }),
    finalUrl,
    release: async () => {},
  });
}

describe("provider operation deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });
  it("caps oversized operation and per-call timeouts to timer-safe values", () => {
    const deadline = makeDeadline(MAX_TIMER_TIMEOUT_MS + 1_000_000);

    expect(deadline.timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(deadline.deadlineAtMs).toBe(1_000 + MAX_TIMER_TIMEOUT_MS);
    expect(
      resolveProviderOperationTimeoutMs({
        deadline: makeDeadline(undefined, "no deadline"),
        defaultTimeoutMs: MAX_TIMER_TIMEOUT_MS + 1_000_000,
      }),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("keeps operation deadlines inside the Date timestamp range", () => {
    vi.setSystemTime(new Date(MAX_DATE_TIMESTAMP_MS));

    const deadline = makeDeadline(1);

    expect(deadline.deadlineAtMs).toBe(MAX_DATE_TIMESTAMP_MS);
    expect(() => resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 60_000 })).toThrow(
      "video generation timed out after 1ms",
    );
  });

  it("resolves a lazy total timeout once when the deadline starts", () => {
    const resolveTimeoutMs = vi.fn(() => 5_000);

    const deadline = createProviderOperationDeadline({
      label: "generated media download",
      timeoutMs: resolveTimeoutMs,
    });
    vi.setSystemTime(4_250);

    expect(resolveTimeoutMs).toHaveBeenCalledTimes(1);
    expect(resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 60_000 })).toBe(1_750);
    expect(resolveTimeoutMs).toHaveBeenCalledTimes(1);
  });

  it("clamps poll waits to the remaining operation deadline", async () => {
    const deadline = makeDeadline(1_000);
    const wait = waitProviderOperationPollInterval({
      deadline,
      pollIntervalMs: 10_000,
    });

    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void wait.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(wait).resolves.toBeUndefined();
  });

  it("caps oversized provider poll waits without an operation deadline", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const wait = waitProviderOperationPollInterval({
      deadline: makeDeadline(),
      pollIntervalMs: MAX_TIMER_TIMEOUT_MS + 1_000_000,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
    await expect(wait).resolves.toBeUndefined();
  });

  it("polls provider status JSON until a payload is complete", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ status: "in_progress" }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed" }));

    const result = poll(fetchFn, 10_000, {
      headers: new Headers({ authorization: "Bearer test" }),
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toEqual({ status: "completed" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("bounds a trickling poll response body with the operation deadline", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(createTricklingResponse());
    const result = poll(fetchFn, 100);
    const assertion = expect(result).rejects.toThrow(
      "video generation task task-1 timed out after 100ms",
    );

    await vi.advanceTimersByTimeAsync(110);
    await assertion;
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("passes guarded request policy through provider status polling", async () => {
    const release = queueGuardedResponse(jsonResponse({ status: "completed" }));

    const result = await poll(fetch, undefined, {
      headers: new Headers({ authorization: "Bearer test" }),
      allowPrivateNetwork: true,
      dispatcherPolicy: { mode: "direct" },
      auditContext: "provider-video-status",
    });

    expect(result).toEqual({ status: "completed" });
    const call = getFirstGuardedFetchCall();
    expect([call.policy, call.dispatcherPolicy, call.auditContext]).toEqual([
      { allowPrivateNetwork: true },
      { mode: "direct" },
      "provider-video-status",
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("retries guarded transient provider status failures while polling", async () => {
    const firstRelease = queueGuardedResponse(busyResponse());
    const secondRelease = queueGuardedResponse(jsonResponse({ status: "completed" }));

    const result = poll(fetch, 10_000, {
      headers: new Headers({ authorization: "Bearer test" }),
      allowPrivateNetwork: true,
    });

    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual({ status: "completed" });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(secondRelease).toHaveBeenCalledTimes(1);
  });

  it("throws provider failure messages while polling status JSON", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ status: "failed", error: { message: "model rejected" } }),
      );

    await expect(
      poll(fetchFn, undefined, {
        getFailureMessage: (payload) =>
          payload.status === "failed" ? payload.error?.message : undefined,
      }),
    ).rejects.toThrow("model rejected");
  });

  it("recomputes remaining poll timeout before retry attempts", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      vi.setSystemTime(2_001);
      return busyResponse();
    });

    const result = poll(fetchFn, 1_000, {
      headers: new Headers({ authorization: "Bearer test" }),
    });
    const assertion = expect(result).rejects.toThrow(
      "video generation task task-1 timed out after 1000ms",
    );

    await vi.advanceTimersByTimeAsync(250);

    await assertion;
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries transient generated asset downloads", async () => {
    vi.useRealTimers();
    const sleep = vi.fn(async () => undefined);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce(new Response("video-bytes", { status: 200 }));

    const response = await fetchProviderDownloadResponse({
      ...downloadOptions(fetchFn),
      // Keep the shipped timeoutMs call shape working for external plugins.
      timeoutMs: 5_000,
      retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
    });

    expect(await response.text()).toBe("video-bytes");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0, undefined);
  });

  it("bounds a trickling generated-asset error body", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(createTricklingResponse(503));
    const result = fetchProviderDownloadResponse({
      ...downloadOptions(fetchFn),
      deadline: makeDeadline(100, "download failed"),
      retry: { attempts: 1 },
    });
    const assertion = expect(result).rejects.toThrow("download failed timed out after 100ms");

    await vi.advanceTimersByTimeAsync(110);
    await assertion;
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("recomputes remaining download timeout before retry attempts", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchFn = vi.fn<typeof fetch>(async () => {
      vi.setSystemTime(2_001);
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    });

    await expect(
      fetchProviderDownloadResponse({
        ...downloadOptions(fetchFn),
        deadline: makeDeadline(1_000, "video download"),
        retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
      }),
    ).rejects.toThrow("video download timed out after 1000ms");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(0, undefined);
  });
});

describe("resolveProviderHttpRequestConfig", () => {
  it("preserves explicit caller headers but protects attribution headers", () => {
    const resolved = resolveProviderHttpRequestConfig({
      baseUrl: "https://api.openai.com/v1/",
      defaultBaseUrl: "https://api.openai.com/v1",
      headers: {
        authorization: "Bearer override",
        "User-Agent": "custom-agent/1.0",
        originator: "spoofed",
      },
      defaultHeaders: {
        authorization: "Bearer default-token",
        "X-Default": "1",
      },
      provider: "openai",
      api: "openai-audio-transcriptions",
      capability: "audio",
      transport: "media-understanding",
    });

    expect(resolved.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.allowPrivateNetwork).toBe(false);
    expect(resolved.headers.get("authorization")).toBe("Bearer override");
    expect(resolved.headers.get("x-default")).toBe("1");
    expect(resolved.headers.get("user-agent")).toBe(`openclaw/${VERSION}`);
    expect(resolved.headers.get("originator")).toBe("openclaw");
    expect(resolved.headers.get("version")).toBe(VERSION);
  });

  it("keeps configured-origin trust eligibility internal to core callers", () => {
    const custom = resolveProviderHttpRequestConfigWithOriginTrust({
      baseUrl: "https://models.internal/v1",
      defaultBaseUrl: "https://api.example.com/v1",
      provider: "example",
    });
    const deniedLocal = resolveProviderHttpRequestConfigWithOriginTrust({
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultBaseUrl: "https://api.example.com/v1",
      provider: "example",
      request: { allowPrivateNetwork: false },
    });

    expect(custom.trustConfiguredBaseUrlOrigin).toBe(true);
    expect(deniedLocal.trustConfiguredBaseUrlOrigin).toBe(false);
    expect(
      resolveProviderHttpRequestConfig({
        baseUrl: "https://models.internal/v1",
        defaultBaseUrl: "https://api.example.com/v1",
        provider: "example",
      }),
    ).not.toHaveProperty("trustConfiguredBaseUrlOrigin");
  });

  it("fails fast when no base URL can be resolved", () => {
    expect(() =>
      resolveProviderHttpRequestConfig({
        baseUrl: "   ",
        defaultBaseUrl: "   ",
      }),
    ).toThrow("Missing baseUrl");
  });
});

describe("fetchWithTimeoutGuarded", () => {
  it("truncates auditContext without leaving a lone surrogate at the max boundary", async () => {
    mockGuardedFetch();

    const prefix = "a".repeat(79);
    await fetchWithTimeoutGuarded("https://example.com", {}, 5000, fetch, {
      auditContext: `${prefix}${String.fromCodePoint(0x1f600)}tail`,
    });

    const call = getFirstGuardedFetchCall();
    expect(call.auditContext).toBe(prefix);
    expect(call.auditContext).not.toContain(String.fromCharCode(0xd83d));
  });

  it("merges full SSRF policy into JSON request guards", async () => {
    mockGuardedFetch();

    await postJsonRequest({
      ...postOptions(),
      allowPrivateNetwork: true,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });

    expect(getFirstGuardedFetchCall().policy).toEqual({
      allowPrivateNetwork: true,
      allowRfc2544BenchmarkRange: true,
    });
  });

  it("does not retry JSON POST requests by default", async () => {
    fetchWithSsrFGuardMock.mockReset();
    fetchWithSsrFGuardMock.mockRejectedValueOnce(
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    );
    queueGuardedResponse(new Response(null, { status: 200 }));

    await expect(postJsonRequest(postOptions({ prompt: "make a video" }))).rejects.toThrow(
      "socket hang up",
    );

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
  });

  it("retries read JSON POST transient HTTP responses", async () => {
    fetchWithSsrFGuardMock.mockReset();
    const firstRelease = queueGuardedResponse(busyResponse());
    const secondRelease = queueGuardedResponse(new Response(null, { status: 200 }));
    const sleep = vi.fn(async () => undefined);

    const result = await postJsonRequest({
      ...postOptions({ media: "base64" }),
      retryStage: "read",
      retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
    });

    expect(result.response.status).toBe(200);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledWith(0, undefined);
  });

  it("forwards explicit pinDns overrides for multipart POST requests", async () => {
    mockGuardedFetch();

    await postMultipartRequest({
      ...postOptions(),
      body: "audio-bytes",
      pinDns: false,
    });

    expect(getFirstGuardedFetchCall().pinDns).toBe(false);
  });

  it("auto-upgrades transcription requests to trusted env proxy when proxy env is configured", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(true);
    mockGuardedFetch("https://api.openai.com");

    await postTranscriptionRequest({
      url: "https://api.openai.com/v1/audio/transcriptions",
      headers: new Headers({ authorization: "Bearer test" }),
      body: "audio-bytes",
      fetchFn: fetch,
    });

    expect(getFirstGuardedFetchCall().mode).toBe("trusted_env_proxy");
  });

  it("forwards an explicit mode override through postTranscriptionRequest even when proxy env is configured", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(true);
    mockGuardedFetch("https://api.example.com");

    await postTranscriptionRequest({
      ...postOptions(),
      body: "audio-bytes",
      mode: "strict",
    });

    expect(getFirstGuardedFetchCall().mode).toBe("strict");
  });

  it("does not auto-upgrade when caller passes explicit dispatcherPolicy", async () => {
    // Callers with custom proxy URL / proxyTls / connect options must keep
    // control over the dispatcher. Auto-upgrade would build an
    // EnvHttpProxyAgent that silently drops those overrides.
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(true);
    mockGuardedFetch("https://api.example.com");

    const explicitPolicy = {
      mode: "explicit-proxy" as const,
      proxyUrl: "http://corp-proxy.internal:3128",
    };

    await fetchWithTimeoutGuarded("https://api.example.com/v1/image", {}, undefined, fetch, {
      dispatcherPolicy: explicitPolicy,
    });

    const call = getFirstGuardedFetchCall();
    expect(call).not.toHaveProperty("mode");
    expect(call).toHaveProperty("dispatcherPolicy", explicitPolicy);
  });
});
