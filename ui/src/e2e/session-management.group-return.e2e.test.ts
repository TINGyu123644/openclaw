import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";
import { chooseSidebarMenuOption, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = support.createSessionManagementE2eSuite();

async function setThemeMode(page: Page, mode: "dark" | "light"): Promise<void> {
  await page.emulateMedia({ colorScheme: mode });
  await page.evaluate((nextMode) => {
    const root = document.documentElement;
    root.dataset.themeMode = nextMode;
    root.dataset.themeResolved = nextMode;
    root.style.colorScheme = nextMode;
  }, mode);
  await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
}

suite.define(() => {
  it("moves a categorized group session back to Groups", () =>
    suite.withPage(
      { ...createControlUiE2eContextOptions(), colorScheme: "light" },
      async ({ page }) => {
        const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
        const key = "agent:main:done-group";
        const gateway = await ui.installSessionRows(
          page,
          [
            sessionRow("agent:main:main", "Main", baseTime),
            sessionRow(key, "Completed launch", baseTime - 60_000, {
              category: "Done",
              kind: "group",
            }),
          ],
          {
            methodResponses: { "sessions.patch": {} },
            featureMethods: [
              "chat.metadata",
              "chat.startup",
              "sessions.groups.list",
              "sessions.groups.put",
              "sessions.patch",
            ],
            sessionGroups: ["Done"],
            sessionKey: "agent:main:main",
          },
        );

        await page.goto(`${suite.server.baseUrl}chat`);
        const done = page.locator('[data-session-section="category:Done"]');
        const groups = page.locator('[data-session-section="groups"]');
        const row = done.locator(`[data-session-key="${key}"]`);
        await row.waitFor({ state: "visible", timeout: 10_000 });
        await chooseSidebarMenuOption(page, "Hide empty groups", "Never");
        await closeSidebarMenu(page);
        await groups.waitFor({ state: "visible" });

        await row.hover();
        await row.click({ button: "right" });
        await support.openSessionMenuSubmenu(page, "Move to group");
        await ui.menuItem(page, "Move back to Groups").waitFor({ state: "visible" });
        const capture = (name: string) =>
          support.captureUiProof(suite, page, `sidebar-done-return-${name}.png`);
        await setThemeMode(page, "light");
        await capture("before-light");
        await setThemeMode(page, "dark");
        await capture("before-dark");

        await setThemeMode(page, "light");
        await page.reload();
        await row.waitFor({ state: "visible", timeout: 10_000 });
        await groups.waitFor({ state: "visible" });
        await expect.poll(() => row.getAttribute("draggable")).toBe("true");
        await row.dragTo(groups, {
          sourcePosition: { x: 8, y: 8 },
          targetPosition: { x: 8, y: 8 },
        });
        const patch = await ui.sessionPatch(gateway, key, { category: null });
        expect(support.requireRecord(patch.params)).toMatchObject({ category: null, key });
        await ui.visible(groups.locator(`[data-session-key="${key}"]`));
        await capture("after-light");
        await setThemeMode(page, "dark");
        await capture("after-dark");
      },
    ));
});
