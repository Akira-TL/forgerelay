import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const MAX_DELIVERY_TEXT_BYTES = 64 * 1024;
const MAX_DELIVERIES_PER_RESPONSE = 4;

export type SubagentRunOutcome = "succeeded" | "failed" | "cancelled" | "interrupted";

export interface SubagentDelivery {
  sessionId: string;
  runId: string;
  workspaceId: string;
  activityId?: string;
  provider: string;
  outcome: SubagentRunOutcome;
  finalResponse?: string;
  error?: string;
  truncated: boolean;
  createdAt: string;
}

export interface WriteSubagentDeliveryInput {
  sessionId: string;
  runId: string;
  workspaceId: string;
  activityId?: string;
  provider: string;
  outcome: SubagentRunOutcome;
  finalResponse?: string;
  error?: string;
}

export class SubagentDeliveryMailbox {
  private readonly directory: string;

  constructor(stateDir: string) {
    this.directory = join(stateDir, "subagent-delivery");
  }

  write(input: WriteSubagentDeliveryInput): SubagentDelivery {
    const response = boundText(input.finalResponse);
    const error = boundText(input.error);
    const delivery: SubagentDelivery = {
      sessionId: input.sessionId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      ...(input.activityId ? { activityId: input.activityId } : {}),
      provider: input.provider,
      outcome: input.outcome,
      ...(response.text !== undefined ? { finalResponse: response.text } : {}),
      ...(error.text !== undefined ? { error: error.text } : {}),
      truncated: response.truncated || error.truncated,
      createdAt: new Date().toISOString(),
    };
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.pathFor(delivery.sessionId);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(delivery)}\n`, { mode: 0o600 });
    rmSync(path, { force: true });
    renameSync(temporary, path);
    return delivery;
  }

  claimWorkspace(workspaceId: string, excludeRunId?: string): SubagentDelivery[] {
    return this.claim((delivery) =>
      delivery.workspaceId === workspaceId && delivery.runId !== excludeRunId
    );
  }

  claimSession(workspaceId: string, sessionId: string): SubagentDelivery[] {
    return this.claim((delivery) =>
      delivery.workspaceId === workspaceId && delivery.sessionId === sessionId
    );
  }

  hasSession(sessionId: string): boolean {
    return this.files().includes(`${sessionId}.json`);
  }

  private claim(predicate: (delivery: SubagentDelivery) => boolean): SubagentDelivery[] {
    const deliveries: SubagentDelivery[] = [];
    for (const file of this.files()) {
      if (deliveries.length >= MAX_DELIVERIES_PER_RESPONSE) break;
      const path = join(this.directory, file);
      const delivery = readDelivery(path);
      if (!delivery || !predicate(delivery)) continue;
      rmSync(path, { force: true });
      deliveries.push(delivery);
    }
    return deliveries.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private files(): string[] {
    try {
      return readdirSync(this.directory)
        .filter((file) => /^agt_[a-z0-9]+\.json$/i.test(file))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private pathFor(sessionId: string): string {
    if (!/^agt_[a-z0-9]+$/i.test(sessionId)) throw new Error(`Invalid Subagent Session id: ${sessionId}`);
    return join(this.directory, `${sessionId}.json`);
  }
}

function readDelivery(path: string): SubagentDelivery | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SubagentDelivery>;
    if (
      typeof value.sessionId !== "string" ||
      typeof value.runId !== "string" ||
      typeof value.workspaceId !== "string" ||
      typeof value.provider !== "string" ||
      !isOutcome(value.outcome) ||
      typeof value.createdAt !== "string"
    ) {
      return undefined;
    }
    return {
      sessionId: value.sessionId,
      runId: value.runId,
      workspaceId: value.workspaceId,
      ...(typeof value.activityId === "string" ? { activityId: value.activityId } : {}),
      provider: value.provider,
      outcome: value.outcome,
      ...(typeof value.finalResponse === "string" ? { finalResponse: value.finalResponse } : {}),
      ...(typeof value.error === "string" ? { error: value.error } : {}),
      truncated: value.truncated === true,
      createdAt: value.createdAt,
    };
  } catch {
    return undefined;
  }
}

function boundText(value: string | undefined): { text?: string; truncated: boolean } {
  if (value === undefined) return { truncated: false };
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= MAX_DELIVERY_TEXT_BYTES) return { text: value, truncated: false };
  return {
    text: bytes.subarray(0, MAX_DELIVERY_TEXT_BYTES).toString("utf8"),
    truncated: true,
  };
}

function isOutcome(value: unknown): value is SubagentRunOutcome {
  return value === "succeeded" || value === "failed" || value === "cancelled" || value === "interrupted";
}
