/**
 * Thin leveled logger. Today: console under the hood. Tomorrow: easy
 * swap-in of a structured sink (Logflare, Datadog, etc.) without
 * touching call sites.
 *
 * Convention:
 *  - Pass a short scope tag as the first arg (e.g. "price-cache", "scan")
 *    so log lines are grep-able. The logger renders it as `[scope]`.
 *  - Pass an Error or unknown details as the last arg.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

function emit(level: LogLevel, scope: string, message: string, details?: unknown) {
  const prefix = `[${scope}]`;
  const out =
    details === undefined
      ? [prefix, message]
      : [prefix, message, details instanceof Error ? details.message : details];
  switch (level) {
    case "debug":
      // Disabled in production — debug noise is not worth the bytes.
      if (process.env.NODE_ENV !== "production") console.debug(...out);
      break;
    case "info":
      console.info(...out);
      break;
    case "warn":
      console.warn(...out);
      break;
    case "error":
      console.error(...out);
      break;
  }
}

export const logger = {
  debug: (scope: string, message: string, details?: unknown) =>
    emit("debug", scope, message, details),
  info: (scope: string, message: string, details?: unknown) =>
    emit("info", scope, message, details),
  warn: (scope: string, message: string, details?: unknown) =>
    emit("warn", scope, message, details),
  error: (scope: string, message: string, details?: unknown) =>
    emit("error", scope, message, details),
};
