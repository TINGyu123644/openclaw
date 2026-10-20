/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { mcpAppWidgetNameForViewId, type BoardProvider } from "../../../lib/board/provider.ts";
import { bumpCanvasWidgetFrameConnectionGeneration } from "../../../lib/chat/canvas-widget-frame-generation.ts";
import { createTestSessionCapability } from "../../../lib/sessions/session-capability.test-support.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { disposeSidebarContextLifecycles } from "../../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext } from "../../../test-helpers/app-sidebar.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../../test-helpers/application-context.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ToolPreview } from "./widget-card-view.tsx";
import * as widgetExport from "./widget-export.ts";

const canvasPreview = {
  kind: "canvas",
  surface: "assistant_message",
  render: "url",
} as const;
const sessionKey = "agent:main:main";
const actionButton = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('button[aria-label="Widget actions"]');
const pinButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("[data-pin-widget]");
const menuLabels = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('[role="menuitem"]'), (item) => item.textContent?.trim());
const widgetPorts: MessagePort[] = [];
type PreviewState = {
  preview: Parameters<typeof ToolPreview>[0]["preview"];
  options: Parameters<typeof ToolPreview>[0]["options"];
};
const widgets = new Map<
  HTMLElement,
  { update: (state: PreviewState) => void; unmount: () => void }
>();

function documentPreview(
  id: string,
  overrides: Partial<Extract<PreviewState["preview"], { kind: "canvas" }>> = {},
) {
  return {
    ...canvasPreview,
    url: `/__openclaw__/canvas/documents/${id}/index.html`,
    sandbox: "scripts" as const,
    ...overrides,
  };
}

function connectedHost() {
  return document.body.appendChild(document.createElement("div"));
}

function showCapability(preview: PreviewState["preview"], host: HTMLElement, capability: string) {
  return mountWidget(
    preview,
    { canvasPluginSurfaceUrl: `https://canvas.test/__openclaw__/cap/${capability}` },
    host,
  );
}

function boardProvider(overrides: Partial<BoardProvider> = {}) {
  const snapshot = {
    value: {
      sessionKey: "agent:main:main",
      revision: 0,
      tabs: [],
      widgets: [],
    } as BoardProvider["snapshot$"]["value"],
    subscribe: () => () => {},
  };
  const provider = {
    sessionKey: "agent:main:main",
    canPinWidgets: true,
    pinWidget: vi.fn(async () => undefined),
    snapshot$: snapshot,
    ...overrides,
  } as unknown as BoardProvider;
  return { provider, snapshot };
}

function boardWidget(name: string): BoardProvider["snapshot$"]["value"]["widgets"][number] {
  return {
    name,
    tabId: "main",
    contentKind: "html",
    sizeW: 6,
    sizeH: 4,
    position: 0,
    grantState: "none",
    revision: 1,
  };
}

function unmountWidget(host: HTMLElement) {
  widgets.get(host)?.unmount();
  widgets.delete(host);
}

function mountWidget(
  preview: PreviewState["preview"],
  options?: PreviewState["options"],
  host = document.createElement("div"),
) {
  const state = { preview, options };
  const mounted = widgets.get(host);
  if (mounted) {
    mounted.update(state);
  } else {
    let update!: (state: PreviewState) => void;
    const root = mountSolid(
      () => {
        const [current, setCurrent] = createSignal(state);
        update = setCurrent;
        return (
          <ToolPreview
            preview={current().preview}
            surface="chat_message"
            options={current().options}
          />
        );
      },
      { container: host },
    );
    widgets.set(host, { update, unmount: root.unmount });
  }
  flush();
  return host;
}

function initializeWidgetFrame(frame: HTMLIFrameElement) {
  const channel = new MessageChannel();
  widgetPorts.push(channel.port1, channel.port2);
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "openclaw:widget-prompt-offer" },
      origin: "null",
      source: frame.contentWindow,
      ports: [channel.port2],
    }),
  );
  frame.dispatchEvent(new Event("load"));
}

async function openActions(host: HTMLElement) {
  actionButton(host)!.click();
  await waitForSolid(() =>
    expect(host.querySelector('[role="menu"]')?.matches(":popover-open")).toBe(true),
  );
}

