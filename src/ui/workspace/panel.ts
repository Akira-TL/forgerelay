import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ACTIVITY_PANEL_WORKSPACE_META_KEY } from "../../activity/ui/contract.js";
import type { ToolResultCard } from "../card-types.js";
import { getProviderLogo, renderIcon, toolIcons, type ToolIcon } from "../icons.js";

export interface WorkspacePanelCard extends Omit<ToolResultCard, "tool"> {
  workspaceId: string;
  root: string;
}

interface WorkspaceInstruction {
  key: string;
  path?: string;
  label: string;
  content?: string;
  status: "loaded" | "available";
}

interface WorkspaceChip {
  label: string;
  logo?: string;
  profile?: boolean;
  bareLogo?: boolean;
  ariaLabel?: string;
  title?: string;
  tone?: "muted";
}

export function workspacePanelCardFromResult(
  result: CallToolResult,
): WorkspacePanelCard | undefined {
  const meta = asRecord(result._meta);
  const structured = asRecord(result.structuredContent);
  const value =
    asRecord(meta?.[ACTIVITY_PANEL_WORKSPACE_META_KEY]) ??
    asRecord(structured?.[ACTIVITY_PANEL_WORKSPACE_META_KEY]);
  if (!value) return undefined;
  if (typeof value.workspaceId !== "string" || value.workspaceId.length === 0) return undefined;
  if (typeof value.root !== "string" || value.root.length === 0) return undefined;
  if (value.mode !== undefined && value.mode !== "checkout" && value.mode !== "worktree") {
    return undefined;
  }
  return value as unknown as WorkspacePanelCard;
}

export class WorkspacePanelController {
  private card: WorkspacePanelCard | null = null;
  private openInstructionKey: string | null = null;
  private showAvailableInstructions = false;

  constructor(private readonly root: HTMLElement) {}

  get active(): boolean {
    return this.card !== null;
  }

  get workspaceId(): string | undefined {
    return this.card?.workspaceId;
  }

  accept(result: CallToolResult): boolean {
    const next = workspacePanelCardFromResult(result);
    if (!next) return false;
    if (this.card?.workspaceId !== next.workspaceId) {
      this.openInstructionKey = null;
      this.showAvailableInstructions = false;
    }
    this.card = next;
    return true;
  }

  clear(): void {
    this.card = null;
    this.openInstructionKey = null;
    this.showAvailableInstructions = false;
    this.root.replaceChildren();
  }

  render(): boolean {
    if (!this.card) return false;
    this.root.replaceChildren(this.renderPanel(this.card));
    return true;
  }

  private renderPanel(card: WorkspacePanelCard): HTMLElement {
    const section = element("section", "workspace-panel");
    const header = element("div", "workspace-panel-header");
    const icon = element("span", "workspace-panel-icon");
    icon.setAttribute("aria-hidden", "true");
    icon.append(renderIcon(toolIcons.folderOpen, "workspace-panel-icon-svg"));

    const titleGroup = element("span", "workspace-panel-title-group");
    const title = element("span", "workspace-panel-title", "Workspace");
    const subtitle = element("span", "workspace-panel-subtitle", workspaceBasename(card.root));
    subtitle.title = card.root;
    titleGroup.append(title, subtitle);

    const mode = element("span", "workspace-panel-mode", card.mode ?? "workspace");
    header.append(icon, titleGroup, mode);

    const details = element("div", "workspace-details");
    const rows = element("div", "workspace-rows");
    appendWorkspaceTextRow(rows, "Root", card.root, toolIcons.folderOpen, true);
    appendWorkspaceTextRow(rows, "Mode", card.mode ?? "workspace", toolIcons.folderTree);

    if (card.worktree) this.appendWorktreeRows(rows, card);
    if (card.sourceRoot && card.sourceRoot !== card.root) {
      appendWorkspaceTextRow(
        rows,
        "Source checkout",
        card.sourceRoot,
        toolIcons.sourceCheckout,
        true,
      );
    }

    this.appendInstructions(rows, card.agentsFiles ?? [], card.availableAgentsFiles ?? []);
    this.appendSkills(rows, card.skills ?? []);
    this.appendAgents(rows, card);

    details.append(rows);
    section.append(header, details);
    return section;
  }

