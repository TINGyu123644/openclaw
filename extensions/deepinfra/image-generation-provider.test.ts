import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  requireFirstPostJsonRecordRequest,
  requireFirstPostJsonRequest,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDeepInfraImageGenerationProvider } from "./image-generation-provider.js";

const {
  postJsonRequestMock,
  postMultipartRequestMock,
  resolveApiKeyForProviderMock,
  resolveProviderHttpRequestConfigMock,
} = getProviderHttpMocks();

installProviderHttpMockCleanup();
const model = "black-forest-labs/FLUX-1-schnell";
const baseUrl = "https://api.deepinfra.com/v1/openai";
const imageResponse = (bytes: Buffer, revised_prompt?: string) => ({
  response: Response.json({ data: [{ b64_json: bytes.toString("base64"), revised_prompt }] }),
  release: vi.fn(async () => {}),
});

describe("deepinfra image generation provider", () => {
  beforeEach(() => {
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "deepinfra-key" });
  });

  afterEach(() => {
    postMultipartRequestMock.mockReset();
  });

  it("declares generation and single-reference edit support", () => {
    const provider = buildDeepInfraImageGenerationProvider();

    expect(provider).toMatchObject({
      id: "deepinfra",
      defaultModel: model,
      models: [
        model,
        "black-forest-labs/FLUX-1-dev",
        "Qwen/Qwen-Image-Max",
        "stabilityai/sdxl-turbo",
      ],
      capabilities: { generate: { maxCount: 4 }, edit: { enabled: true, maxInputImages: 1 } },
    });
  });

  it("sends OpenAI-compatible image generation requests and sniffs JPEG output", async () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const response = imageResponse(jpegBytes, "red square");
    postJsonRequestMock.mockResolvedValue(response);

    const provider = buildDeepInfraImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "deepinfra",
      model: `deepinfra/${model}`,
      prompt: "red square",
      count: 2,
      size: "512x512",
      timeoutMs: 12_345,
      cfg: { models: { providers: { deepinfra: { baseUrl: `${baseUrl}/` } } } } as never,
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepinfra",
        capability: "image",
        transport: "http",
        defaultBaseUrl: baseUrl,
        allowPrivateNetwork: false,
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const jsonRequest = requireFirstPostJsonRequest(
      postJsonRequestMock,
      "DeepInfra JSON image request",
    );
    const jsonRequestHeaders = Reflect.get(jsonRequest ?? {}, "headers");
    expect(jsonRequestHeaders).toBeInstanceOf(Headers);
    expect(Object.fromEntries((jsonRequestHeaders as Headers).entries())).toEqual({
      authorization: "Bearer deepinfra-key",
      "content-type": "application/json",
    });
    expect(jsonRequest).toEqual({
      url: `${baseUrl}/images/generations`,
      headers: jsonRequestHeaders,
      timeoutMs: 12_345,
      body: {
        model,
        prompt: "red square",
        n: 2,
        size: "512x512",
        response_format: "b64_json",
      },
      fetchFn: fetch,
      allowPrivateNetwork: false,
      dispatcherPolicy: undefined,
    });
    expect(result.images).toEqual([
      {
        buffer: jpegBytes,
        mimeType: "image/jpeg",
        fileName: "image-1.jpg",
        revisedPrompt: "red square",
      },
    ]);
    expect(response.release).toHaveBeenCalledOnce();
  });

  it("sends image edits as multipart OpenAI-compatible requests", async () => {
    postMultipartRequestMock.mockResolvedValue(
      imageResponse(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    );

    const provider = buildDeepInfraImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "deepinfra",
      model,
      prompt: "make it neon",
      inputImages: [{ buffer: Buffer.from("source"), mimeType: "image/png" }],
      cfg: {} as never,
    });

    expect(postMultipartRequestMock).toHaveBeenCalledOnce();
    const multipartRequest = requireFirstPostJsonRecordRequest(
      postMultipartRequestMock,
      "DeepInfra multipart image request",
    );
    const multipartHeaders = Reflect.get(multipartRequest, "headers");
    expect(multipartHeaders).toBeInstanceOf(Headers);
    expect(Object.fromEntries((multipartHeaders as Headers).entries())).toEqual({
      authorization: "Bearer deepinfra-key",
    });
    const form = Reflect.get(multipartRequest, "body") as FormData;
    expect(multipartRequest).toEqual({
      url: `${baseUrl}/images/edits`,
      headers: multipartHeaders,
      body: form,
      timeoutMs: undefined,
      fetchFn: fetch,
      allowPrivateNetwork: false,
      dispatcherPolicy: undefined,
    });
    expect(["model", "prompt", "response_format"].map((key) => form.get(key))).toEqual([
      model,
      "make it neon",
      "b64_json",
    ]);
    expect(form.get("image")).toBeInstanceOf(File);
    expect(result.images).toMatchObject([{ mimeType: "image/png" }]);
  });
});