async function downloadWidget(host: HTMLElement) {
  await openActions(host);
  host.querySelector<HTMLButtonElement>('[role="menuitem"][value="download"]')!.click();
}

afterEach(async () => {
  // Rendering starts lazy element imports that must finish before this environment retires.
  await vi.dynamicImportSettled();
  for (const port of widgetPorts.splice(0)) {
    port.close();
  }
  for (const host of widgets.keys()) {
    unmountWidget(host);
  }
  document.body.replaceChildren();
  delete document.documentElement.dataset.themeMode;
});

describe("widget-card", () => {
  it("exports the current raw frame after replacing its URL", async () => {
    const exportImage = vi.spyOn(widgetExport, "exportWidget").mockResolvedValue("png");
    onTestFinished(() => exportImage.mockRestore());
    const host = connectedHost();
    const preview = documentPreview("cv_export_one", { title: "Raw widget" });
    mountWidget(preview, undefined, host);
    const first = host.querySelector("iframe")!;
    await downloadWidget(host);
    expect(exportImage).toHaveBeenLastCalledWith("download", first, "Raw widget", {
      documentHtml: undefined,
    });

    mountWidget(
      { ...preview, url: "/__openclaw__/canvas/documents/cv_export_two/index.html" },
      undefined,
      host,
    );
    const current = host.querySelector("iframe")!;
    expect(current).not.toBe(first);
    expect(first.isConnected).toBe(false);
    await downloadWidget(host);
    expect(exportImage).toHaveBeenLastCalledWith("download", current, "Raw widget", {
      documentHtml: undefined,
    });
    expect(exportImage).toHaveBeenCalledTimes(2);
  });

  it("reads the managed export frame and document when the action is selected", async () => {
    const exportImage = vi.spyOn(widgetExport, "exportWidget").mockResolvedValue("png");
    onTestFinished(() => exportImage.mockRestore());
    const { gateway } = createApplicationGateway();
    const sessions = createTestSessionCapability(gateway);
    const provider = createApplicationContextProvider(createContext(gateway, sessions));
    const host = document.createElement("div");
    provider.append(host);
    document.body.append(provider);
    onTestFinished(() => {
      unmountWidget(host);
      sessions.dispose();
      disposeSidebarContextLifecycles();
    });
    mountWidget(
      documentPreview("cv_export_managed", {
        title: "Managed widget",
        viewId: "cv_export_managed",
      }),
      undefined,
      host,
    );
    await vi.dynamicImportSettled();
    const widget = host.querySelector("openclaw-canvas-widget-view")!;
    const previewFrame = document.createElement("iframe");
    const documentHtml = "<!doctype html><title>Managed export</title>";
    Object.defineProperties(widget, {
      previewFrame: { configurable: true, get: () => previewFrame },
      documentHtml: { configurable: true, get: () => documentHtml },
    });
    // The owner can expose a frame after adoption without placing it beneath the menu.
    document.body.append(previewFrame);
    await downloadWidget(host);
    expect(exportImage).toHaveBeenCalledExactlyOnceWith(
      "download",
      previewFrame,
      "Managed widget",
      { documentHtml },
    );
  });

  it("keeps theme delivery attached to a retained mounted frame", async () => {
    const host = connectedHost();
    mountWidget(
      { ...canvasPreview, url: "https://example.test/theme-widget", sandbox: "scripts" },
      { allowExternalEmbedUrls: true },
      host,
    );
    const frame = host.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    frame.dispatchEvent(new Event("load"));
    frame.className = "";
    post.mockClear();

    document.documentElement.dataset.themeMode = "light";
    await Promise.resolve();
    expect(host.querySelector("iframe")).toBe(frame);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "openclaw:widget-theme", mode: "light" }),
      "*",
    );
  });

  it("keeps initialized frames stable through capability and transport generations", () => {
    const firstPreview = documentPreview("cv_surface_lease_one");
    const host = connectedHost();
    showCapability(firstPreview, host, "one");
    const originalFrame = host.querySelector<HTMLIFrameElement>("iframe");
    const originalSrc = originalFrame?.getAttribute("src");
    expect(originalSrc).toContain("/__openclaw__/cap/one/");
    initializeWidgetFrame(originalFrame!);

    showCapability(firstPreview, host, "two");
    expect(host.querySelector("iframe")).toBe(originalFrame);
    expect(host.querySelector("iframe")?.getAttribute("src")).toBe(originalSrc);

    unmountWidget(host);
    showCapability(firstPreview, host, "two");
    const remountedFrame = host.querySelector("iframe");
    expect(remountedFrame).not.toBe(originalFrame);
    expect(remountedFrame?.getAttribute("src")).toContain("/__openclaw__/cap/two/");
    initializeWidgetFrame(remountedFrame!);

    bumpCanvasWidgetFrameConnectionGeneration();
    showCapability(firstPreview, host, "three");
    expect(host.querySelector("iframe")).toBe(remountedFrame);
  });

  it("replaces an uninitialized failed frame when its capability rotates", () => {
    const preview = documentPreview("cv_initial_rotation");
    const host = connectedHost();
    const show = (capability: string) => showCapability(preview, host, capability);

    show("hello");
    const original = host.querySelector("iframe")!;
    // HTTP error documents also dispatch load, but offer no widget bridge.
    original.dispatchEvent(new Event("load"));
    show("renewed");
    const renewed = host.querySelector("iframe")!;
    expect(renewed).not.toBe(original);
    expect(renewed.getAttribute("src")).toContain("/__openclaw__/cap/renewed/");

    initializeWidgetFrame(renewed);
    show("next");
    expect(host.querySelector("iframe")).toBe(renewed);
    expect(renewed.getAttribute("src")).toContain("/__openclaw__/cap/renewed/");
  });

  it("keeps a short reported frame height across a capability rotation", () => {
    const preview = documentPreview("cv_surface_lease_height");
    const host = connectedHost();
    showCapability(preview, host, "one");
    const frame = host.querySelector<HTMLIFrameElement>("iframe");
    initializeWidgetFrame(frame!);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "openclaw:widget-size", height: 48 },
        source: frame?.contentWindow,
      }),
    );
    expect(frame?.style.height).toBe("48px");

    // Re-render at the same URL so the style binding itself carries the
    // remembered height; only then can a later rotation clear it.
    showCapability(preview, host, "one");
    expect(frame?.getAttribute("style")).toContain("48px");

    // The in-frame reporter only posts when its own height changes, so a
    // rotation that lost the remembered height would strand the frame at its
    // default until the widget content happened to resize.
    showCapability(preview, host, "two");
    expect(host.querySelector("iframe")).toBe(frame);
    expect(frame?.getAttribute("style")).toContain("48px");
    host.remove();
  });

  it("unloads an external frame when external embeds become disallowed", () => {
    const preview = {
      ...canvasPreview,
      viewId: "external-policy",
      url: "https://example.test/widget",
      sandbox: "scripts",
    } as const;
    const host = mountWidget(preview, { allowExternalEmbedUrls: true });
    const allowedFrame = host.querySelector("iframe");
    expect(allowedFrame?.getAttribute("src")).toBe("https://example.test/widget");

    mountWidget(preview, { allowExternalEmbedUrls: false }, host);
    expect(host.querySelector("iframe")).not.toBe(allowedFrame);
    expect(host.querySelector("iframe")?.hasAttribute("src")).toBe(false);
  });

  it("dispatches canvas HTML and MCP App content and ignores unknown kinds", async () => {
    const canvas = mountWidget({
      ...canvasPreview,
      url: "/__openclaw__/canvas/documents/cv_dispatch/index.html",
      preferredHeight: 320,
    });
    expect(canvas.querySelector("iframe.chat-tool-card__preview-frame")).not.toBeNull();
    expect(canvas.querySelector("mcp-app-view")).toBeNull();
    expect(actionButton(canvas)).not.toBeNull();
    document.body.append(canvas);
    await openActions(canvas);
    expect(menuLabels(canvas)).toEqual(["Copy as image", "Download as image"]);

    const appPreview = {
      ...canvasPreview,
      title: "App",
      preferredHeight: 480,
      mcpApp: { viewId: "view-dispatch" },
    };
    const app = mountWidget(appPreview, { sessionKey });
    await vi.dynamicImportSettled();
    expect(customElements.get("mcp-app-view")).toBeDefined();
    expect(app.querySelector("mcp-app-view")).not.toBeNull();
    expect(app.querySelector(".chat-tool-card__preview")?.getAttribute("data-content-kind")).toBe(
      "mcp-app",
    );
    expect(app.querySelector("iframe")).toBeNull();
    expect(actionButton(app)).toBeNull();

    mountWidget(appPreview, { sessionKey, rawText: "raw app payload" }, app);
    expect(actionButton(app)).not.toBeNull();

    const external = mountWidget(
      {
        ...canvasPreview,
        url: "https://example.test/widget",
      },
      { allowExternalEmbedUrls: true, rawText: "external raw payload" },
    );
    document.body.append(external);
    await openActions(external);
    expect(menuLabels(external)).toEqual(["Show raw details"]);

    const unknown = mountWidget({ kind: "unknown" } as never);
    expect(unknown.childElementCount).toBe(0);
  });

  it("pins default-script Canvas HTML through the board provider", async () => {
    const pinWidget = vi.fn(async () => undefined);
    const { provider, snapshot } = boardProvider({ pinWidget });
    const mount = (preview: PreviewState["preview"], options: PreviewState["options"] = {}) =>
      mountWidget(preview, { boardProvider: provider, ...options });
    const canvas = mount(
      documentPreview("cv_release", {
        title: "Release status",
        viewId: " cv_release ",
        sandbox: undefined,
      }),
    );
    expect(canvas.querySelector("openclaw-canvas-widget-view")).not.toBeNull();
    pinButton(canvas)?.click();
    await vi.waitFor(() => {
      expect(pinWidget).toHaveBeenCalledWith({
        docId: "cv_release",
        name: "canvas-cv_release",
        title: "Release status",
      });
    });

    snapshot.value = {
      ...snapshot.value,
      revision: 1,
      widgets: [boardWidget("release-status")],
    };
    const pinned = mount(
      documentPreview("cv_release", { viewId: "cv_release", boardWidgetName: "release-status" }),
    );
    expect(pinButton(pinned)?.disabled).toBe(true);
    expect(pinButton(pinned)?.getAttribute("aria-label")).toBe("Pinned");

    const external = mount(
      {
        ...canvasPreview,
        viewId: "cv_external",
        url: "https://example.com/widget.html",
        sandbox: "scripts",
      },
      { allowExternalEmbedUrls: true },
    );
    expect(pinButton(external)).toBeNull();

    const mismatched = mount(documentPreview("cv_other", { viewId: "cv_expected" }));
    expect(pinButton(mismatched)).toBeNull();

    const strict = mount(documentPreview("cv_strict", { viewId: "cv_strict", sandbox: "strict" }));
    expect(pinButton(strict)).toBeNull();

    const app = mount(
      {
        ...canvasPreview,
        viewId: "cv_app",
        mcpApp: { viewId: "cv_app" },
      },
      { sessionKey },
    );
    expect(pinButton(app)).toBeNull();
  });

  it("pins an MCP App using only its view identity", async () => {
    const pinMcpApp = vi.fn(async () => undefined);
    const { provider } = boardProvider({ canPinMcpApps: true, pinMcpApp });
    const preview = {
      ...canvasPreview,
      title: "Weather",
      mcpApp: {
        viewId: " mcp-app-source ",
        serverName: "weather",
        toolName: "show",
        uiResourceUri: "ui://weather/app",
        toolCallId: "call-1",
        originSessionKey: "agent:main:main",
      },
    };

    const origin = mountWidget(preview, { boardProvider: provider, sessionKey });
    pinButton(origin)?.click();
    await vi.waitFor(() =>
      expect(pinMcpApp).toHaveBeenCalledWith({
        viewId: "mcp-app-source",
        name: mcpAppWidgetNameForViewId("mcp-app-source"),
        title: "Weather",
      }),
    );

    const unsupportedProvider = { ...provider, canPinMcpApps: false } as BoardProvider;
    const unsupported = mountWidget(preview, {
      boardProvider: unsupportedProvider,
      sessionKey,
    });
    expect(pinButton(unsupported)).toBeNull();

    const missingView = mountWidget(
      { ...preview, mcpApp: { ...preview.mcpApp, viewId: "   " } },
      { boardProvider: provider, sessionKey },
    );
    expect(pinButton(missingView)).toBeNull();
  });
});