  private appendWorktreeRows(container: HTMLElement, card: WorkspacePanelCard): void {
    const worktree = card.worktree;
    if (!worktree) return;
    const base = [worktree.baseRef, worktree.baseSha?.slice(0, 8)]
      .filter((value): value is string => Boolean(value));
    if (base.length > 0) {
      const content = element("span", "workspace-base-value");
      const value = element("span", "workspace-value", base.join(" · "));
      value.title = base.join(" · ");
      content.append(value);
      if (worktree.dirtySource) {
        const warning = element("span", "workspace-base-warning");
        warning.title = "The source checkout had uncommitted changes when this worktree was created.";
        warning.setAttribute("role", "img");
        warning.setAttribute("aria-label", "Source checkout changes are not included in this worktree");
        warning.append(renderIcon(toolIcons.warning, "workspace-base-warning-svg"));
        content.append(warning);
      }
      appendWorkspaceRow(container, "Base", content, toolIcons.base);
    }
    if (worktree.branch) {
      appendWorkspaceTextRow(container, "Worktree branch", worktree.branch, toolIcons.gitBranch);
    }
    if (worktree.targetBranch) {
      appendWorkspaceTextRow(container, "Merge target", worktree.targetBranch, toolIcons.gitBranch);
    }
  }

  private appendInstructions(
    container: HTMLElement,
    loadedFiles: NonNullable<ToolResultCard["agentsFiles"]>,
    availableFiles: NonNullable<ToolResultCard["availableAgentsFiles"]>,
  ): void {
    const loaded: WorkspaceInstruction[] = loadedFiles.map((file, index) => ({
      key: `loaded:${index}`,
      path: file.path,
      label: file.path ?? "Loaded instructions",
      content: file.content,
      status: "loaded",
    }));
    const loadedPaths = new Set(loaded.map((item) => item.path).filter(Boolean));
    const available: WorkspaceInstruction[] = availableFiles.flatMap((file, index) => {
      if (file.path && loadedPaths.has(file.path)) return [];
      return [{
        key: `available:${index}`,
        path: file.path,
        label: file.path ?? "Nested instructions",
        status: "available" as const,
      }];
    });
    if (loaded.length === 0 && available.length === 0) return;

    const instructions = this.showAvailableInstructions ? [...loaded, ...available] : loaded;
    const list = element("span", "workspace-instruction-list");
    for (const instruction of instructions) list.append(this.renderInstruction(instruction, list));

    if (available.length > 0) {
      const toggle = element(
        "button",
        "workspace-instructions-toggle",
        this.showAvailableInstructions ? "Show less" : "View all",
      );
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(this.showAvailableInstructions));
      toggle.addEventListener("click", () => {
        this.showAvailableInstructions = !this.showAvailableInstructions;
        if (!this.showAvailableInstructions) this.openInstructionKey = null;
        this.render();
      });
      list.append(toggle);
    }

