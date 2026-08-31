import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";

const TASK_STATE_VERSION = 1 as const;
const MAX_TASK_STATE_BYTES = 2 * 1024 * 1024;
const MAX_TASK_LISTS = 100;
const MAX_TASKS_PER_LIST = 500;
const MAX_LIST_NAME_LENGTH = 120;
const MAX_TASK_SUBJECT_LENGTH = 240;
const MAX_TASK_CONTENT_LENGTH = 64 * 1024;

export type WorkspaceTaskListState = "active" | "archived";
export type WorkspaceTaskStatus = "pending" | "in_progress" | "completed";

export interface WorkspaceTask {
  id: string;
  status: WorkspaceTaskStatus;
  subject: string;
  content: string;
}

export interface WorkspaceTaskList {
  id: string;
  name: string;
  state: WorkspaceTaskListState;
  revision: number;
  tasks: WorkspaceTask[];
}

export interface WorkspaceTaskSnapshot {
  version: typeof TASK_STATE_VERSION;
  revision: number;
  fingerprint: string;
  lists: WorkspaceTaskList[];
}

interface PersistedWorkspaceTaskState {
  version: typeof TASK_STATE_VERSION;
  revision: number;
  lists: WorkspaceTaskList[];
}

const workspaceTaskSchema = z.object({
  id: z.string().regex(/^tsk_[a-f0-9]{10}$/),
  status: z.enum(["pending", "in_progress", "completed"]),
  subject: z.string().min(1).max(MAX_TASK_SUBJECT_LENGTH),
  content: z.string().max(MAX_TASK_CONTENT_LENGTH),
}).strict();

const workspaceTaskListSchema = z.object({
  id: z.string().regex(/^tl_[a-f0-9]{10}$/),
  name: z.string().min(1).max(MAX_LIST_NAME_LENGTH),
  state: z.enum(["active", "archived"]),
  revision: z.number().int().positive(),
  tasks: z.array(workspaceTaskSchema).max(MAX_TASKS_PER_LIST),
}).strict();

const workspaceTaskStateSchema = z.object({
  version: z.literal(TASK_STATE_VERSION),
  revision: z.number().int().nonnegative(),
  lists: z.array(workspaceTaskListSchema).max(MAX_TASK_LISTS),
}).strict();

export class WorkspaceTaskStore {
  constructor(private readonly stateDir: string) {}

  ensureWorkspace(workspaceId: string): WorkspaceTaskSnapshot {
    const id = normalizeWorkspaceId(workspaceId);
    const loaded = this.tryReadState(id);
    if (loaded) return snapshot(loaded.state, loaded.fingerprint);
    return this.writeState(id, emptyState());
  }

  read(workspaceId: string): WorkspaceTaskSnapshot {
    return this.ensureWorkspace(workspaceId);
  }

  createList(
    workspaceId: string,
    input: { name: string; position?: number },
  ): WorkspaceTaskSnapshot {
    return this.mutate(workspaceId, (state) => {
      if (state.lists.length >= MAX_TASK_LISTS) {
        throw new Error(`Workspace Task List limit is ${MAX_TASK_LISTS}.`);
      }
      const list: WorkspaceTaskList = {
        id: `tl_${randomBytes(5).toString("hex")}`,
        name: normalizeListName(input.name),
        state: "active",
        revision: 1,
        tasks: [],
      };
      const position = normalizeInsertPosition(input.position, state.lists.length, "Task List");
      state.lists.splice(position, 0, list);
      return true;
    });
  }

  updateList(
    workspaceId: string,
    listId: string,
    input: { name?: string; state?: WorkspaceTaskListState; position?: number },
  ): WorkspaceTaskSnapshot {
    return this.mutate(workspaceId, (state) => {
      const index = requireListIndex(state, listId);
      const list = state.lists[index]!;
      const nextName = input.name === undefined ? list.name : normalizeListName(input.name);
      const nextState = input.state ?? list.state;
      const nextPosition = input.position === undefined
        ? index
        : normalizeMovePosition(input.position, state.lists.length, "Task List");
      const metadataChanged = nextName !== list.name || nextState !== list.state;
      const positionChanged = nextPosition !== index;
      if (!metadataChanged && !positionChanged) return false;

      list.name = nextName;
      list.state = nextState;
      list.revision += 1;
      if (positionChanged) moveArrayEntry(state.lists, index, nextPosition);
      return true;
    });
  }

