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
}

export class McpTransportRegistry<TTransport extends ClosableMcpTransport> {
  private readonly transports = new Map<string, McpTransportEntry<TTransport>>();
  private readonly now: () => number;

  constructor(options: McpTransportRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.transports.size;
  }

  register(transportSessionId: string, transport: TTransport): void {
    this.transports.set(transportSessionId, {
      transport,
      lastActivityAt: this.now(),
    });
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
