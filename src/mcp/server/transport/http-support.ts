import type { Request, Response } from "express";
import { requestIp } from "../../../runtime/logging/logger.js";

export function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

export function requestLogFields(req: Request): Record<string, unknown> {
  return {
    ip: requestIp(req),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

export function mcpRequestDebugFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};

  const request = body as Record<string, unknown>;
  const rpcMethod = typeof request.method === "string" ? request.method : undefined;
  const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
    ? request.params as Record<string, unknown>
    : undefined;
  const rpcMeta = params?._meta && typeof params._meta === "object" && !Array.isArray(params._meta)
    ? params._meta as Record<string, unknown>
    : undefined;
  const rpcMetaKeys = rpcMeta ? Object.keys(rpcMeta).sort() : [];
  let rpcTarget: string | undefined;
  if (rpcMethod === "resources/read" && typeof params?.uri === "string") {
    rpcTarget = params.uri;
  } else if (rpcMethod === "tools/call" && typeof params?.name === "string") {
    rpcTarget = params.name;
  }

  return {
    rpcMethod,
    rpcTarget,
    ...(rpcMetaKeys.length > 0 ? { rpcMetaKeys } : {}),
  };
}

