import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite();

const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
const parentKey = "agent:main:flaky-connection";
const childKey = "agent:main:markdown-tooltip";
const otherKey = "agent:main:release-notes";

const contextOptions = {
  ...createControlUiE2eContextOptions(),
  colorScheme: "light" as const,
  viewport: { height: 720, width: 1280 },
};
async function openNestedParent(page: Page) {
  const child = sessionRow(childKey, "Fix flaky markdown file tooltip", baseTime - 1_000, {
    spawnedBy: parentKey,
  });
  const parent = sessionRow(parentKey, "Web UI flaky connection resilience", baseTime, {
    childSessions: [childKey],
  });
  const other = sessionRow(otherKey, "Release notes draft", baseTime - 5_000);
  const gateway = await support.installMockGateway(page, {
    sessions: [parent, child, other],
    methodResponses: {
      "sessions.list": {
        cases: [
          { match: { spawnedBy: parentKey }, response: support.sessionsListResponse([child]) },
          { response: support.sessionsListResponse([parent, other]) },
        ],
      },
    },
    sessionKey: otherKey,
  });
  await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, otherKey));
  const parentRow = page.locator(`[data-session-key="${parentKey}"]`);
  await parentRow.waitFor({ state: "visible", timeout: 10_000 });
  const childRow = page.locator(`[data-session-key="${childKey}"]`);
  if (!(await childRow.isVisible())) {
    await parentRow.locator(".sidebar-child-session-toggle").click();
  }
  await childRow.waitFor({ state: "visible" });
  await parentRow.hover();
  await parentRow.locator("[data-sidebar-session-archive]").click();
  const modal = await support.waitForConfirmModal(page);
  await modal.getByText("Archive session?", { exact: true }).waitFor();
  await modal
    .getByText(
      '"Web UI flaky connection resilience" has a nested session. Archive only this one and it moves to the top level.',
      { exact: true },
    )
    .waitFor();
  return { gateway, modal };
}

function archivedKeys(requests: readonly { params?: unknown }[]) {
  return requests.flatMap((request) => {
    const params = support.requireRecord(request.params);
    if (Array.isArray(params.targets)) {
      return params.targets.map((target) => String(support.requireRecord(target).key));
    }
    return params.archived === true ? [String(params.key)] : [];
  });
}
async function allArchivedKeys(gateway: Awaited<ReturnType<typeof support.installMockGateway>>) {
  return archivedKeys([
    ...(await gateway.getRequests("sessions.patch")),
    ...(await gateway.getRequests("sessions.patchMany")),
  ]);
}

suite.define(() => {
  it("asks before archiving a session with nested sessions and archives only the parent", () =>
    suite.withPage(contextOptions, async ({ page }) => {
      const { gateway, modal } = await openNestedParent(page);
      await support.captureUiProof(suite, page, "nested-archive-dialog.png");
      await modal.getByRole("button", { name: "Archive this session", exact: true }).click();
      await expect.poll(() => allArchivedKeys(gateway)).toEqual([parentKey]);
      await page.getByText("Session archived", { exact: true }).waitFor();
      await support.captureUiProof(suite, page, "nested-archive-this-session.png");
    }));

  it("archives the whole nested tree from the same dialog", () =>
    suite.withPage(contextOptions, async ({ page }) => {
      const { gateway, modal } = await openNestedParent(page);
      await modal.getByRole("button", { name: "Archive 2 sessions", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.patchMany")).length)
        .toBe(1);
      const [request] = await gateway.getRequests("sessions.patchMany");
      expect(archivedKeys([request!])).toEqual([childKey, parentKey]);
    }));

  it("archives nothing when the dialog is cancelled", () =>
    suite.withPage(contextOptions, async ({ page }) => {
      const { gateway, modal } = await openNestedParent(page);
      await modal.getByRole("button", { name: "Cancel", exact: true }).click();
      await modal.locator("dialog[open]").waitFor({ state: "detached" });
      expect(await allArchivedKeys(gateway)).toEqual([]);
    }));
});
