import { requireFirstPostJsonRequest } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildDeepInfraSpeechProvider } from "./speech-provider.js";

const baseUrl = "https://api.deepinfra.com/v1/openai";
const model = "hexgrad/Kokoro-82M";
const voice = "af_bella";
const http = vi.hoisted(() => ({
  assertOkOrThrowHttpError: vi.fn(async () => {}),
  postJsonRequest: vi.fn(),
  resolveProviderHttpRequestConfig: vi.fn((params: Record<string, unknown>) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://api.deepinfra.com/v1/openai",
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
    dispatcherPolicy: undefined,
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  ...http,
}));

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/provider-http");
  vi.resetModules();
});

describe("deepinfra speech provider", () => {
  afterEach(() => {
    for (const mock of Object.values(http)) {
      mock.mockClear();
    }
    http.postJsonRequest.mockReset();
    vi.unstubAllEnvs();
  });

  it("normalizes provider-owned speech config", () => {
    const provider = buildDeepInfraSpeechProvider();
    expect(provider.defaultTimeoutMs).toBe(120_000);
    expect(
      provider.resolveConfig?.({
        cfg: {} as never,
        timeoutMs: 30_000,
        rawConfig: {
          providers: {
            deepinfra: {
              apiKey: "sk-test",
              baseUrl: `${baseUrl}/`,
              modelId: `deepinfra/${model}`,
              voiceId: voice,
              speed: 1.1,
              responseFormat: " MP3 ",
            },
          },
        },
      }),
    ).toEqual({
      apiKey: "sk-test",
      baseUrl,
      model,
      voice,
      speed: 1.1,
      responseFormat: "mp3",
      extraBody: undefined,
    });
  });

  it("synthesizes OpenAI-compatible speech through DeepInfra", async () => {
    const release = vi.fn(async () => {});
    http.postJsonRequest.mockResolvedValue({
      response: new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      release,
    });

    const provider = buildDeepInfraSpeechProvider();
    const result = await provider.synthesize({
      text: "hello",
      cfg: {
        models: { providers: { deepinfra: { apiKey: "sk-deepinfra", baseUrl: `${baseUrl}/` } } },
      } as never,
      providerConfig: { model, voice, speed: 1.2 },
      target: "voice-note",
      timeoutMs: 12_345,
    });

    expect(http.resolveProviderHttpRequestConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepinfra",
        capability: "audio",
        transport: "http",
        defaultBaseUrl: baseUrl,
        allowPrivateNetwork: false,
      }),
    );
    expect(http.postJsonRequest).toHaveBeenCalledOnce();
    const postRequest = requireFirstPostJsonRequest(
      http.postJsonRequest,
      "DeepInfra speech request",
    );
    const postRequestHeaders = Reflect.get(postRequest ?? {}, "headers");
    expect(postRequestHeaders).toBeInstanceOf(Headers);
    expect(Object.fromEntries((postRequestHeaders as Headers).entries())).toEqual({
      authorization: "Bearer sk-deepinfra",
      "content-type": "application/json",
    });
    expect(postRequest).toEqual({
      url: `${baseUrl}/audio/speech`,
      headers: postRequestHeaders,
      timeoutMs: 12_345,
      body: {
        model,
        input: "hello",
        voice,
        response_format: "mp3",
        speed: 1.2,
      },
      fetchFn: fetch,
      allowPrivateNetwork: false,
      dispatcherPolicy: undefined,
    });
    expect(result.audioBuffer).toEqual(Buffer.from([1, 2, 3]));
    expect(result.outputFormat).toBe("mp3");
    expect(result.fileExtension).toBe(".mp3");
    expect(result.voiceCompatible).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses DEEPINFRA_API_KEY when provider config omits apiKey", () => {
    vi.stubEnv("DEEPINFRA_API_KEY", "sk-env");
    const provider = buildDeepInfraSpeechProvider();

    expect(
      provider.isConfigured({
        cfg: {} as never,
        providerConfig: {},
        timeoutMs: 30_000,
      }),
    ).toBe(true);
  });
});
