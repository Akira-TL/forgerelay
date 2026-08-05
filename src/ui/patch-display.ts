import type { ToolResultCard } from "./card-types.js";

export type FileChangeKind =
  | "added"
  | "edited"
  | "deleted"
  | "renamed"
  | "renamed-edited"
  | "unknown";

type ToolResultFile = NonNullable<ToolResultCard["files"]>[number];

export interface PatchDisplayParts {
  title: string;
  iconKind?: FileChangeKind;
  tone: "edit" | "write" | "delete";
}

const fileChangeLabels: Record<Exclude<FileChangeKind, "unknown">, string> = {
  added: "Added",
  edited: "Edited",
  deleted: "Deleted",
  renamed: "Renamed",
  "renamed-edited": "Renamed and edited",
};

export function getPatchDisplayParts(
  card: Pick<ToolResultCard, "files">,
  options: { emptyTitle?: string } = {},
): PatchDisplayParts {
  const files = card.files ?? [];
  const fileCount = countChangedFiles(files);

  if (fileCount === 0) {
    return { title: options.emptyTitle ?? "Applied patch", tone: "edit" };
  }

  const kinds = new Set(files.map(getFileChangeKind));
  const singleKind = kinds.size === 1 ? [...kinds][0] : undefined;
  const display: PatchDisplayParts = {
    title: changeTitle(singleKind, fileCount),
    tone: changeTone(singleKind),
  };

  if (singleKind && singleKind !== "unknown") display.iconKind = singleKind;
  return display;
}

export function getFileChangeKind(file: ToolResultFile): FileChangeKind {
  switch (file.operation) {
    case "add":
      return "added";
    case "update":
      return "edited";
    case "delete":
      return "deleted";
    case "move":
      return "renamed";
  }

  switch (file.type) {
    case "new":
      return "added";
    case "change":
      return "edited";
    case "deleted":
      return "deleted";
    case "rename-pure":
      return "renamed";
    case "rename-changed":
      return "renamed-edited";
    default:
      return "unknown";
  }
}

export function fileChangeKindLabel(kind: FileChangeKind): string {
  return kind === "unknown" ? "Changed" : fileChangeLabels[kind];
}

function countChangedFiles(files: NonNullable<ToolResultCard["files"]>): number {
  const paths = new Set<string>();
  let unnamedFiles = 0;

  for (const file of files) {
    const path = file.path ?? file.previousPath;
    if (path) {
      paths.add(path);
    } else {
      unnamedFiles += 1;
    }
  }

  return paths.size + unnamedFiles;
}

function changeTitle(kind: FileChangeKind | undefined, fileCount: number): string {
  if (kind && kind !== "unknown") {
    return `${fileChangeLabels[kind]} ${fileCount} ${fileNoun(fileCount)}`;
  }

  return `Changed ${fileCount} ${fileNoun(fileCount)}`;
}

function changeTone(kind: FileChangeKind | undefined): PatchDisplayParts["tone"] {
  if (kind === "added") return "write";
  if (kind === "deleted") return "delete";
  return "edit";
}

function fileNoun(fileCount: number): "file" | "files" {
  return fileCount === 1 ? "file" : "files";
}
