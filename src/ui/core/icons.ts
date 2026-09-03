import {
  Bot,
  Blocks,
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

const providerLogos = {
  claude: new URL("../assets/provider-logos/claude.svg", import.meta.url).href,
  codex: new URL("../assets/provider-logos/openai-dark.svg", import.meta.url).href,
  copilot: new URL("../assets/provider-logos/copilot-dark.svg", import.meta.url).href,
  cursor: new URL("../assets/provider-logos/cursor-dark.svg", import.meta.url).href,
  opencode: new URL("../assets/provider-logos/opencode-dark.svg", import.meta.url).href,
  pi: new URL("../assets/provider-logos/pi-on-dark.svg", import.meta.url).href,
} as const;

export function getProviderLogo(name: string): string | undefined {
  const normalizedName = name.trim().toLowerCase() as keyof typeof providerLogos;
  return providerLogos[normalizedName];
}

export function renderIcon(icon: ToolIcon, className = "icon-svg"): SVGElement {
  return createElement(icon, {
    class: className,
    "aria-hidden": "true",
  });
}