  deleteList(workspaceId: string, listId: string): WorkspaceTaskSnapshot {
    return this.mutate(workspaceId, (state) => {
      state.lists.splice(requireListIndex(state, listId), 1);
      return true;
    });
  }

  createTask(
    workspaceId: string,
    listId: string,
    input: {
      subject: string;
      content?: string;
      status?: WorkspaceTaskStatus;
      position?: number;
    },
  ): WorkspaceTaskSnapshot {
    return this.mutate(workspaceId, (state) => {
      const list = requireList(state, listId);
      if (list.tasks.length >= MAX_TASKS_PER_LIST) {
        throw new Error(`Task limit per Task List is ${MAX_TASKS_PER_LIST}.`);
      }
      const task: WorkspaceTask = {
        id: `tsk_${randomBytes(5).toString("hex")}`,
        status: input.status ?? "pending",
        subject: normalizeTaskSubject(input.subject),
        content: normalizeTaskContent(input.content ?? ""),
      };
      const position = normalizeInsertPosition(input.position, list.tasks.length, "Task");
      list.tasks.splice(position, 0, task);
      list.revision += 1;
      return true;
    });
  }

  updateTask(
    workspaceId: string,
    listId: string,
    taskId: string,
    input: {
      status?: WorkspaceTaskStatus;
      subject?: string;
      content?: string;
      position?: number;
    },
  ): WorkspaceTaskSnapshot {
    return this.mutate(workspaceId, (state) => {
      const list = requireList(state, listId);
      const index = requireTaskIndex(list, taskId);
      const task = list.tasks[index]!;
      const nextStatus = input.status ?? task.status;
      const nextSubject = input.subject === undefined ? task.subject : normalizeTaskSubject(input.subject);
      const nextContent = input.content === undefined ? task.content : normalizeTaskContent(input.content);
      const nextPosition = input.position === undefined
        ? index
        : normalizeMovePosition(input.position, list.tasks.length, "Task");
      const fieldsChanged =
        nextStatus !== task.status || nextSubject !== task.subject || nextContent !== task.content;
      const positionChanged = nextPosition !== index;
      if (!fieldsChanged && !positionChanged) return false;

      task.status = nextStatus;
      task.subject = nextSubject;
      task.content = nextContent;
      if (positionChanged) moveArrayEntry(list.tasks, index, nextPosition);
      list.revision += 1;
      return true;
    });
  }

  deleteTask(workspaceId: string, listId: string, taskId: string): WorkspaceTaskSnapshot {
    return this.mutate(workspaceId, (state) => {
      const list = requireList(state, listId);
      list.tasks.splice(requireTaskIndex(list, taskId), 1);
      list.revision += 1;
      return true;
    });
  }

  deleteWorkspace(workspaceId: string): void {
    const id = normalizeWorkspaceId(workspaceId);
    rmSync(this.statePath(id), { force: true });
    try {
      rmdirSync(this.workspaceStateDir(id));
    } catch (error) {
      if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTEMPTY") && !isErrno(error, "EEXIST")) {
        throw error;
      }
    }
  }

  private mutate(
    workspaceId: string,
    mutateState: (state: PersistedWorkspaceTaskState) => boolean,
  ): WorkspaceTaskSnapshot {
    const id = normalizeWorkspaceId(workspaceId);
    const loaded = this.tryReadState(id);
    const state = loaded ? cloneState(loaded.state) : emptyState();
    if (!mutateState(state)) {
      return loaded
        ? snapshot(loaded.state, loaded.fingerprint)
        : this.writeState(id, state);
    }
    state.revision += 1;
    return this.writeState(id, state);
  }

  private tryReadState(
    workspaceId: string,
  ): { state: PersistedWorkspaceTaskState; fingerprint: string } | undefined {
    const path = this.statePath(workspaceId);
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    if (raw.byteLength > MAX_TASK_STATE_BYTES) {
      throw new Error(`Workspace Task state exceeds ${MAX_TASK_STATE_BYTES} bytes.`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      throw new Error(`Workspace Task state is not valid JSON: ${errorMessage(error)}`);
    }
    const validated = workspaceTaskStateSchema.safeParse(parsed);
    if (!validated.success) {
      const details = validated.error.issues
        .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "state"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Workspace Task state has an unsupported or invalid format: ${details}`);
    }
    return {
      state: cloneState(validated.data),
      fingerprint: fingerprint(raw),
    };
  }

  private writeState(
    workspaceId: string,
    state: PersistedWorkspaceTaskState,
  ): WorkspaceTaskSnapshot {
    const workspaceDir = this.workspaceStateDir(workspaceId);
    mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
    const validated = workspaceTaskStateSchema.parse(state);
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_TASK_STATE_BYTES) {
      throw new Error(`Workspace Task state exceeds ${MAX_TASK_STATE_BYTES} bytes.`);
    }
    const statePath = this.statePath(workspaceId);
    const tempPath = `${statePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tempPath, serialized, { mode: 0o600 });
      renameSync(tempPath, statePath);
    } finally {
      rmSync(tempPath, { force: true });
    }
    return snapshot(validated, fingerprint(Buffer.from(serialized, "utf8")));
  }

  private workspaceStateDir(workspaceId: string): string {
    return join(this.stateDir, "workspaces", workspaceId);
  }

  private statePath(workspaceId: string): string {
    return join(this.workspaceStateDir(workspaceId), "tasks.json");
  }
}

