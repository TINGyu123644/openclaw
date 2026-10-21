import type { postJsonRequest } from "openclaw/plugin-sdk/provider-http";
import { assert, expect, it, vi } from "vitest";
import { buildRunwayVideoGenerationProvider } from "./video-generation-provider.js";

const { postJsonRequestMock } = vi.hoisted(() => ({
  postJsonRequestMock: vi.fn<typeof postJsonRequest>(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: async () => ({ apiKey: "synthetic-runway-key" }),
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  postJsonRequest: postJsonRequestMock,
}));

it("applies configured request policy to the submitted Runway task", async () => {
  const intercepted = new Error("synthetic submission intercepted");
  postJsonRequestMock.mockRejectedValue(intercepted);

  await expect(
    buildRunwayVideoGenerationProvider().generateVideo({
      provider: "runway",
      model: "gen4.5",
      prompt: "a synthetic lobster",
      cfg: {
        models: {
          providers: {
            runway: {
              baseUrl: "https://runway.example.test",
              models: [],
              request: {
                headers: { "X-Relay": "synthetic-route" },
                proxy: { mode: "explicit-proxy", url: "http://proxy.example:8080" },
                allowPrivateNetwork: true,
              },
            },
          },
        },
      },
    }),
  ).rejects.toBe(intercepted);

  expect(postJsonRequestMock).toHaveBeenCalledOnce();
  const request = postJsonRequestMock.mock.calls[0]?.[0];
  assert(request);
  expect(request.url).toBe("https://runway.example.test/v1/text_to_video");
  expect(Object.fromEntries(new Headers(request.headers))).toMatchObject({
    authorization: "Bearer synthetic-runway-key",
    "content-type": "application/json",
    "x-runway-version": "2024-11-06",
    "x-relay": "synthetic-route",
  });
  expect(request.allowPrivateNetwork).toBe(true);
  expect(request.dispatcherPolicy).toMatchObject({
    mode: "explicit-proxy",
    proxyUrl: "http://proxy.example:8080",
  });
});
