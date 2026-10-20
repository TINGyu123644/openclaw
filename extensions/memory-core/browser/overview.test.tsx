/* @vitest-environment jsdom */

import { render } from "@solidjs/web";
import type {
  ControlUiComponentHandle,
  ControlUiSettingsComponents,
  DoctorMemoryStatusPayload,
} from "openclaw/plugin-sdk/control-ui";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  containerForTest,
  contextForTest,
  disposers,
  disposeTestViews,
  mountSettingsView,
  snapshot,
  waitForSolid,
} from "./memory.test-support.ts";
afterEach(disposeTestViews);
// SDK component doubles expose content and callbacks, not host styling or artwork.
function createTestComponents(): ControlUiSettingsComponents {
  function mount<P>(
    container: HTMLElement,
    initial: P,
    draw: (props: P) => HTMLElement,
  ): ControlUiComponentHandle<P> {
    const update = (props: P) => container.replaceChildren(draw(props));
    update(initial);
    return { update, dispose: () => container.replaceChildren() };
  }
  const text = (tag: string, ...content: (string | number | HTMLElement | undefined)[]) => {
    const element = document.createElement(tag);
    for (const child of content) {
      if (child !== undefined) {
        element.append(typeof child === "number" ? String(child) : child);
      }
    }
    return element;
  };
  return {
    mountSection: (container, props) =>
      mount(container, props, (next) => text("section", text("h3", next.title), next.content)),
    mountRow: (container, props) =>
      mount(container, props, (next) => {
        const row = text("div", next.title, next.description, next.control);
        row.className = "settings-row";
        return row;
      }),
    mountStatus: (container, props) => mount(container, props, (next) => text("span", next.label)),
    mountValue: (container, props) => mount(container, props, (next) => text("span", next.value)),
    mountNavigation: (container, props) =>
      mount(container, props, (next) => {
        const button = text("button", next.title);
        button.addEventListener("click", next.onClick);
        return button;
      }),
    mountLobster: (container, props) =>
      mount(container, props, (next) => {
        const pet = text("span");
        pet.dataset.testLobster = "";
        pet.dataset.reading = String(next.reading === true);
        pet.dataset.sleeping = String(next.sleeping === true);
        return pet;
      }),
  };
}

import type { MemoryOverviewStatus } from "./controller.ts";
import { settingsViews } from "./index.tsx";
import { createMemoryOverview } from "./overview.tsx";

type MemoryOverviewProps = Parameters<ReturnType<typeof createMemoryOverview>>[0];
function expectText(container: HTMLElement, included: string[], excluded: string[] = []) {
  for (const text of included) {
    expect(container.textContent).toContain(text);
  }
  for (const text of excluded) {
    expect(container.textContent).not.toContain(text);
  }
}
const findButton = (container: HTMLElement, label: RegExp) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    label.test(button.textContent?.trim() ?? ""),
  );

function fixturePayload(): DoctorMemoryStatusPayload {
  const phaseBase = {
    enabled: true,
    cron: "0 3 * * *",
    managedCronPresent: true,
    nextRunAtMs: Date.now() + 60_000,
  };
  return {
    agentId: "main",
    provider: "local",
    embedding: { ok: true, checked: true },
    embeddingRuntime: {
      engine: "llama.cpp",
      state: "ready",
      backend: "metal",
      buildInfo: "b10357 (689e227db)",
      model: { id: "embeddinggemma-300m-qat-q8_0" },
      endpoints: {
        health: "ready",
        models: "ready",
        props: "ready",
        metrics: "ready",
      },
    },
    dreaming: {
      enabled: true,
      timezone: "Europe/Vienna",
      verboseLogging: false,
      storageMode: "inline",
      separateReports: false,
      shortTermCount: 4,
      recallSignalCount: 8,
      dailySignalCount: 3,
      groundedSignalCount: 2,
      totalSignalCount: 13,
      phaseSignalCount: 7,
      lightPhaseHitCount: 5,
      remPhaseHitCount: 2,
      promotedTotal: 21,
      promotedToday: 3,
      shortTermEntries: [],
      signalEntries: [],
      promotedEntries: [],
      phases: {
        light: { ...phaseBase, lookbackDays: 7, limit: 20 },
        deep: {
          ...phaseBase,
          limit: 10,
          minScore: 0.7,
          minRecallCount: 3,
          minUniqueQueries: 2,
          recencyHalfLifeDays: 14,
        },
        rem: { ...phaseBase, lookbackDays: 30, limit: 10, minPatternStrength: 0.6 },
      },
    },
  };
}

function renderOverview(
  status: MemoryOverviewStatus,
  engineSelection = snapshot().engine,
  overrides: Partial<MemoryOverviewProps> = {},
) {
  const container = containerForTest();
  const context = contextForTest(snapshot({ engine: engineSelection }), {
    components: createTestComponents(),
  });
  const MemoryOverview = createMemoryOverview(context, () => context.props);
  const props = {
    agentId: "main",
    engineSelection,
    engineDisabled: false,
    status,
    probingEmbeddings: false,
    onRefresh: vi.fn(),
    onProbeEmbeddings: vi.fn(),
    onNavigate: vi.fn(),
    ...overrides,
  };
  disposers.push(render(() => <MemoryOverview {...props} />, container));
  flush();
  return container;
}

