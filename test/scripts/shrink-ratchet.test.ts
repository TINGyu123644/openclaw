import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareRatchetCounts,
  compareRatchetSets,
  loadRatchetReference,
  loadRatchetSnapshot,
  loadRatchetSources,
  parseRatchetCounts,
  parseRatchetPaths,
  parseRatchetScalar,
  parseRatchetArgs,
  resolveRatchetBase,
} from "../../scripts/lib/shrink-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function gitRepo(prefix: string) {
  const root = tempDirs.make(prefix);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init");
  return { root, git };
}

describe("shrink-ratchet", () => {
  it("requires an explicit base when the caller supplies prepared ancestry", () => {
    expect(() => parseRatchetArgs(["--no-merge-base"])).toThrow(/requires --base/u);
    expect(parseRatchetArgs(["--base", "HEAD", "--no-merge-base"])).toMatchObject({
      base: "HEAD",
      mergeBase: false,
    });
    expect(parseRatchetArgs(["--base", "HEAD"]).mergeBase).toBe(true);
    const { root } = gitRepo("openclaw-ratchet-unavailable-");
    expect(() =>
      resolveRatchetBase(root, { base: "missing", staged: false, mergeBase: false }),
    ).toThrow(/Could not resolve ratchet base ref/u);
  });

  it("rejects missing paths whose names resemble successful batch headers", () => {
    const { root } = gitRepo("openclaw-shrink-ratchet-missing-");
    expect(() => loadRatchetSources(root, ["src/missing.ts"])).toThrow(
      /Could not read staged source/u,
    );
    expect(() => loadRatchetSources(root, ["src/missing blob 0\n\n.ts"])).toThrow(
      /Could not read staged source/u,
    );
  });

  it.each([
    {
      expected: ["src/b.ts", "src/a.ts"],
      file: "paths.txt",
      parse: (source: string) => [...parseRatchetPaths(source)],
      source: "# grandfathered files\nsrc/b.ts\nsrc/a.ts\n",
    },
    {
      expected: [
        ["src/b.ts", 2],
        ["src/a.ts", 1],
      ],
      file: "counts.txt",
      parse: (source: string) => [...parseRatchetCounts(source, "counts.txt")],
      source: "# per-file debt\nsrc/b.ts\t2\nsrc/a.ts\t1\n",
    },
  ])("loads the existing $file baseline format", ({ expected, file, parse, source }) => {
    const root = tempDirs.make("openclaw-shrink-ratchet-");
    fs.writeFileSync(path.join(root, file), source);

    expect(loadRatchetSnapshot<unknown>(root, file, false, parse)).toEqual(expected);
  });

  it("loads worktree, index, and reference snapshots beyond the Git pipe limit", () => {
    const { root, git } = gitRepo("openclaw-shrink-ratchet-git-");
    const baselinePath = "baseline.txt";
    const absolutePath = path.join(root, baselinePath);
    const padding = `#${"x".repeat(2 * 1024 * 1024)}\n`;
    fs.writeFileSync(absolutePath, padding + "1\n");
    git("add", baselinePath);
    git("-c", "user.name=OpenClaw", "-c", "user.email=test@openclaw.local", "commit", "-m", "base");
    fs.writeFileSync(absolutePath, padding + "2\n");
    git("add", baselinePath);
    fs.writeFileSync(absolutePath, padding + "3\n");
    const parse = (source: string) => parseRatchetScalar(source, baselinePath);

    expect(loadRatchetSnapshot(root, baselinePath, false, parse)).toBe(3);
    expect(loadRatchetSnapshot(root, baselinePath, true, parse)).toBe(2);
    expect(loadRatchetReference(root, "HEAD", baselinePath, parse)).toBe(1);
    expect(loadRatchetReference(root, "HEAD", "missing.txt", parse)).toBeNull();
    expect(() => loadRatchetReference(root, "missing-ref", baselinePath, parse)).toThrow();
  });

  it("rejects duplicate count-map entries", () => {
    expect(() => parseRatchetCounts("src/a.ts\t1\nsrc/a.ts\t2\n", "counts.txt")).toThrow(
      /Invalid counts\.txt entry/u,
    );
  });

  it("rejects negative scalar baselines", () => {
    expect(() => parseRatchetScalar("-1\n", "scalar.txt")).toThrow(
      /exactly one non-negative integer/u,
    );
  });

  it("compares path sets without permitting growth", () => {
    expect(
      compareRatchetSets(
        ["src/z.ts", "src/b.ts", "src/c.ts", "src/y.ts"],
        new Set(["src/x.ts", "src/a.ts", "src/b.ts", "src/w.ts"]),
      ),
    ).toEqual({
      added: ["src/c.ts", "src/y.ts", "src/z.ts"],
      removed: ["src/a.ts", "src/w.ts", "src/x.ts"],
    });
  });

  it("compares per-entry counts without permitting growth", () => {
    expect(
      compareRatchetCounts(
        new Map(Object.entries({ "src/z.ts": 1, "src/b.ts": 1, "src/c.ts": 1 })),
        new Map(Object.entries({ "src/x.ts": 1, "src/a.ts": 1, "src/b.ts": 2 })),
      ),
    ).toEqual({
      decreased: [
        { allowed: 1, current: 0, entry: "src/a.ts" },
        { allowed: 2, current: 1, entry: "src/b.ts" },
        { allowed: 1, current: 0, entry: "src/x.ts" },
      ],
      increased: [
        { allowed: 0, current: 1, entry: "src/c.ts" },
        { allowed: 0, current: 1, entry: "src/z.ts" },
      ],
    });
  });
});