describe("widget-card presentation", () => {
  it("releases placement observation while a retained widget is hidden", () => {
    const observers: ResizeObserverStub[] = [];
    class ResizeObserverStub implements ResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      constructor(private readonly callback: ResizeObserverCallback) {
        observers.push(this);
      }
      deliver() {
        this.callback([], this);
      }
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const frames: FrameRequestCallback[] = [];
    const request = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    const [presented, setPresented] = createSignal(true);
    const [options, setOptions] = createSignal({ rawText: "Widget details" });
    const root = mountSolid(() => (
      <ContentPresentation value={presented}>
        <div class="chat-thread">
          <ToolPreview
            preview={{ ...canvasPreview, url: "about:blank", sandbox: "strict" }}
            surface="chat_message"
            options={options()}
          />
        </div>
      </ContentPresentation>
    ));
    onTestFinished(() => {
      root.unmount();
      request.mockRestore();
      cancel.mockRestore();
      vi.unstubAllGlobals();
    });
    flush();
    expect(observers).toHaveLength(1);
    expect(observers[0]?.observe).toHaveBeenCalledTimes(2);
    const frame = root.container.querySelector("iframe");
    const thread = root.container.querySelector<HTMLElement>(".chat-thread")!;
    const preview = root.container.querySelector<HTMLElement>(".chat-tool-card__preview")!;
    vi.spyOn(thread, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
    Object.defineProperty(thread, "clientWidth", { value: 100 });
    const geometry = vi
      .spyOn(preview, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 90, 100));
    observers[0]?.deliver();
    expect(preview.hasAttribute("data-widget-actions-above")).toBe(false);
    frames.shift()?.(0);
    expect(preview.hasAttribute("data-widget-actions-above")).toBe(true);

    setOptions({ rawText: "Updated widget details" });
    flush();
    expect(observers).toHaveLength(1);
    expect(observers[0]?.disconnect).not.toHaveBeenCalled();

    geometry.mockReturnValue(new DOMRect(0, 0, 50, 100));
    observers[0]?.deliver();
    setPresented(false);
    flush();
    frames.shift()?.(0);
    expect(preview.hasAttribute("data-widget-actions-above")).toBe(true);
    expect(observers[0]?.disconnect).toHaveBeenCalledOnce();
    expect(root.container.querySelector("iframe")).toBe(frame);

    setPresented(true);
    flush();
    observers[1]?.deliver();
    frames.shift()?.(0);
    expect(observers).toHaveLength(2);
    expect(preview.hasAttribute("data-widget-actions-above")).toBe(false);
    expect(root.container.querySelector("iframe")).toBe(frame);
  });

  const preview = documentPreview("cv_clock", { title: "Clock", viewId: "cv_clock" });

  it.each([
    ["strict", "scripts", false],
    ["trusted", undefined, true],
    ["trusted", "strict", false],
  ] as const)("applies %s policy to preview sandbox %s", (embedSandboxMode, sandbox, scripted) => {
    const { provider, snapshot } = boardProvider();
    snapshot.value = {
      ...snapshot.value,
      revision: 1,
      widgets: [boardWidget("canvas-cv_clock")],
    };
    const host = mountWidget(
      { ...preview, sandbox },
      { embedSandboxMode, boardProvider: provider },
    );
    const managedView = host.querySelector("openclaw-canvas-widget-view");
    expect(managedView !== null).toBe(sandbox !== "strict");
    expect(pinButton(host) !== null).toBe(scripted);
    if (managedView) {
      expect(managedView.allowScripts).toBe(scripted);
      expect(host.querySelector("iframe")).toBeNull();
    } else {
      expect(host.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
    }
  });
});
