import type { Request } from "express";
import { basename } from "node:path";
import { styleText, type InspectColor } from "node:util";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
export type LogFormat = "json" | "pretty";

export interface LoggingConfig {
  level: LogLevel;
  format: LogFormat;
  requests: boolean;
  assets: boolean;
  toolCalls: boolean;
  shellCommands: boolean;
  trustProxy: boolean;
}

type LogFields = Record<string, unknown>;

type PrettyFormatOptions = {
  colorize?: boolean;
  validateStream?: boolean;
  stream?: NodeJS.WritableStream;
};

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const LEVEL_STYLE: Record<Exclude<LogLevel, "silent">, InspectColor> = {
  error: "red",
  warn: "yellow",
  info: "green",
  debug: "gray",
};

const WORKSPACE_PROJECT_COLORS: readonly InspectColor[] = [
  "cyanBright",
  "greenBright",
  "yellowBright",
  "magentaBright",
  "blueBright",
  "whiteBright",
];

export function shouldLog(config: LoggingConfig, level: Exclude<LogLevel, "silent">): boolean {
  return LEVEL_WEIGHT[config.level] >= LEVEL_WEIGHT[level];
}

export function logEvent(
  config: LoggingConfig,
  level: Exclude<LogLevel, "silent">,
  event: string,
  fields: LogFields = {},
): void {
  if (!shouldLog(config, level)) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };

  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  const line = config.format === "pretty"
    ? formatPrettyLogEntry(entry, { colorize: true, stream })
    : JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function requestIp(req: Request): string | undefined {
  return req.ip ?? req.socket.remoteAddress;
}

export function requestPath(req: Request): string {
  return req.path || req.url.split("?")[0] || req.url;
}

export function transportSessionIdPrefix(
  transportSessionId: string | undefined,
): string | undefined {
  return transportSessionId ? transportSessionId.slice(0, 8) : undefined;
}

/** @deprecated Use transportSessionIdPrefix. */
export const sessionIdPrefix = transportSessionIdPrefix;

export function workspaceLogLabel(root: string, workspaceId: string): string {
  const shortWorkspaceId = workspaceId.startsWith("ws_")
    ? `ws_${workspaceId.slice(3, 11)}`
    : workspaceId.slice(0, 8);
  return `${basename(root)}/${shortWorkspaceId}`;
}

