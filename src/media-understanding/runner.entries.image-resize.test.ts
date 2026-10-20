import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.js";
import { readImageMetadataFromHeader } from "../media/media-services.js";
import type { ImageCompressionModelPolicy } from "../media/web-media.js";
import { MediaAttachmentCache } from "./attachments.js";
import type { ImageDescriptionRequest, MediaUnderstandingProvider } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolveImageCompressionModelPolicy: vi.fn<() => Promise<ImageCompressionModelPolicy>>(),
}));

vi.mock("../agents/image-compression-policy.js", () => ({
  resolveImageCompressionModelPolicy: mocks.resolveImageCompressionModelPolicy,
}));

const { runProviderEntry } = await import("./runner.entries.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function setupProvider(
  source: Buffer,
  options: {
    fileName?: string;
    mime?: string;
    cfg?: OpenClawConfig;
    maxBytes?: number;
  } = {},
) {
  const root = tempDirs.make("openclaw-image-resize-");
  const attachmentPath = path.join(root, options.fileName ?? "phone.png");
  await fs.writeFile(attachmentPath, source);
  const cache = new MediaAttachmentCache(
    [{ index: 0, path: attachmentPath, mime: options.mime ?? "image/png" }],
    { localPathRoots: [root], includeDefaultLocalPathRoots: false },
  );
  const describeImage = vi.fn(async (_request: ImageDescriptionRequest) => ({
    text: "described",
    model: "vision-v1",
  }));
  const run = () =>
    runProviderEntry({
      capability: "image",
      entry: { provider: "vision-plugin", model: "vision-v1", maxBytes: options.maxBytes },
      cfg: options.cfg ?? {},
      attachmentIndex: 0,
      cache,
      agentDir: root,
      providerRegistry: new Map<string, MediaUnderstandingProvider>([
        ["vision-plugin", { id: "vision-plugin", capabilities: ["image"], describeImage }],
      ]),
    }).finally(() => cache.cleanup());
  return {
    async describe() {
      await expect(run()).resolves.toMatchObject({
        ok: true,
        value: { text: "described", provider: "vision-plugin" },
      });
      expect(describeImage).toHaveBeenCalledOnce();
      return describeImage.mock.calls[0]![0];
    },
    async reject(maxBytes: number) {
      await expect(run()).rejects.toMatchObject({
        name: "MediaUnderstandingSkipError",
        reason: "maxBytes",
        message: `Attachment 1 exceeds maxBytes ${maxBytes}`,
      });
      expect(describeImage).not.toHaveBeenCalled();
    },
  };
}

const png = (width: number, height: number) =>
  createSolidPngBuffer(width, height, { r: 24, g: 96, b: 208 });

describe("runProviderEntry image resize boundary", () => {
  beforeEach(() => {
    mocks.resolveImageCompressionModelPolicy.mockReset().mockResolvedValue({
      maxSidePx: 1600,
      preferredSidePx: 1400,
    });
  });

  it.each(["high", "efficient"] as const)(
    "does not apply the image-tool-only %s preference to a custom provider",
    async (quality) => {
      const provider = await setupProvider(png(1600, 1200), {
        cfg: { agents: { defaults: { imageQuality: quality } } },
      });
      const request = await provider.describe();
      expect(readImageMetadataFromHeader(request.buffer)).toEqual({ width: 1400, height: 1050 });
      expect(request).toMatchObject({ provider: "vision-plugin", model: "vision-v1" });
      expect(request.fileName).toMatch(/^phone\.(png|jpg)$/);
    },
  );

  it("preserves recognized images at the provider boundary when the model declares no limits", async () => {
    const source = png(2400, 1800);
    mocks.resolveImageCompressionModelPolicy.mockResolvedValue({});
    const request = await (await setupProvider(source)).describe();
    expect(request.buffer.equals(source)).toBe(true);
    expect(readImageMetadataFromHeader(request.buffer)).toEqual({ width: 2400, height: 1800 });
    expect(request).toMatchObject({ mime: "image/png", fileName: "phone.png" });
  });

  it("enforces the configured source cap before optimizer and provider work", async () => {
    const source = png(1600, 1200);
    const maxBytes = source.length - 1;
    await (await setupProvider(source, { maxBytes })).reject(maxBytes);
    expect(mocks.resolveImageCompressionModelPolicy).not.toHaveBeenCalled();
  });

  it("reports the model byte cap when a valid image cannot be encoded small enough", async () => {
    mocks.resolveImageCompressionModelPolicy.mockResolvedValue({ maxBytes: 8 });
    await (await setupProvider(png(1, 1))).reject(8);
    expect(mocks.resolveImageCompressionModelPolicy).toHaveBeenCalledOnce();
  });

  it("enforces the selected model byte cap for provider-owned image formats", async () => {
    mocks.resolveImageCompressionModelPolicy.mockResolvedValue({ maxBytes: 8 });
    const provider = await setupProvider(Buffer.from("custom-image"), {
      fileName: "phone.custom",
      mime: "image/x-custom",
    });
    await provider.reject(8);
  });
});
