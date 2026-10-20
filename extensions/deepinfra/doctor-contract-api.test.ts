import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

function deepinfraConfig(provider: Record<string, unknown>): OpenClawConfig {
  return { models: { providers: { deepinfra: provider } } } as unknown as OpenClawConfig;
}

function migratedProvider(cfg: OpenClawConfig): Record<string, unknown> {
  const providers = cfg.models?.providers as Record<string, Record<string, unknown>> | undefined;
  return providers?.deepinfra ?? {};
}

const nativeUrl = "https://api.deepinfra.com/v1/inference";
const baseUrl = "https://api.deepinfra.com/v1/openai";
function migrate(provider: Record<string, unknown>) {
  return normalizeCompatibilityConfig({ cfg: deepinfraConfig(provider) });
}
function expectMigration(
  provider: Record<string, unknown>,
  expected: Record<string, unknown>,
  change: string,
) {
  const result = migrate(provider);
  expect(result.changes).toEqual([`models.providers.deepinfra.${change}`]);
  expect(migratedProvider(result.config)).toEqual(expected);
}

// Assemble credential-shaped fixture URLs at runtime to avoid scanner false positives.
function credentialUrl(rest: string): string {
  return ["https://user", `password@${rest}`].join(":");
}

describe("DeepInfra doctor contract", () => {
  it("flags legacy nativeBaseUrl and /v1/inference baseUrl values", () => {
    const nativeRule = legacyConfigRules.find((rule) => rule.path.at(-1) === "nativeBaseUrl");
    const baseUrlRule = legacyConfigRules.find((rule) => rule.path.at(-1) === "baseUrl");
    expect(nativeRule?.message).toContain("openclaw doctor --fix");
    expect(baseUrlRule?.match?.(nativeUrl)).toBe(true);
    expect(baseUrlRule?.match?.(baseUrl)).toBe(false);
  });

  it("returns the same config when no deepinfra provider is configured", () => {
    const cfg = { models: { providers: {} } } as OpenClawConfig;
    expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
    expect(normalizeCompatibilityConfig({ cfg: {} as OpenClawConfig }).changes).toEqual([]);
  });

  it("replaces a default-valued nativeBaseUrl with the canonical baseUrl", () => {
    expectMigration(
      { apiKey: "key", nativeBaseUrl: `${nativeUrl}/` },
      { apiKey: "key", baseUrl },
      "nativeBaseUrl -> models.providers.deepinfra.baseUrl (OpenAI-compatible /v1/openai endpoint)",
    );
  });

  it("retires a custom-host nativeBaseUrl without rewriting its protocol", () => {
    const cfg = deepinfraConfig({ nativeBaseUrl: "https://gw.example.com/v1/inference" });
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.changes).toEqual([
      "models.providers.deepinfra.nativeBaseUrl: removed retired custom native endpoint; using https://api.deepinfra.com/v1/openai - set models.providers.deepinfra.baseUrl manually if your host serves an OpenAI-compatible videos API",
    ]);
    expect(migratedProvider(result.config)).toEqual({
      baseUrl: "https://api.deepinfra.com/v1/openai",
    });
  });

  it("prefers an existing baseUrl over a custom nativeBaseUrl", () => {
    const cfg = deepinfraConfig({
      baseUrl: "https://gw.example.com/v1/openai",
      nativeBaseUrl: "https://other.example.com/v1/inference",
    });
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.changes).toEqual([
      "models.providers.deepinfra.nativeBaseUrl: removed (baseUrl is already configured)",
    ]);
    expect(migratedProvider(result.config)).toEqual({
      baseUrl: "https://gw.example.com/v1/openai",
    });
  });

  it("rewrites a /v1/inference baseUrl on the DeepInfra host only", () => {
    expectMigration({ baseUrl: nativeUrl }, { baseUrl }, "baseUrl: /v1/inference -> /v1/openai");
    const customCfg = deepinfraConfig({ baseUrl: "https://gw.example.com/v1/inference" });
    expect(normalizeCompatibilityConfig({ cfg: customCfg })).toEqual({
      config: customCfg,
      changes: [],
    });
  });

  it("never echoes credentials from legacy endpoint URLs in change messages", () => {
    const nativeChanges = migrate({
      nativeBaseUrl: credentialUrl("gw.example.com/v1/inference?token=secret"),
    }).changes.join("\n");
    expect(nativeChanges).not.toMatch(/password|secret|gw\.example\.com/);

    const hostResult = migrate({
      baseUrl: credentialUrl("api.deepinfra.com/v1/inference?token=secret"),
      nativeBaseUrl: credentialUrl("api.deepinfra.com/v1/inference?token=secret"),
    });
    expect(hostResult.changes.join("\n")).not.toMatch(/password|secret/);
    // Redact messages, not the operator's migrated URL.
    expect(migratedProvider(hostResult.config)).toEqual({
      baseUrl: credentialUrl("api.deepinfra.com/v1/openai?token=secret"),
    });
  });

  it("does not mutate the input config", () => {
    const provider = { nativeBaseUrl: "https://gw.example.com/v1/inference" };
    const cfg = deepinfraConfig(provider);
    normalizeCompatibilityConfig({ cfg });
    expect(provider).toEqual({ nativeBaseUrl: "https://gw.example.com/v1/inference" });
  });
});
