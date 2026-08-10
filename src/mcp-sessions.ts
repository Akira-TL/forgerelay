export interface ClosableMcpTransport {
  close(): Promise<void>;
}

export interface McpTransportCloseResult {
  transportSessionId: string;
  error?: unknown;
}

interface McpTransportEntry<TTransport> {
  transport: TTransport;
  lastActivityAt: number;
}

export interface McpTransportRegistryOptions {
  now?: () => number;
  maxTransports?: number;
}

export class McpTransportRegistry<TTransport extends ClosableMcpTransport> {
  private readonly transports = new Map<string, McpTransportEntry<TTransport>>();
  private readonly now: () => number;
  private readonly maxTransports: number;

  constructor(options: McpTransportRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxTransports = options.maxTransports ?? Number.POSITIVE_INFINITY;
    if (
      this.maxTransports !== Number.POSITIVE_INFINITY &&
      (!Number.isInteger(this.maxTransports) || this.maxTransports < 1)
    ) {
      throw new Error("MCP transport limit must be a positive integer.");
    }
  }

  get size(): number {
    return this.transports.size;
  }

  register(
    transportSessionId: string,
    transport: TTransport,
  ): Promise<McpTransportCloseResult[]> {
    this.transports.set(transportSessionId, {
      transport,
      lastActivityAt: this.now(),
    });

    const excess: Array<{ transportSessionId: string; transport: TTransport }> = [];
    while (this.transports.size > this.maxTransports) {
      let oldestTransportSessionId: string | undefined;
      let oldestActivityAt = Number.POSITIVE_INFINITY;
      for (const [candidateSessionId, entry] of this.transports) {
        if (candidateSessionId === transportSessionId && this.transports.size > 1) continue;
        if (entry.lastActivityAt >= oldestActivityAt) continue;
        oldestTransportSessionId = candidateSessionId;
        oldestActivityAt = entry.lastActivityAt;
      }
      if (!oldestTransportSessionId) break;
      const oldest = this.transports.get(oldestTransportSessionId);
      this.transports.delete(oldestTransportSessionId);
      if (oldest) {
        excess.push({
          transportSessionId: oldestTransportSessionId,
          transport: oldest.transport,
        });
      }
    }

    return closeTransports(excess);
  }

  get(transportSessionId: string): TTransport | undefined {
    const entry = this.transports.get(transportSessionId);
    if (!entry) return undefined;

    entry.lastActivityAt = this.now();
    return entry.transport;
  }

  remove(transportSessionId: string): boolean {
    return this.transports.delete(transportSessionId);
  }

  async closeIdle(idleTimeoutMs: number): Promise<McpTransportCloseResult[]> {
    const cutoff = this.now() - idleTimeoutMs;
    const idleTransports: Array<{ transportSessionId: string; transport: TTransport }> = [];

    for (const [transportSessionId, entry] of this.transports) {
      if (entry.lastActivityAt > cutoff) continue;

      this.transports.delete(transportSessionId);
      idleTransports.push({ transportSessionId, transport: entry.transport });
    }

    return closeTransports(idleTransports);
  }

  async closeAll(): Promise<McpTransportCloseResult[]> {
    const transports = Array.from(this.transports, ([transportSessionId, entry]) => ({
      transportSessionId,
      transport: entry.transport,
    }));
    this.transports.clear();
    return closeTransports(transports);
  }
}

async function closeTransports<TTransport extends ClosableMcpTransport>(
  transports: Array<{ transportSessionId: string; transport: TTransport }>,
): Promise<McpTransportCloseResult[]> {
  return Promise.all(
    transports.map(async ({ transportSessionId, transport }) => {
      try {
        await transport.close();
        return { transportSessionId };
      } catch (error) {
        return { transportSessionId, error };
      }
    }),
  );
}

/** @deprecated Use McpTransportCloseResult. */
export type McpSessionCloseResult = McpTransportCloseResult;
/** @deprecated Use McpTransportRegistryOptions. */
export type McpSessionRegistryOptions = McpTransportRegistryOptions;
/** @deprecated Use McpTransportRegistry. */
export { McpTransportRegistry as McpSessionRegistry };
