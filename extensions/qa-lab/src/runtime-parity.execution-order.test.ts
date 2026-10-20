import { describe, expect, it, vi } from "vitest";
import type { RuntimeId } from "./runtime-id.js";
import {
  isRuntimeParityResultPass,
  runRuntimeParityScenario,
  type RuntimeParityCell,
} from "./runtime-parity.js";

function makeRuntimeParityCell(runtime: RuntimeId): RuntimeParityCell {
  return {
    runtime,
    transcriptBytes: '{"message":{"role":"assistant","content":"done"}}\n',
    toolCalls: [],
    finalText: "done",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    wallClockMs: 10,
    bootStateLines: [],
  };
}

function passingRunner() {
  return vi.fn(async (runtime: RuntimeId) => ({
    status: "pass" as const,
    cell: makeRuntimeParityCell(runtime),
  }));
}

describe("runtime parity execution order", () => {
  it.each([{ runtimePair: undefined }, { runtimePair: ["codex", "openclaw"] }] satisfies Array<{
    runtimePair: [RuntimeId, RuntimeId] | undefined;
  }>)(
    "runs pair %j in its requested order with canonical result cells",
    async ({ runtimePair }) => {
      const runCell = passingRunner();
      const result = await runRuntimeParityScenario({
        scenarioId: "runtime-execution-order",
        ...(runtimePair ? { runtimePair } : {}),
        runCell,
      });

      expect(runCell.mock.calls.map(([runtime]) => runtime)).toEqual(
        runtimePair ?? ["openclaw", "codex"],
      );
      expect(Object.keys(result.cells)).toEqual(["openclaw", "codex"]);
      expect(result.cells).toMatchObject({
        openclaw: { runtime: "openclaw", status: "pass" },
        codex: { runtime: "codex", status: "pass" },
      });
      expect(result.drift).toBe("none");
    },
  );

  it("rejects duplicate runtimes before executing a parity cell", async () => {
    const runCell = passingRunner();

    await expect(
      runRuntimeParityScenario({
        scenarioId: "duplicate-runtime-pair",
        runtimePair: ["openclaw", "openclaw"],
        runCell,
      }),
    ).rejects.toThrow(/different|distinct|duplicate/i);
    expect(runCell).not.toHaveBeenCalled();
  });

  it("attributes a failed reversed pair to its canonical runtime cell", async () => {
    const executionOrder: RuntimeId[] = [];
    const result = await runRuntimeParityScenario({
      scenarioId: "reversed-runtime-cell-failure",
      runtimePair: ["codex", "openclaw"],
      runCell: async (runtime) => {
        executionOrder.push(runtime);
        return {
          status: runtime === "codex" ? ("fail" as const) : ("pass" as const),
          ...(runtime === "codex" ? { details: "Codex scenario failed" } : {}),
          cell: makeRuntimeParityCell(runtime),
        };
      },
    });

    expect(executionOrder).toEqual(["codex", "openclaw"]);
    expect(result).toMatchObject({
      cells: {
        openclaw: { status: "pass" },
        codex: { runtime: "codex", status: "fail", details: "Codex scenario failed" },
      },
      drift: "failure-mode",
      driftDetails: "runtime-pair cell status differs (pass vs fail)",
    });
    expect(isRuntimeParityResultPass(result)).toBe(false);
  });
});
