import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const listMock = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  resolveFeishuRuntimeAccount: () => ({
    accountId: "default",
    configured: true,
    appId: "cli_main",
    appSecret: "secret",
    domain: "feishu",
  }),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: () => ({ im: { messageReaction: { list: listMock } } }),
}));

import { listReactionsFeishu } from "./reactions.js";

function list(emojiType?: string) {
  return listReactionsFeishu({ cfg: {} as ClawdbotConfig, messageId: "om_message", emojiType });
}
type Operator = { operator_type: string; operator_id: string };
function item(id: string, emoji: string, operator?: Operator) {
  return { reaction_id: id, reaction_type: { emoji_type: emoji }, operator };
}
function reaction(reactionId: string, emojiType: string, operatorType: string, operatorId: string) {
  return { reactionId, emojiType, operatorType, operatorId };
}
function page(items: ReturnType<typeof item>[] = [], more?: string | true) {
  return {
    code: 0,
    data: {
      items,
      has_more: Boolean(more),
      ...(typeof more === "string" ? { page_token: more } : {}),
    },
  };
}

describe("listReactionsFeishu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockReset();
  });

  it("fails closed for missing or unrecognized operator metadata", async () => {
    listMock.mockResolvedValue(
      page([
        item("r-missing", "THUMBSUP"),
        item("r-unknown", "HEART", { operator_type: "tenant", operator_id: "tenant-1" }),
      ]),
    );

    expect(await list()).toEqual([
      reaction("r-missing", "THUMBSUP", "unknown", ""),
      reaction("r-unknown", "HEART", "unknown", "tenant-1"),
    ]);
  });

  it("drains every reaction page while retaining the requested emoji filter", async () => {
    listMock
      .mockResolvedValueOnce(
        page(
          [item("r-first", "HEART", { operator_type: "user", operator_id: "ou_user" })],
          "page-2",
        ),
      )
      .mockResolvedValueOnce(
        page([item("r-bot", "HEART", { operator_type: "app", operator_id: "cli_main" })]),
      );

    expect(await list("HEART")).toEqual([
      reaction("r-first", "HEART", "user", "ou_user"),
      reaction("r-bot", "HEART", "app", "cli_main"),
    ]);
    expect(listMock).toHaveBeenNthCalledWith(1, {
      path: { message_id: "om_message" },
      params: { reaction_type: "HEART" },
    });
    expect(listMock).toHaveBeenNthCalledWith(2, {
      path: { message_id: "om_message" },
      params: { reaction_type: "HEART", page_token: "page-2" },
    });
  });

  it("rejects a continuation response without its required page token", async () => {
    listMock.mockResolvedValue(page([], true));

    await expect(list()).rejects.toThrow(/page token/i);
    expect(listMock).toHaveBeenCalledOnce();
  });

  it("rejects repeated reaction page tokens", async () => {
    listMock.mockResolvedValue(page([], "same-page"));

    await expect(list()).rejects.toThrow(/repeated page token/i);
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("propagates API failures from continuation pages", async () => {
    listMock
      .mockResolvedValueOnce(page([], "page-2"))
      .mockResolvedValueOnce({ code: 9999, msg: "continuation unavailable" });

    await expect(list()).rejects.toThrow("Feishu list reactions failed: continuation unavailable");
  });
});
