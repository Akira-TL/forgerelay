export interface McpHandlerRequestContext {
  requestMeta: unknown;
  signal: AbortSignal;
  transportSessionId: string | undefined;
  requestId: string | number;
}

export interface LegacyMcpHandlerExtra {
  _meta?: unknown;
  signal: AbortSignal;
  sessionId?: string;
  requestId: string | number;
}

export function mcpHandlerRequestContext(
  extra: LegacyMcpHandlerExtra,
): McpHandlerRequestContext {
  return {
    requestMeta: extra._meta,
    signal: extra.signal,
    transportSessionId: extra.sessionId,
    requestId: extra.requestId,
  };
}