function emptyState(): PersistedWorkspaceTaskState {
  return { version: TASK_STATE_VERSION, revision: 0, lists: [] };
}

function snapshot(state: PersistedWorkspaceTaskState, stateFingerprint: string): WorkspaceTaskSnapshot {
  return {
    ...cloneState(state),
    fingerprint: stateFingerprint,
  };
}

function cloneState(state: PersistedWorkspaceTaskState): PersistedWorkspaceTaskState {
  return {
    version: state.version,
    revision: state.revision,
    lists: state.lists.map((list) => ({
      ...list,
      tasks: list.tasks.map((task) => ({ ...task })),
    })),
  };
}

function requireList(state: PersistedWorkspaceTaskState, listId: string): WorkspaceTaskList {
  return state.lists[requireListIndex(state, listId)]!;
}

function requireListIndex(state: PersistedWorkspaceTaskState, listId: string): number {
  const index = state.lists.findIndex((list) => list.id === listId);
  if (index < 0) throw new Error(`Unknown Task List ${listId}.`);
  return index;
}

function requireTaskIndex(list: WorkspaceTaskList, taskId: string): number {
  const index = list.tasks.findIndex((task) => task.id === taskId);
  if (index < 0) throw new Error(`Task List ${list.id} has no Task ${taskId}.`);
  return index;
}

function normalizeWorkspaceId(workspaceId: string): string {
  const value = workspaceId.trim();
  if (!/^[a-z][a-z0-9_-]{1,127}$/.test(value)) {
    throw new Error("Workspace ID is not valid for Workspace Task state.");
  }
  return value;
}

function normalizeListName(name: string): string {
  const value = name.trim();
  if (!value) throw new Error("Task List name must not be empty.");
  if (value.length > MAX_LIST_NAME_LENGTH) {
    throw new Error(`Task List name must be at most ${MAX_LIST_NAME_LENGTH} characters.`);
  }
  return value;
}

function normalizeTaskSubject(subject: string): string {
  const value = subject.trim();
  if (!value) throw new Error("Task subject must not be empty.");
  if (value.length > MAX_TASK_SUBJECT_LENGTH) {
    throw new Error(`Task subject must be at most ${MAX_TASK_SUBJECT_LENGTH} characters.`);
  }
  return value;
}

function normalizeTaskContent(content: string): string {
  if (content.length > MAX_TASK_CONTENT_LENGTH) {
    throw new Error(`Task content must be at most ${MAX_TASK_CONTENT_LENGTH} characters.`);
  }
  return content;
}

function normalizeInsertPosition(position: number | undefined, length: number, label: string): number {
  if (position === undefined) return length;
  if (!Number.isInteger(position) || position < 0 || position > length) {
    throw new Error(`${label} position must be an integer between 0 and ${length}.`);
  }
  return position;
}

function normalizeMovePosition(position: number, length: number, label: string): number {
  if (!Number.isInteger(position) || position < 0 || position >= length) {
    throw new Error(`${label} position must be an integer between 0 and ${Math.max(0, length - 1)}.`);
  }
  return position;
}

function moveArrayEntry<T>(values: T[], from: number, to: number): void {
  const [value] = values.splice(from, 1);
  values.splice(to, 0, value!);
}

function fingerprint(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