    const content = element("div", "workspace-instructions-content");
    content.append(list);
    appendWorkspaceRow(
      container,
      "Instructions",
      content,
      toolIcons.instructions,
      "workspace-instructions-row",
    );
  }

  private renderInstruction(instruction: WorkspaceInstruction, list: HTMLElement): HTMLElement {
    const item = element("span", "workspace-instruction-item");
    item.dataset.instructionKey = instruction.key;
    const hasContent = instruction.status === "loaded" && instruction.content !== undefined;
    const header = element(hasContent ? "button" : "span", `workspace-instruction-header${hasContent ? " interactive" : ""}`);
    if (header instanceof HTMLButtonElement) {
      header.type = "button";
      header.setAttribute("aria-expanded", String(this.openInstructionKey === instruction.key));
    }

    const status = element("span", `workspace-instruction-status ${instruction.status}`);
    status.setAttribute("role", "img");
    status.setAttribute(
      "aria-label",
      instruction.status === "loaded" ? "Loaded into the current workspace context" : "Available for a nested directory",
    );
    status.append(renderIcon(
      instruction.status === "loaded" ? toolIcons.instructionLoaded : toolIcons.instructionAvailable,
      "workspace-instruction-status-svg",
    ));

    const text = element("span", "workspace-instruction-text");
    const basename = workspaceBasename(instruction.label);
    text.append(element("span", "workspace-instruction-name", basename));
    if (instruction.path && instruction.path !== basename) {
      const path = element("span", "workspace-instruction-path", instruction.path);
      path.title = instruction.path;
      text.append(path);
    }
    header.append(status, text);

    if (!hasContent) {
      item.append(header);
      return item;
    }

    const chevron = element("span", "workspace-instruction-chevron");
    chevron.setAttribute("aria-hidden", "true");
    chevron.append(renderIcon(toolIcons.chevronDown, "workspace-instruction-chevron-svg"));
    header.append(chevron);
    const preview = element("pre", "workspace-instruction-preview", instruction.content);
    const sync = () => {
      const open = this.openInstructionKey === instruction.key;
      item.classList.toggle("expanded", open);
      header.setAttribute("aria-expanded", String(open));
      preview.hidden = !open;
    };
    header.addEventListener("click", () => {
      this.openInstructionKey = this.openInstructionKey === instruction.key ? null : instruction.key;
      for (const sibling of list.querySelectorAll<HTMLElement>(".workspace-instruction-item")) {
        const siblingHeader = sibling.querySelector<HTMLElement>(".workspace-instruction-header.interactive");
        const siblingPreview = sibling.querySelector<HTMLElement>(".workspace-instruction-preview");
        const open = sibling.dataset.instructionKey === this.openInstructionKey;
        sibling.classList.toggle("expanded", open);
        siblingHeader?.setAttribute("aria-expanded", String(open));
        if (siblingPreview) siblingPreview.hidden = !open;
      }
    });
    item.append(header, preview);
    sync();
    return item;
  }

  private appendSkills(
    container: HTMLElement,
    skills: NonNullable<ToolResultCard["skills"]>,
  ): void {
    if (skills.length === 0) return;
    const chips = skills.map((skill) => ({
      label: skill.name ?? "Unnamed skill",
      title: skill.description || undefined,
    }));
    const list = renderWorkspaceChips(chips);
    list.classList.add("workspace-skills-list");
    appendWorkspaceRow(container, "Skills", list, toolIcons.skills, "workspace-skills-row");
  }

  private appendAgents(container: HTMLElement, card: WorkspacePanelCard): void {
    const providers = card.agentProviders ?? [];
    const agents = card.agents ?? [];
    const agentChips: WorkspaceChip[] = agents.map((agent) => {
      const providerName = agent.provider?.trim();
      const unavailable = agent.providerAvailable === false;
      return {
        label: agent.name ?? "Unnamed agent",
        logo: providerName ? getProviderLogo(providerName) : undefined,
        profile: true,
        tone: unavailable ? "muted" : undefined,
        title: [
          agent.description,
          providerName ? `Provider: ${providerName}` : undefined,
          agent.model ? `Model: ${agent.model}` : undefined,
          agent.thinking ? `Thinking: ${agent.thinking}` : undefined,
          unavailable ? agent.providerUnavailableReason ?? "Provider unavailable" : undefined,
        ].filter(Boolean).join("\n") || undefined,
      };
    });
    const providerChips: WorkspaceChip[] = providers.map((provider) => {
      const name = provider.name?.trim() || "Unknown provider";
      const logo = getProviderLogo(name);
      return {
        label: name,
        logo,
        bareLogo: Boolean(logo),
        ariaLabel: name,
        tone: provider.available === false ? "muted" : undefined,
        title: provider.available === false ? provider.reason ?? "Provider unavailable" : name,
      };
    });

    if (agentChips.length > 0) {
      const list = renderWorkspaceChips([...agentChips, ...providerChips]);
      list.classList.add("workspace-agents-list");
      appendWorkspaceRow(container, "Agents", list, toolIcons.agents, "workspace-agents-row");
    } else if (providerChips.length > 0) {
      appendWorkspaceRow(container, "Providers", renderWorkspaceChips(providerChips), toolIcons.providers);
    }
  }
}

function appendWorkspaceTextRow(
  container: HTMLElement,
  label: string,
  value: string,
  icon: ToolIcon,
  mono = false,
): void {
  const content = element("span", `workspace-value${mono ? " mono" : ""}`, value);
  content.title = value;
  appendWorkspaceRow(container, label, content, icon);
}

function appendWorkspaceRow(
  container: HTMLElement,
  label: string,
  content: HTMLElement,
  icon: ToolIcon,
  rowClassName?: string,
): void {
  const row = element("div", ["workspace-row", rowClassName].filter(Boolean).join(" "));
  const iconWrap = element("span", "workspace-row-icon");
  iconWrap.setAttribute("aria-hidden", "true");
  iconWrap.append(renderIcon(icon, "workspace-row-icon-svg"));
  row.append(iconWrap, element("span", "workspace-key", label), content);
  container.append(row);
}

function renderWorkspaceChips(chips: WorkspaceChip[]): HTMLElement {
  const list = element("span", "workspace-chip-list");
  for (const chip of chips) {
    const bareLogo = Boolean(chip.bareLogo && chip.logo);
    const item = element(
      "span",
      [
        bareLogo ? "workspace-provider-logo" : chip.profile ? "workspace-agent-profile" : "workspace-chip",
        chip.tone,
      ].filter(Boolean).join(" "),
    );
    if (chip.title) item.title = chip.title;
    if (bareLogo) {
      item.setAttribute("role", "img");
      item.setAttribute("aria-label", chip.ariaLabel ?? chip.label);
    }
    if (chip.logo) {
      const logo = document.createElement("img");
      logo.className = bareLogo
        ? "workspace-provider-logo-image"
        : chip.profile
          ? "workspace-agent-profile-logo"
          : "workspace-chip-logo";
      logo.src = chip.logo;
      logo.alt = "";
      logo.setAttribute("aria-hidden", "true");
      item.append(logo);
    }
    if (!bareLogo) item.append(element("span", "workspace-chip-label", chip.label));
    list.append(item);
  }
  return list;
}

function workspaceBasename(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
