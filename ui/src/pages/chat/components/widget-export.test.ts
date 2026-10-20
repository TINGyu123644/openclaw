/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { exportWidget } from "./widget-export.ts";

const PNG_DATA_URL = "data:image/png;base64,aW1hZ2U=";

function createWidgetFrame(): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.src = "/__openclaw__/canvas/documents/cv_export/index.html";
  document.body.append(frame);
  expect(frame.contentWindow).not.toBeNull();
  return frame;
}

function watchSnapshot(frame: HTMLIFrameElement, stubPostMessage = true) {
  const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
  if (stubPostMessage) {
    postMessage.mockImplementation(() => {});
  }
  return {
    postMessage,
    reply: (payload: { dataUrl: string } | { error: string }, overrides: MessageEventInit = {}) => {
      const request = postMessage.mock.calls[0]?.[0] as { id: string };
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: { type: "openclaw:widget-snapshot", id: request.id, ...payload },
          ...overrides,
        }),
      );
    },
  };
}

function watchDownloads() {
  const downloads: Array<[string, string]> = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push([this.href, this.download]);
  });
  return downloads;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("widget export", () => {
  function startSnapshot(title = "Current widget", action: "copy" | "download" = "download") {
    const frame = createWidgetFrame();
    const snapshot = watchSnapshot(frame);
    return { ...snapshot, result: exportWidget(action, frame, title) };
  }

  function watchHtmlDownload(url: string) {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue(url);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    return createUrl;
  }

  it("matches snapshot replies by frame source and request id", async () => {
    const downloads = watchDownloads();
    const { postMessage, reply, result } = startSnapshot();
    let settled = false;
    void result.finally(() => {
      settled = true;
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "openclaw:widget-snapshot-request" }),
      "*",
    );
    reply(
      { dataUrl: PNG_DATA_URL },
      {
        data: { type: "openclaw:widget-snapshot", id: "snapshot-2", dataUrl: PNG_DATA_URL },
      },
    );
    reply({ dataUrl: PNG_DATA_URL }, { source: window });
    await Promise.resolve();
    expect(settled).toBe(false);

    reply({ dataUrl: PNG_DATA_URL });
    await expect(result).resolves.toBe("png");
    expect(downloads).toEqual([[PNG_DATA_URL, "Current-widget.png"]]);
  });

  it("selects the copy notice and HTML download fallbacks after a timeout", async () => {
    vi.useFakeTimers();
    const frame = createWidgetFrame();
    const downloads = watchDownloads();
    const fetchDocument = vi.fn(async () => new Response("<p>Legacy</p>", { status: 200 }));
    vi.stubGlobal("fetch", fetchDocument);
    watchHtmlDownload("blob:legacy-widget");

    const copyResult = exportWidget("copy", frame, "Legacy widget");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(copyResult).resolves.toBe("rerender-required");
    expect(fetchDocument).not.toHaveBeenCalled();

    const downloadResult = exportWidget("download", frame, "Legacy widget");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(downloadResult).resolves.toBe("html");
    expect(fetchDocument).toHaveBeenCalledWith(frame.src);
    expect(downloads).toEqual([["blob:legacy-widget", "Legacy-widget.html"]]);
  });

  it("starts clipboard writing before the snapshot resolves", async () => {
    const blob = new Blob(["image"], { type: "image/png" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ blob: async () => blob })),
    );
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Promise<Blob>>) {}
      },
    );
    const write = vi.fn(async (items: { data: Record<string, Promise<Blob>> }[]) => {
      await expect(items[0]?.data["image/png"]).resolves.toBe(blob);
    });
    vi.stubGlobal("navigator", { clipboard: { write } });

    const { reply, result } = startSnapshot("Current widget", "copy");
    expect(write).toHaveBeenCalledOnce();
    reply({ dataUrl: PNG_DATA_URL });
    await expect(result).resolves.toBe("png");
  });

  it("downloads retained authenticated HTML when an isolated widget cannot snapshot", async () => {
    vi.useFakeTimers();
    const frame = createWidgetFrame();
    const downloads = watchDownloads();
    frame.src = "https://sandbox.example/mcp-app-sandbox";
    const fetchDocument = vi.fn();
    vi.stubGlobal("fetch", fetchDocument);
    const createUrl = watchHtmlDownload("blob:widget-source");
    const result = exportWidget("download", frame, "Isolated widget", {
      documentHtml: "<p>Authenticated document</p>",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toBe("html");
    expect(fetchDocument).not.toHaveBeenCalled();
    expect(createUrl.mock.calls[0]?.[0]).toMatchObject({ size: 29, type: "text/html" });
    expect(downloads).toEqual([["blob:widget-source", "Isolated-widget.html"]]);
  });

  it("does not use legacy fallbacks for an explicit bridge error", async () => {
    const fetchDocument = vi.fn();
    vi.stubGlobal("fetch", fetchDocument);
    const { reply, result } = startSnapshot("Broken widget");
    reply({ error: "canvas is not exportable" });

    await expect(result).rejects.toThrow("canvas is not exportable");
    expect(fetchDocument).not.toHaveBeenCalled();
  });

  it("sanitizes an empty PNG download filename", async () => {
    const downloads = watchDownloads();
    const { reply, result } = startSnapshot("... <> ");
    reply({ dataUrl: PNG_DATA_URL });
    await expect(result).resolves.toBe("png");
    expect(downloads).toEqual([[PNG_DATA_URL, "widget.png"]]);
  });

  it("rejects non-PNG and oversized snapshot replies", async () => {
    for (const dataUrl of [
      "data:image/jpeg;base64,aW1hZ2U=",
      "https://example.com/widget.png",
      `data:image/png;base64,${"A".repeat(32 * 1024 * 1024)}`,
    ]) {
      const frame = createWidgetFrame();
      const { postMessage, reply } = watchSnapshot(frame, false);
      const result = exportWidget("download", frame, "Current widget");
      expect(postMessage).toHaveBeenCalledOnce();
      const request = postMessage.mock.calls[0]?.[0];
      expect(request).toBeDefined();
      reply({ dataUrl });
      await expect(result).rejects.toThrow("widget returned an invalid snapshot");
    }
  });
});
