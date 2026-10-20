import { describe, expect, it } from "vitest";
import {
  isBenignUncaughtExceptionError,
  isTransientNetworkError,
  isTransientSqliteError,
  isTransientUnhandledRejectionError,
} from "./unhandled-rejections.js";

const codedError = (code: string, message = code) => Object.assign(new Error(message), { code });
const causedBy = (cause: unknown, message = "model call failed") => new Error(message, { cause });

describe("network rejection regressions", () => {
  it("recognizes destroyed HTTP/2 sessions, including wrapped failures", () => {
    const error = codedError("ERR_HTTP2_INVALID_SESSION", "The session has been destroyed");
    expect(isTransientNetworkError(error)).toBe(true);
    expect(isTransientNetworkError(causedBy(error))).toBe(true);
    expect(isTransientNetworkError(new Error("ERR_HTTP2_INVALID_SESSION"))).toBe(true);
  });

  it("recognizes wrapped fetch failures without swallowing HTTP failures", () => {
    expect(
      isTransientNetworkError(new Error("Failed to get gateway information: fetch failed")),
    ).toBe(true);
    expect(isTransientNetworkError(new Error("Web fetch failed (404): Not Found"))).toBe(false);
  });

  it("recognizes upstream-connect failures wrapped as JSON parse errors", () => {
    expect(
      isTransientNetworkError(
        new Error(
          `Failed to get gateway information from Discord: Unexpected token 'u', "upstream connect error or disconnect/reset before headers. reset reason: overflow" is not valid JSON`,
        ),
      ),
    ).toBe(true);
  });

  it("keeps permanent WebSocket closes fatal despite transient wrapper text", () => {
    const cause = codedError(
      "ERR_WEBSOCKET_NON_RETRYABLE_CLOSE",
      "WebSocket closed 1008 policy violation: ECONNRESET",
    );
    expect(isTransientNetworkError(causedBy(cause, "socket hang up"))).toBe(false);
  });
});

describe("SQLite rejection classification", () => {
  it.each([
    codedError("SQLITE_CANTOPEN"),
    Object.assign(new Error("unable to open database file"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 14,
    }),
    new Error("SQLITE_BUSY: database is locked"),
  ])("recognizes transient SQLite failure %#", (error) => {
    expect(isTransientSqliteError(error)).toBe(true);
  });

  it("keeps constraint violations fatal", () => {
    expect(
      isTransientSqliteError(codedError("SQLITE_CONSTRAINT", "UNIQUE constraint failed")),
    ).toBe(false);
    expect(
      isTransientSqliteError({
        code: "ERR_SQLITE_ERROR",
        message: "constraint failed",
        errcode: 19,
        errstr: "constraint failed",
      }),
    ).toBe(false);
  });
});

describe("watcher rejection classification", () => {
  it.each([
    [null, false],
    ["string error", false],
    [codedError("ENOSPC", "watcher error: ENOSPC"), true],
    [codedError("ENOSPC", "write failed: no space left on device"), false],
    [new Error("file watcher: no space left on device"), true],
    [new Error("watcher error: ENOSPC"), false],
  ])("requires watcher resource exhaustion for input %#", (error, transient) => {
    expect(isTransientUnhandledRejectionError(error)).toBe(transient);
  });
});

it("restricts benign uncaught exceptions to known transport failures", () => {
  const check = (error: Error, benign: boolean) =>
    expect(isBenignUncaughtExceptionError(error)).toBe(benign);
  check(codedError("EPIPE"), true);
  check(codedError("ENETDOWN"), true);
  check(new Error("connect ENETDOWN 192.0.2.1:443"), true);
  check(causedBy(codedError("ERR_HTTP2_INVALID_SESSION")), true);
  check(
    causedBy(
      new Error("WebSocket was closed before the connection was established"),
      "reconnect failed",
    ),
    true,
  );
  check(causedBy(new TypeError("terminated"), "fetch failed"), true);
  check(codedError("SQLITE_BUSY"), false);
  check(codedError("ECONNRESET"), false);
  check(new Error("terminated"), false);
  check(new TypeError("terminated unexpectedly"), false);
  check(
    new Error("WebSocket error: WebSocket was closed before the connection was established"),
    false,
  );
});
