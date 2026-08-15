export interface CoreOperationContext {
  requestMeta?: unknown;
  signal?: AbortSignal;
  sessionId?: string;
  parentActivityId?: string;
  turnId?: string;
}

export interface ReadOperationInput {
  workspaceId: string;
  path: string;
  offset?: number;
  limit?: number;
}

export interface WriteOperationInput {
  workspaceId: string;
  path: string;
  content: string;
}

export interface EditOperationInput {
  workspaceId: string;
  path: string;
  edits: Array<{
    oldText: string;
    newText: string;
  }>;
}

export interface RenameOperationInput {
  workspaceId: string;
  path: string;
  newPath: string;
}

export interface DeleteOperationInput {
  workspaceId: string;
  path: string;
  recursive?: boolean;
}

export interface ShellRunOperationInput {
  workspaceId: string;
  command: string;
  surface: "bash" | "exec_command";
  tty?: boolean;
  columns?: number;
  rows?: number;
  workingDirectory?: string;
  yieldTimeMs?: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export interface CapabilityRunOperationInput {
  workspaceId: string;
  name: string;
  arguments?: Record<string, unknown>;
  file?: unknown;
}

export interface CoreOperationHandlers {
  read: (input: ReadOperationInput, context: CoreOperationContext) => Promise<unknown>;
  write: (input: WriteOperationInput, context: CoreOperationContext) => Promise<unknown>;
  edit: (input: EditOperationInput, context: CoreOperationContext) => Promise<unknown>;
  rename: (input: RenameOperationInput, context: CoreOperationContext) => Promise<unknown>;
  delete: (input: DeleteOperationInput, context: CoreOperationContext) => Promise<unknown>;
  shellRun: (input: ShellRunOperationInput, context: CoreOperationContext) => Promise<unknown>;
  capabilityRun: (input: CapabilityRunOperationInput, context: CoreOperationContext) => Promise<unknown>;
}

type AsyncHandler = (...args: never[]) => Promise<unknown>;
type HandlerResult<T extends AsyncHandler> = ReturnType<T>;

export class CoreOperationExecutor<THandlers extends CoreOperationHandlers> {
  constructor(private readonly handlers: THandlers) {}

  read(
    input: ReadOperationInput,
    context: CoreOperationContext,
  ): HandlerResult<THandlers["read"]> {
    return this.handlers.read(input, context) as HandlerResult<THandlers["read"]>;
  }

  write(
    input: WriteOperationInput,
    context: CoreOperationContext,
  ): HandlerResult<THandlers["write"]> {
    return this.handlers.write(input, context) as HandlerResult<THandlers["write"]>;
  }

  edit(
    input: EditOperationInput,
    context: CoreOperationContext,
  ): HandlerResult<THandlers["edit"]> {
    return this.handlers.edit(input, context) as HandlerResult<THandlers["edit"]>;
  }

  rename(
    input: RenameOperationInput,
    context: CoreOperationContext,
  ): HandlerResult<THandlers["rename"]> {
    return this.handlers.rename(input, context) as HandlerResult<THandlers["rename"]>;
  }

  delete(
    input: DeleteOperationInput,
    context: CoreOperationContext,
  ): HandlerResult<THandlers["delete"]> {
    return this.handlers.delete(input, context) as HandlerResult<THandlers["delete"]>;
  }

  shellRun(
    input: ShellRunOperationInput,
    context: CoreOperationContext,
  ): HandlerResult<THandlers["shellRun"]> {
    return this.handlers.shellRun(input, context) as HandlerResult<THandlers["shellRun"]>;
  }

  capabilityRun(
    input: CapabilityRunOperationInput,
    context: CoreOperationContext,
  ): HandlerResult<THandlers["capabilityRun"]> {
    return this.handlers.capabilityRun(input, context) as HandlerResult<THandlers["capabilityRun"]>;
  }
}

export function createCoreOperationExecutor<THandlers extends CoreOperationHandlers>(
  handlers: THandlers,
): CoreOperationExecutor<THandlers> {
  return new CoreOperationExecutor(handlers);
}