export function commandPreview(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

export function formatPrettyLogEntry(
  entry: LogFields,
  options: PrettyFormatOptions = {},
): string {
  const level = logLevel(entry.level);
  const time = formatTimestamp(entry.ts);
  const source = stringField(entry.workspace) ?? stringField(entry.workspaceId) ?? "forgerelay";
  const transportSession = level === "debug"
    ? stringField(entry.transportSessionIdPrefix)
      ?? stringField(entry.session)
      ?? stringField(entry.sessionIdPrefix)
    : undefined;
  const prefix = [
    style("gray", time, options),
    `[${style(LEVEL_STYLE[level], level.toUpperCase(), options)}]`,
    formatPrettySource(source, options),
    transportSession ? style("gray", `transport:${transportSession}`, options) : undefined,
    style("gray", "|", options),
  ].filter((value): value is string => Boolean(value)).join(" ");

  return `${prefix} ${formatPrettyMessage(entry, options)}`;
}

function formatPrettyMessage(entry: LogFields, options: PrettyFormatOptions): string {
  switch (String(entry.event)) {
    case "tool_call":
    case "artifact_tool_call":
      return formatToolMessage(entry, options);
    case "hook_call":
      return formatHookMessage(entry, options);
    case "http_request":
      return formatHttpMessage(entry, options);
    case "mcp_request":
      return formatMcpRequestMessage(entry);
    case "mcp_app_template_read":
      return formatAppTemplateMessage(entry, options, false);
    case "mcp_app_template_read_failed":
      return formatAppTemplateMessage(entry, options, true);
    case "mcp_transport_session_created":
    case "mcp_session_created":
      return `transport session ${transportSessionPrefix(entry) ?? "unknown"} created`;
    case "mcp_transport_session_closed":
    case "mcp_session_closed":
      return `transport session ${transportSessionPrefix(entry) ?? "unknown"} closed`;
    case "mcp_transport_sessions_closed":
    case "mcp_sessions_closed":
      return `${numberField(entry.count) ?? 0} transport sessions closed`;
    case "mcp_transport_session_close_failed":
    case "mcp_session_close_failed":
      return `transport session ${transportSessionPrefix(entry) ?? "unknown"} close -> ${style("red", "error", options)}`;
    case "auth_denied":
      return `auth denied${entry.reason ? `: ${String(entry.reason)}` : ""}`;
    case "mcp_request_error":
      return `mcp request -> ${style("red", `error${entry.error ? `: ${String(entry.error)}` : ""}`, options)}`;
    default:
      return formatGenericMessage(entry);
  }
}

function formatToolMessage(entry: LogFields, options: PrettyFormatOptions): string {
  const tool = stringField(entry.tool) ?? String(entry.event ?? "tool");
  const target = toolTarget(entry, tool);
  const operation = target ? `${tool} ${target}` : tool;
  const result = toolResult(entry, tool, options);
  return `${operation} -> ${result}`;
}

function toolTarget(entry: LogFields, tool: string): string | undefined {
  if (isShellTool(tool)) {
    return stringField(entry.commandPreview) ?? stringField(entry.workingDirectory);
  }
  return stringField(entry.path) ?? stringField(entry.workingDirectory);
}

function toolResult(entry: LogFields, tool: string, options: PrettyFormatOptions): string {
  if (entry.running === true) {
    const processId = entry.processId ?? entry.processSessionId;
    return style("yellow", processId === undefined ? "running" : `running process:${String(processId)}`, options);
  }

  const exitCode = numberField(entry.exitCode) ?? exitCodeFromError(entry.error);
  if (isShellTool(tool)) {
    if (exitCode !== undefined) {
      return style(exitCode === 0 ? "green" : "red", `exit=${exitCode}`, options);
    }
    if (entry.success === true) return style("green", "exit=0", options);
  }

  if (entry.success === false) {
    const error = stringField(entry.error);
    return style("red", error ? `error: ${error}` : "error", options);
  }
  if (entry.success === true) return style("green", "ok", options);
  return "done";
}

function formatHookMessage(entry: LogFields, options: PrettyFormatOptions): string {
  const name = stringField(entry.hookName) ?? "hook";
  const event = stringField(entry.hookEvent);
  const operation = event ? `hook ${name} ${event}` : `hook ${name}`;
  const exitCode = exitCodeFromHookError(entry.error);
  if (entry.success === false) {
    if (exitCode !== undefined) return `${operation} -> ${style("red", `exit=${exitCode}`, options)}`;
    const error = stringField(entry.error);
    return `${operation} -> ${style("red", error ? `error: ${error}` : "error", options)}`;
  }
  return `${operation} -> ${style("green", "exit=0", options)}`;
}

function formatHttpMessage(entry: LogFields, options: PrettyFormatOptions): string {
  const method = stringField(entry.method) ?? "HTTP";
  const path = stringField(entry.path) ?? "/";
  const status = numberField(entry.status);
  const statusText = status === undefined ? "done" : String(status);
  const statusStyle: InspectColor = status !== undefined && status >= 400 ? "red" : "green";
  return `http ${method} ${path} -> ${style(statusStyle, statusText, options)}`;
}

function formatMcpRequestMessage(entry: LogFields): string {
  const method = stringField(entry.rpcMethod) ?? stringField(entry.httpMethod) ?? "request";
  const target = stringField(entry.rpcTarget);
  return target ? `mcp ${method} ${target}` : `mcp ${method}`;
}

function formatAppTemplateMessage(
  entry: LogFields,
  options: PrettyFormatOptions,
  failed: boolean,
): string {
  const requestedUri = stringField(entry.requestedUri) ?? "unknown";
  const compatibility = stringField(entry.compatibility) ?? "unknown";
  if (failed) {
    const error = stringField(entry.error);
    return `app template ${compatibility} ${requestedUri} -> ${style("red", error ? `error: ${error}` : "error", options)}`;
  }

  const currentUri = stringField(entry.currentUri);
  const target = compatibility === "current" || !currentUri
    ? requestedUri
    : `${requestedUri} => ${currentUri}`;
  return `app template ${compatibility} ${target} -> ${style("green", "ok", options)}`;
}

function formatPrettySource(source: string, options: PrettyFormatOptions): string {
  const separator = source.lastIndexOf("/");
  if (separator <= 0 || separator === source.length - 1) {
    return style(["cyan", "underline"], source, options);
  }

  const project = source.slice(0, separator);
  const workspace = source.slice(separator + 1);
  const projectColor = WORKSPACE_PROJECT_COLORS[stableColorIndex(project)];
  return `${style([projectColor, "bold"], project, options)}/${style(["cyan", "underline"], workspace, options)}`;
}

function stableColorIndex(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % WORKSPACE_PROJECT_COLORS.length;
}

function formatGenericMessage(entry: LogFields): string {
  const event = String(entry.event ?? "log");
  const detail = [entry.reason, entry.error]
    .map((value) => stringField(value))
    .find((value) => value !== undefined);
  return detail ? `${event}: ${detail}` : event;
}

function formatTimestamp(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value ?? "");
  const two = (part: number) => String(part).padStart(2, "0");
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

function logLevel(value: unknown): Exclude<LogLevel, "silent"> {
  return value === "error" || value === "warn" || value === "debug" ? value : "info";
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function transportSessionPrefix(entry: LogFields): string | undefined {
  return stringField(entry.transportSessionIdPrefix)
    ?? stringField(entry.sessionIdPrefix)
    ?? stringField(entry.session);
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function exitCodeFromError(value: unknown): number | undefined {
  const error = stringField(value);
  if (!error) return undefined;
  const match = error.match(/Command exited with code (-?\d+)/i);
  return match ? Number(match[1]) : undefined;
}

function exitCodeFromHookError(value: unknown): number | undefined {
  const error = stringField(value);
  if (!error) return undefined;
  const match = error.match(/exited with code (-?\d+)/i);
  return match ? Number(match[1]) : undefined;
}

function isShellTool(tool: string): boolean {
  return tool === "bash" || tool === "exec_command" || tool === "write_stdin";
}

function style(
  format: InspectColor | readonly InspectColor[],
  text: string,
  options: PrettyFormatOptions,
): string {
  if (options.colorize !== true) return text;
  return styleText(format, text, {
    validateStream: options.validateStream ?? true,
    stream: options.stream ?? process.stdout,
  });
}
