import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { baseUrlTextInput, defineTokenCredential } from "./setup-credential.js";

type DemoAccount = {
  config: { token?: unknown; tokenFile?: string; baseUrl?: string };
  token?: string;
};

const context = (config: DemoAccount["config"]) => ({
  cfg: { channels: { demo: config } } as OpenClawConfig,
  accountId: "default",
  credentialValues: {},
});
function resolveDemoAccount({ cfg }: { cfg: OpenClawConfig }): DemoAccount {
  const config = (cfg.channels?.demo ?? {}) as DemoAccount["config"];
  return { config, token: typeof config.token === "string" ? config.token : undefined };
}

function patchDemoConfig(params: {
  cfg: OpenClawConfig;
  patch: Record<string, unknown>;
  clearFields?: string[];
}): OpenClawConfig {
  const { cfg, patch, clearFields = [] } = params;
  const current = { ...((cfg.channels?.demo ?? {}) as Record<string, unknown>) };
  for (const field of clearFields) {
    delete current[field];
  }
  return {
    ...cfg,
    channels: { ...cfg.channels, demo: { ...current, ...patch } },
  } as OpenClawConfig;
}

describe("defineTokenCredential", () => {
  const definition = defineTokenCredential({
    inputKey: "token",
    configKey: "token",
    configuredFields: ["token", "tokenFile"],
    providerHint: "demo",
    credentialLabel: "token",
    envPrompt: "env",
    keepPrompt: "keep",
    inputPrompt: "input",
    resolveAccount: resolveDemoAccount,
    resolvedValue: (account) => account.token,
    envValue: () => "env-token",
    patchAccount: patchDemoConfig,
    useEnv: { clearFields: ["token", "tokenFile"] },
    set: { clearFields: ["tokenFile"], value: "resolved" },
  });

  it("inspects configured fields and resolved/env values", () => {
    expect(definition.inspect(context({ tokenFile: "/tmp/token" }))).toEqual({
      accountConfigured: true,
      hasConfiguredValue: true,
      resolvedValue: undefined,
      envValue: "env-token",
    });
  });

  it("clears sibling fields for env and set writes", async () => {
    const ctx = context({ token: "old", tokenFile: "/tmp/token", baseUrl: "https://demo" });
    const envConfig = await definition.applyUseEnv?.(ctx);
    expect(envConfig?.channels?.demo).toEqual({ baseUrl: "https://demo" });

    const setConfig = await definition.applySet?.({
      ...ctx,
      value: "raw",
      resolvedValue: "redacted",
    });
    expect(setConfig?.channels?.demo).toEqual({ token: "redacted", baseUrl: "https://demo" });
  });
});

it("baseUrlTextInput wires current, normalize, validate, and patch behavior", async () => {
  const input = baseUrlTextInput({
    inputKey: "httpUrl",
    configKey: "baseUrl",
    message: "URL",
    resolveAccount: resolveDemoAccount,
    currentValue: (account) => account.config.baseUrl,
    includeInitialValue: true,
    validate: (value) => (value.startsWith("https://") ? undefined : "https required"),
    normalize: (value) => value.trim().replace(/\/$/, ""),
    patchAccount: patchDemoConfig,
  });
  const ctx = context({ baseUrl: "https://old" });
  expect(await input.currentValue?.(ctx)).toBe("https://old");
  expect(input.validate?.({ ...ctx, value: "http://bad" })).toBe("https required");
  expect(input.normalizeValue?.({ ...ctx, value: " https://new/ " })).toBe("https://new");
  expect(await input.applySet?.({ ...ctx, value: "https://new" })).toEqual({
    channels: { demo: { baseUrl: "https://new" } },
  });
});
