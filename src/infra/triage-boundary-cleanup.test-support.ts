import type { ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Interface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { inspectManagedProcessGroup } from "../../scripts/lib/managed-child-process.mts";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import { triageLeaseFixtureLifetime } from "./triage-lease-fixture.test-support.js";

export function cleanupTriageBoundary(fixture: {
  root: string;
  groups: string;
  helper: ChildProcess;
  parent: ChildProcess;
  exit: Promise<unknown>;
  parentExit: Promise<unknown>;
  lines: Pick<Interface, "close">;
  readEvents: () => Promise<Array<{ kind: string }>>;
  databasePath: string;
}): Promise<void> {
  return triageLeaseFixtureLifetime.verifyCleanup(async () => {
    const { root, helper, parent } = fixture;
    const deadline = Date.now() + 5000;
    // Close admission before enumerating groups, including launches awaiting registration.
    const closingGroups = path.join(root, "closing-groups");
    await fs.rename(fixture.groups, closingGroups);
    const groupReceipts = new Map([[helper.pid!, "helper"]]);
    const pendingPermissionErrors: Error[] = [];
    const failures: unknown[] = [];
    const poll = (check: () => void) =>
      vi.waitFor(check, { timeout: Math.max(1, deadline - Date.now()), interval: 20 }).then(
        () => true,
        (error: unknown) => {
          failures.push(error);
          return false;
        },
      );
    await poll(() => {
      const pending: string[] = [];
      for (const entry of readdirSync(closingGroups)) {
        const value = readFileSync(path.join(closingGroups, entry), "utf8");
        if (!/^\d+$/u.test(value)) {
          pending.push(entry);
        } else if (Number(value) > 0) {
          groupReceipts.set(Number(value), entry);
        }
      }
      if (pending.length) {
        throw new Error(`detached fixture launches have not published: ${pending.join(", ")}`);
      }
    });
    // An unpublished launch retains the files, but known actors still need joining.
    for (const [pid, receipt] of groupReceipts) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          continue;
        }
        const failure = new Error(`could not signal fixture group ${pid} (receipt ${receipt})`, {
          cause: error,
        });
        const errors =
          process.platform === "darwin" && code === "EPERM" ? pendingPermissionErrors : failures;
        errors.push(failure);
      }
    }
    for (const child of [helper, parent]) {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      } catch (error) {
        failures.push(error);
      }
    }
    await Promise.all([fixture.exit, fixture.parentExit]);
    const groupsJoined = await poll(() => {
      for (const pid of groupReceipts.keys()) {
        if (
          inspectManagedProcessGroup({ pid, exitCode: 0 }, { errorPolicy: "indeterminate" }) !==
          "dead"
        ) {
          throw new Error(`native fixture process group ${pid} has not exited`);
        }
      }
    });
    // Darwin can refuse SIGKILL for an unreaped zombie; only a complete join settles it.
    if (!groupsJoined || failures.length) {
      failures.push(...pendingPermissionErrors);
    }
    fixture.lines.close();
    if (failures.length) {
      throw new AggregateError(failures, "Could not join all native fixture process groups");
    }
    const finalEvents = await fixture.readEvents();
    const db = new DatabaseSync(fixture.databasePath);
    try {
      setSqliteBusyTimeout(db, 5000);
      db.prepare("DELETE FROM managed_update_handoffs WHERE owner = ?").run(root);
    } finally {
      db.close();
    }
    await fs.rm(root, { recursive: true, force: true });
    if (finalEvents.some((event) => event.kind === "unexpected-native")) {
      throw new Error("Triage fixture attempted an unexpected native service command");
    }
  });
}
