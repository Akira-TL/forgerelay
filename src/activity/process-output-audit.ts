export interface ProcessAuditContext {
  activityId: string;
  turnId: string;
  conversationScopeId?: string;
}

export type ProcessOutputChannel = "stdout" | "stderr" | "pty" | "process";

export interface ProcessOutputAuditSink {
  begin(input: {
    activityId: string;
    turnId: string;
    conversationScopeId?: string;
    processId: number;
    workspaceId: string;
    workspaceRoot: string;
    command: string;
    tty: boolean;
  }): string;
  append(outputId: string, channel: ProcessOutputChannel, data: Uint8Array | string): void;
  finish(outputId: string, input: {
    exitCode?: number;
    signal?: string;
    timedOut: boolean;
    error?: string;
  }): void;
}
