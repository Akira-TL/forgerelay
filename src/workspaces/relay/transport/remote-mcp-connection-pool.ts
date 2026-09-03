import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectRemoteMcpClient } from "../auth/remote-auth.js";
import {
  openRemoteServiceEndpoint,
  type RemoteServiceEndpointLease,
} from "./remote-transport.js";
import type { ForgeRelayRemoteRecord } from "../../../runtime/config/user-config.js";

export interface RemoteMcpConnection {
  client: Client;
  endpoint: string;
}

interface PooledRemoteMcpConnection extends RemoteMcpConnection {
  lease: RemoteServiceEndpointLease;
}

interface ConnectionEntry {
  fingerprint: string;
  promise: Promise<PooledRemoteMcpConnection>;
}

export class RemoteMcpConnectionPool {
  private readonly entries = new Map<string, ConnectionEntry>();

  async get(remote: ForgeRelayRemoteRecord): Promise<RemoteMcpConnection> {
    const fingerprint = connectionFingerprint(remote);
    const existing = this.entries.get(remote.instanceId);
    if (existing?.fingerprint === fingerprint) return existing.promise;
    if (existing) await this.closeEntry(remote.instanceId, existing);

    const entry: ConnectionEntry = {
      fingerprint,
      promise: this.create(remote),
    };
    this.entries.set(remote.instanceId, entry);
    try {
      return await entry.promise;
    } catch (error) {
      if (this.entries.get(remote.instanceId) === entry) {
        this.entries.delete(remote.instanceId);
      }
      throw error;
    }
  }

  async invalidate(
    instanceId: string,
    expected?: RemoteMcpConnection,
  ): Promise<void> {
    const entry = this.entries.get(instanceId);
    if (!entry) return;
    let connection: PooledRemoteMcpConnection;
    try {
      connection = await entry.promise;
    } catch {
      if (this.entries.get(instanceId) === entry) this.entries.delete(instanceId);
      return;
    }
    if (expected && connection !== expected) return;
    await this.closeEntry(instanceId, entry, connection);
  }

  async closeAll(): Promise<void> {
    const entries = [...this.entries.entries()];
    this.entries.clear();
    await Promise.all(entries.map(async ([, entry]) => {
      try {
        const connection = await entry.promise;
        await closeConnection(connection);
      } catch {
        // Failed connection attempts already clean up their endpoint lease.
      }
    }));
  }

  private async create(remote: ForgeRelayRemoteRecord): Promise<PooledRemoteMcpConnection> {
    const lease = await openRemoteServiceEndpoint(remote.target, remote.sshRoute);
    try {
      const client = await connectRemoteMcpClient(remote, lease.endpoint);
      return { client, endpoint: lease.endpoint, lease };
    } catch (error) {
      await lease.close().catch(() => undefined);
      throw error;
    }
  }

  private async closeEntry(
    instanceId: string,
    entry: ConnectionEntry,
    resolved?: PooledRemoteMcpConnection,
  ): Promise<void> {
    if (this.entries.get(instanceId) === entry) this.entries.delete(instanceId);
    try {
      const connection = resolved ?? await entry.promise;
      await closeConnection(connection);
    } catch {
      // Failed connection attempts already clean up their endpoint lease.
    }
  }
}

async function closeConnection(connection: PooledRemoteMcpConnection): Promise<void> {
  await connection.client.close().catch(() => undefined);
  await connection.lease.close().catch(() => undefined);
}

function connectionFingerprint(remote: ForgeRelayRemoteRecord): string {
  return JSON.stringify({
    target: remote.target,
    sshRoute: remote.sshRoute ?? [],
    accessToken: remote.accessToken,
  });
}
