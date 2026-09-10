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

export interface McpV2HandlerContext {
  sessionId?: string;
  mcpReq: {
    _meta?: unknown;
    signal: AbortSignal;
    id: string | number;
  };
}

export function mcpHandlerRequestContext(
  extra: LegacyMcpHandlerExtra | McpV2HandlerContext,
): McpHandlerRequestContext {
  if ("mcpReq" in extra) {
    return {
      requestMeta: extra.mcpReq._meta,
      signal: extra.mcpReq.signal,
      transportSessionId: extra.sessionId,
      requestId: extra.mcpReq.id,
    };
  }
  return {
    requestMeta: extra._meta,
    signal: extra.signal,
    transportSessionId: extra.sessionId,
    requestId: extra.requestId,
  };
}