describe("MemoryOverview", () => {
  it("renders the awake reading hero and status cards from one payload", () => {
    const container = renderOverview({ kind: "ready", payload: fixturePayload() });

    expectText(container, [
      "Memory is awake",
      "memory-core · hybrid search",
      "Sleep schedule",
      "Europe/Vienna",
      "Promoted today",
      "21",
      "b10357 (689e227db)",
      "metrics=ready",
    ]);
    expect(container.querySelector('[data-reading="true"]')).not.toBeNull();
  });

  it("renders a grumpy error hero with retry and no book", () => {
    const container = renderOverview({ kind: "error", message: "gateway request failed" });

    expectText(container, ["Memory needs attention", "gateway request failed", "Retry"]);
    expect(container.querySelector('[data-reading="true"]')).toBeNull();
  });

  it("renders the dimmed sleeping hero when the engine is off", () => {
    const container = renderOverview(
      { kind: "idle" },
      { kind: "off", id: null, availability: "enabled" },
    );

    expectText(container, ["Memory is hibernating", "Open Settings"]);
    expect(container.querySelector(".memory-overview__hero--sleeping")).not.toBeNull();
    expect(container.querySelector("[data-test-lobster]")).not.toBeNull();
    expect(container.querySelector('[data-reading="true"]')).toBeNull();
  });

  it("hibernates a disabled pinned engine and points to Settings", () => {
    const container = renderOverview(
      { kind: "ready", payload: fixturePayload() },
      { kind: "pinned", id: "memory-core", availability: "enabled" },
      { engineDisabled: true },
    );

    expectText(
      container,
      ["Memory is hibernating", "selected memory engine is disabled", "Open Settings"],
      ["Engine health", "Sleep schedule"],
    );
    expect(container.querySelector('[data-reading="true"]')).toBeNull();
  });

  it("reports every phase disabled when the global dream cycle is off", () => {
    const payload = fixturePayload();
    if (payload.dreaming) {
      payload.dreaming.enabled = false;
    }
    const container = renderOverview({ kind: "ready", payload });
    const phaseRows = [...container.querySelectorAll(".settings-row")].filter((row) =>
      /Light phase|Deep phase|REM phase/.test(row.textContent ?? ""),
    );

    expect(phaseRows).toHaveLength(3);
    expect(phaseRows.every((row) => row.textContent?.includes("Disabled"))).toBe(true);
    expect(phaseRows.every((row) => !row.textContent?.includes("next "))).toBe(true);
  });

  it("reports an enabled phase without its managed cron as not scheduled", () => {
    const payload = fixturePayload();
    if (payload.dreaming) {
      payload.dreaming.phases.light.managedCronPresent = false;
    }
    const container = renderOverview({ kind: "ready", payload });
    const lightRow = [...container.querySelectorAll(".settings-row")].find((row) =>
      row.textContent?.includes("Light phase"),
    );

    expect(lightRow?.textContent).toContain("Not scheduled");
    expect(lightRow?.textContent).not.toContain("Enabled");
    expect(lightRow?.textContent).not.toContain("next ");
  });

  it("offers an inline embedding test before readiness has been checked", () => {
    const payload = fixturePayload();
    payload.embedding = {
      ok: false,
      checked: false,
      error: "run `openclaw memory status --deep` to probe",
    };
    const onProbeEmbeddings = vi.fn();
    const container = renderOverview({ kind: "ready", payload }, undefined, {
      onProbeEmbeddings,
    });

    expect(container.textContent).toContain("Embedding readiness has not been checked yet.");
    expect(container.textContent).not.toContain("openclaw memory status --deep");
    const testButton = findButton(container, /^Test$/);
    expect(testButton?.disabled).toBe(false);
    testButton?.click();
    expect(onProbeEmbeddings).toHaveBeenCalledOnce();
  });

  it.each([
    { searchRuntimeRegistered: false, error: "memory plugin unavailable", neutral: true },
    { searchRuntimeRegistered: true, error: "search manager failed", neutral: false },
  ])("distinguishes absent search support from $error", ({ neutral, ...diagnostic }) => {
    const container = renderOverview({
      kind: "ready",
      payload: {
        agentId: "main",
        searchRuntimeRegistered: diagnostic.searchRuntimeRegistered,
        embedding: { ok: false, error: diagnostic.error },
      },
    });

    expect(container.querySelector(".memory-overview__hero h2")?.textContent).toBe(
      neutral ? "Host memory search is unavailable" : "Memory needs attention",
    );
    expect(container.textContent?.includes("Engine health")).toBe(!neutral);
    expect(container.textContent?.includes(diagnostic.error)).toBe(!neutral);
  });

  it("opens the Memories tab from the overview shortcut", () => {
    const onNavigate = vi.fn();
    const container = renderOverview({ kind: "ready", payload: fixturePayload() }, undefined, {
      onNavigate,
    });

    findButton(container, /Search memories/)?.click();
    expect(onNavigate).toHaveBeenCalledWith("memories");
  });
});

it("clears a roster error in the mounted plugin without issuing a Doctor request", async () => {
  const context = contextForTest(
    snapshot({
      agentId: null,
      agentsLoading: false,
      agentsError: "roster failed",
    }),
    { components: createTestComponents() },
  );
  const { request } = context;
  const { container, update } = mountSettingsView(settingsViews[0]!, context);
  await waitForSolid(() => expect(container.textContent).toContain("roster failed"));
  update({ agentsError: null, agentsLoading: true });
  await waitForSolid(() => expect(container.textContent).not.toContain("roster failed"));
  update({ agentsError: null, agentsLoading: false });
  await waitForSolid(() => expect(container.textContent).not.toContain("roster failed"));
  expect(request).not.toHaveBeenCalled();
});
