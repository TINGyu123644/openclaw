import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { serveWorkspaceSkills } from "./workspace-worker.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

it("uses the native dependency recipe validator without any source paths", async () => {
  const { invoke, messages } = fixture();
  await invoke("installDependencies", {
    skillKey: "test",
    spec: { kind: "node", package: "--not-a-package" },
    preferences: { nodeManager: "npm", preferBrew: false },
    timeoutMs: 1000,
  });
  expect(messages).toMatchObject([
    {
      ok: false,
      message: "node package value is empty or starts with a dash",
    },
  ]);
});

function fixture() {
  const home = temporary.make("skills-worker-");
  const workspace = path.join(home, "workspace");
  const output = new PassThrough();
  const messages: unknown[] = [];
  output.on("data", (chunk: Buffer) => messages.push(JSON.parse(chunk.toString())));
  const run = (operation: string, input: Readable) =>
    serveWorkspaceSkills({ home, workspace, operation, input, output });
  return {
    home,
    workspace,
    output,
    messages,
    run,
    invoke: (operation: string, request: unknown) =>
      run(operation, Readable.from([JSON.stringify(request)])),
  };
}

it.each([false, true])(
  "supports the SSH publisher's single policy reply (allowed=%s)",
  async (allowed) => {
    const f = fixture();
    const extractedRoot = path.join(f.home, ".cache/openclaw/skill-installs/source");
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.writeFile(path.join(extractedRoot, "SKILL.md"), "# Test skill\n");
    const input = new PassThrough();
    const { messages } = f;
    const prepared = new Promise<void>((resolve) => {
      f.output.once("data", () => resolve());
    });
    const run = f.run("applyRoot", input);
    input.write(`${JSON.stringify({ extractedRoot, slug: "test", mode: "install" })}\n`);
    await prepared;
    expect(messages).toEqual([{ type: "prepared", mode: "install" }]);
    await expect(fs.stat(path.join(f.workspace, "skills/test"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    input.end(
      `${JSON.stringify({ decision: allowed ? null : { error: "Denied by policy", failureKind: "invalid-request" } })}\n`,
    );
    await run;
    expect(messages).toHaveLength(2);
    if (allowed) {
      expect(messages[1]).toMatchObject({ type: "result", result: { ok: true, mode: "install" } });
      expect(await fs.readFile(path.join(f.workspace, "skills/test/SKILL.md"), "utf8")).toBe(
        "# Test skill\n",
      );
      return;
    }
    expect(messages[1]).toEqual({
      type: "result",
      result: { ok: false, error: "Denied by policy", failureKind: "invalid-request" },
    });
    await expect(fs.stat(path.join(f.workspace, "skills/test"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it.each([
  { operation: "discovery", error: "does not match the provisioned workspace" },
  { operation: "unknown", error: "Unknown skill worker operation" },
])(
  "rejects $operation before scanning an unprovisioned workspace",
  async ({ operation, error }) => {
    const f = fixture();
    await expect(
      f.invoke(
        operation,
        operation === "discovery"
          ? { sourcePlan: { workspaceDir: path.join(f.home, "other") } }
          : {},
      ),
    ).rejects.toThrow(error);
  },
);
