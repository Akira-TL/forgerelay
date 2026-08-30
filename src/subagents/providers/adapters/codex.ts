import type {
  Codex,
  CodexOptions,
  ModelReasoningEffort,
  RunResult,
  SandboxMode,
  ThreadOptions,
} from "@openai/codex-sdk";
import type {
  SubagentProviderAdapter,
  SubagentRunInput,
  SubagentRunResult,
  SubagentWriteMode,
} from "../contract.js";

interface CodexThreadLike {
  readonly id: string | null;
  run(prompt: string, options?: { signal?: AbortSignal }): Promise<RunResult>;
}

interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

type CodexFactory = (options?: CodexOptions) => CodexClientLike;

function sandboxModeFor(writeMode: SubagentWriteMode | undefined): SandboxMode {
  switch (writeMode) {
    case "allowed":
      return "workspace-write";
    case "full_access":
      return "danger-full-access";
    case "read_only":
    case undefined:
      return "read-only";
  }
}

function threadOptionsFor(input: SubagentRunInput): ThreadOptions {
  return {
    workingDirectory: input.workspace,
    sandboxMode: sandboxModeFor(input.writeMode),
    approvalPolicy: "never",
    model: input.model,
    modelReasoningEffort: input.thinking as ModelReasoningEffort | undefined,
  };
}

export class CodexSdkSubagentRuntime {
  readonly provider = "codex" as const;
  private readonly codex: CodexClientLike;

  constructor(codex: CodexClientLike) {
    this.codex = codex;
  }

  async run(input: SubagentRunInput): Promise<SubagentRunResult> {
    const options = threadOptionsFor(input);
    const thread = input.providerSessionId
      ? this.codex.resumeThread(input.providerSessionId, options)
      : this.codex.startThread(options);
    const turn = await thread.run(input.prompt, { signal: input.signal });

    return {
      provider: this.provider,
      providerSessionId: thread.id,
      finalResponse: turn.finalResponse,
    };
  }
}

export async function createCodexSdkSubagentRuntime(
  options?: CodexOptions,
  codexFactory?: CodexFactory,
): Promise<CodexSdkSubagentRuntime> {
  const factory = codexFactory ?? (await defaultCodexFactory());
  return new CodexSdkSubagentRuntime(factory(options));
}

export class CodexSubagentAdapter implements SubagentProviderAdapter {
  readonly provider = "codex" as const;

  async run(input: SubagentRunInput): Promise<SubagentRunResult> {
    const runtime = await createCodexSdkSubagentRuntime();
    return runtime.run(input);
  }
}

async function defaultCodexFactory(): Promise<CodexFactory> {
  const module = await import("@openai/codex-sdk");
  return (options) => new module.Codex(options) as Codex;
}
