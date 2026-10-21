import * as http from "node:http";
import { expect, it } from "vitest";
import { synologyChatPlugin } from "../../../extensions/synology-chat/api.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { resolveOutboundTarget } from "./targets.js";

it("rejects invalid Synology recipients before HTTP and delivers normalized numeric IDs", async () => {
  const payloads: unknown[] = [];
  const {
    listener: server,
    claim,
    releaseListener,
  } = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      http.createServer((req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          body += chunk;
        });
        req.on("end", () => {
          payloads.push(JSON.parse(new URLSearchParams(body).get("payload") ?? "{}"));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        });
      }),
  });
  try {
    const cfg = {
      channels: {
        "synology-chat": {
          token: "loopback-token",
          incomingUrl: `http://127.0.0.1:${claim.port}/webapi/entry.cgi`,
        },
      },
    };
    const resolve = (to: string) =>
      resolveOutboundTarget({ channel: "synology-chat", to, cfg, plugin: synologyChatPlugin });
    const invalid = await resolve("42oops");
    if (invalid.ok) {
      await synologyChatPlugin.outbound.sendText({
        cfg,
        text: "invalid recipient",
        to: invalid.to,
      });
    }
    expect(invalid).toMatchObject({ ok: false });
    expect(payloads).toEqual([]);

    const valid = await resolve("synology-chat:00042");
    expect(valid).toEqual({ ok: true, to: "42" });
    if (!valid.ok) {
      throw valid.error;
    }
    await synologyChatPlugin.outbound.sendText({ cfg, text: "normalized recipient", to: valid.to });
    expect(payloads).toEqual([{ text: "normalized recipient", user_ids: [42] }]);
  } finally {
    server.closeAllConnections();
    try {
      await releaseListener();
    } finally {
      await claim.release();
    }
  }
});
