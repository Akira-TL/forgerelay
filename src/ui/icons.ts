import {
  Blocks,
  Bot,
  ChevronDown,
  CircleAlert,
  Cpu,
  FileDiff,
  FileCheck2,
  FileMinus,
  FilePenLine,
  FilePlus,
  FileText,
  Files,
  FolderGit2,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  Search,
  SquareTerminal,
  Terminal,
  createElement,
  type IconNode,
} from "lucide";

export const toolIcons = {
  agents: Bot,
  base: GitCommitHorizontal,
  chevronDown: ChevronDown,
  deleteFile: FileMinus,
  diff: FileDiff,
  editFile: FilePenLine,
  files: Files,
  folderOpen: FolderOpen,
  folderTree: FolderTree,
  gitBranch: GitBranch,
  instructions: FileText,
  instructionAvailable: FileText,
  instructionLoaded: FileCheck2,
  loading: LoaderCircle,
  providers: Cpu,
  readFile: FileText,
  search: Search,
  skills: Blocks,
  sourceCheckout: FolderGit2,
  terminal: Terminal,
  terminalSquare: SquareTerminal,
  warning: CircleAlert,
  writeFile: FilePlus,
} as const satisfies Record<string, IconNode>;

export type ToolIcon = IconNode;

export function renderIcon(icon: ToolIcon, className = "icon-svg"): SVGElement {
  return createElement(icon, {
    class: className,
    "aria-hidden": "true",
  });
}
