import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite();

suite.define(() => {
  it.each([
    { status: "running", label: "Active run", playState: "running" },
    { status: "queued", label: "Queued", playState: "paused" },
  ])("shows a $playState ring for $status work", async ({ status, label, playState }) => {
    const mainKey = "agent:main:main";
    const queuedKey = "agent:main:queued-repair";
    const context = await suite.browser.newContext({
      ...createControlUiE2eContextOptions(),
      colorScheme: "dark",
      recordVideo: support.captureUiProofEnabled
        ? { dir: suite.artifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const workRow = (runStatus: string, extra: { unread?: boolean } = {}) =>
      sessionRow(queuedKey, "Queued repair", 1, {
        hasActiveRun: true,
        status: runStatus,
        ...extra,
      });
    const gateway = await ui.installSessionRows(
      page,
      [sessionRow(mainKey, "Main", 2), workRow(status)],
      { sessionKey: mainKey },
    );

    try {
      await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, mainKey));
      const row = page.locator(`[data-session-key="${queuedKey}"]`);
      await row.waitFor({ state: "visible", timeout: 10_000 });
      const waiting = row.getByText("Waiting for a concurrency slot", { exact: true });
      expect(await waiting.count()).toBe(0);
      expect(await row.locator(".sidebar-recent-session__subtitle").count()).toBe(0);
      const ring = row.locator(".sidebar-session-indicator .session-glyph__ring");
      async function expectRing(expectedLabel: string, expectedState: string) {
        expect(await ring.count()).toBe(1);
        expect(await ring.getAttribute("aria-label")).toBe(expectedLabel);
        expect(await ring.evaluate((element) => element.getAnimations()[0]?.playState)).toBe(
          expectedState,
        );
      }
      await expectRing(label, playState);
      const namedLink = (name: string) => row.getByRole("link", { name, exact: true });
      expect(await namedLink(`${label} Queued repair`).count()).toBe(1);
      await support.captureUiProof(suite, page, `${status}-session-ring.png`);

      const listRequests = (await gateway.getRequests("sessions.list")).length;
      await gateway.setSessionsListResponse(
        support.sessionsListResponse([
          sessionRow(mainKey, "Main", 2),
          workRow("running", { unread: true }),
        ]),
      );
      await gateway.emitGatewayEvent("sessions.changed", {
        hasActiveRun: true,
        key: queuedKey,
        reason: "agent.run.started",
        status: "running",
      });
      await expect
        .poll(() => ui.requestCount(gateway, "sessions.list"))
        .toBeGreaterThan(listRequests);
      await expect
        .poll(() =>
          row.locator(".sidebar-recent-session__link").evaluate((link) => {
            const descriptionId = link.getAttribute("aria-describedby");
            return descriptionId
              ? link.ownerDocument.getElementById(descriptionId)?.textContent
              : null;
          }),
        )
        .toBe("Unread");
      expect(await row.locator(".session-row-state").count()).toBe(0);
      expect(await row.getByRole("img", { name: "Unread", exact: true }).count()).toBe(0);
      const accessibility = await context.newCDPSession(page);
      const { nodes } = await accessibility.send("Accessibility.getFullAXTree");
      const linkNode = nodes.find(
        (node) => node.role?.value === "link" && node.name?.value === "Active run Queued repair",
      );
      expect(linkNode?.description?.value).toBe("Unread");
      expect(
        `${linkNode?.name?.value} ${linkNode?.description?.value}`.match(/Unread/g),
      ).toHaveLength(1);
      await accessibility.detach();
      expect(await namedLink("Active run Queued repair").count()).toBe(1);
      expect(await row.locator(".sidebar-recent-session__subtitle").count()).toBe(0);
      await expectRing("Active run", "running");
      await support.captureUiProof(suite, page, `${status}-session-running.png`);
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(path.join(suite.artifactDir, `${status}-session-ring.webm`));
      }
    }
  });
});
