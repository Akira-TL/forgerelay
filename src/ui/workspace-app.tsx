import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  isEditTool,
  isExpandableCard,
  isPatchTool,
  isReadTool,
  isReviewTool,
  isToolName,
  isToolResultCard,
  isWriteTool,
  payloadText,
  type HostContext,
  type ToolName,
  type ToolResultCard,
} from "./card-types.js";
import { renderIcon, toolIcons, type ToolIcon } from "./icons.js";
import {
  getToolDisplay,
  getToolHeaderSummary,
  type ToolDisplay,
} from "./tool-display.js";
import "./workspace-app.css";

interface MountedPayload {
  update(options: {
    card: ToolResultCard;
    hostContext?: HostContext;
    errorMessage?: string | null;
    visibleFileCount?: number;
  }): void;
  unmount(): void;
}

let app: App | null = null;
let connected = false;
let connectionError: string | null = null;
let hostContext: HostContext | undefined;
let card: ToolResultCard | null = null;
let expanded = false;
let reviewFilesExpanded = false;
let errorMessage: string | null = null;
let currentPayload: MountedPayload | null = null;
let currentPayloadContainer: HTMLElement | null = null;

type WorkspaceDisclosureKey = "instructions" | "skills" | "agents";
const expandedWorkspaceDisclosures = new Set<WorkspaceDisclosureKey>();

const maybeAppRoot = document.querySelector<HTMLElement>("#app");

if (!maybeAppRoot) {
  throw new Error("Missing #app root element.");
}

const appRoot = maybeAppRoot;

void boot();

async function boot(): Promise<void> {
  render();

  app = new App(
    { name: "devspace-tool-cards", version: "0.4.0" },
    {},
  );

  app.ontoolresult = (result) => {
    const structuredContent = getStructuredContent<Partial<ToolResultCard>>(result);
    const metaCard = cardFromMeta(result);
    const structured = metaCard
      ? { ...structuredContent, ...metaCard }
      : structuredContent;
    const tool = toolNameFromMeta(result);

    if (!tool || !isToolResultCard(structured)) {
      card = null;
      expanded = false;
      reviewFilesExpanded = false;
      expandedWorkspaceDisclosures.clear();
      errorMessage = "No result card is available for this tool result.";
      render();
      return;
    }

    const nextCard = { ...structured, tool };
    card = nextCard;
    expanded = isReviewTool(tool) && isExpandableCard(nextCard);
    reviewFilesExpanded = false;
    expandedWorkspaceDisclosures.clear();
    errorMessage = null;
    render();
  };

  app.onhostcontextchanged = (ctx) => {
    hostContext = {
      ...hostContext,
      ...ctx,
    };
    applyHostContext();
    // Workspace details inherit host variables directly. Rebuilding their DOM on
    // iframe resize would reset an in-progress disclosure interaction.
    if (card?.tool !== "open_workspace") renderPayloadIfNeeded();
  };

  app.onteardown = async () => {
    unmountPayload();
    return {};
  };

  try {
    await app.connect();
    const initialContext = app.getHostContext();
    if (initialContext) hostContext = initialContext;
    applyHostContext();
    connected = true;
  } catch (connectError) {
    connectionError = connectError instanceof Error
      ? connectError.message
      : String(connectError);
  }

  render();
}

function applyHostContext(): void {
  if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
  if (hostContext?.styles?.variables) {
    applyHostStyleVariables(hostContext.styles.variables);
  }
  if (hostContext?.styles?.css?.fonts) {
    applyHostFonts(hostContext.styles.css.fonts);
  }

  const insets = hostContext?.safeAreaInsets;
  if (!insets) return;

  document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
}

function render(): void {
  unmountPayload();

  if (connectionError) {
    renderEmpty(connectionError, "error");
    return;
  }

  if (!connected) {
    renderEmpty("Connecting to host...");
    return;
  }

  if (!card) {
    renderEmpty(errorMessage ?? "Waiting for a tool result.", errorMessage ? "error" : "muted");
    return;
  }

  const display = getToolDisplay(card);
  if (isReviewTool(card.tool)) {
    renderReviewCard(card, display);
    return;
  }

  const expandable = isExpandableCard(card);
  const main = element("main", { className: "shell" });
  const section = element("section", {
    className: toolCardClassName(display),
  });
  const button = element("button", {
    className: "tool-header",
    type: "button",
    ariaExpanded: String(expanded),
    disabled: !expandable,
  });

  if (expandable) {
    button.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });
  }

  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.append(renderIcon(display.icon));

  const toolMain = element("span", { className: "tool-main" });
  const title = element("span", { className: "tool-title", text: display.title });
  toolMain.append(title);
  if (display.label) {
    toolMain.append(element("span", {
      className: "tool-label",
      text: display.label,
      title: display.label,
    }));
  }

  button.append(
    icon,
    toolMain,
    renderHeaderSummary(card),
    renderChevron(expanded, expandable),
  );
  section.append(button);

  if (expanded) {
    const body = element("div", { className: "tool-body" });
    currentPayloadContainer = body;
    section.append(body);
  }

  main.append(section);
  appRoot.replaceChildren(main);
  renderPayloadIfNeeded();
}

function renderEmpty(message: string, tone: "muted" | "error" = "muted"): void {
  const main = element("main", { className: "shell" });
  main.append(element("section", { className: `empty ${tone}`, text: message }));
  appRoot.replaceChildren(main);
}

async function renderPayloadIfNeeded(): Promise<void> {
  if (!card || !currentPayloadContainer || !expanded) return;

  const target = currentPayloadContainer;

  if (errorMessage) {
    renderStatus(target, errorMessage, "error");
    return;
  }

  if (card.tool === "open_workspace") {
    renderWorkspacePayload(target, card);
    return;
  }

  if (shouldUseHeavyPayload(card)) {
    if (currentPayload) {
      currentPayload.update({ card, hostContext, errorMessage });
      return;
    }

    setPayloadLoading(target, true);

    try {
      const { mountHeavyPayload } = await import("./heavy-payload.js");
      if (target !== currentPayloadContainer || !expanded || !card) return;

      setPayloadLoading(target, false);
      currentPayload = mountHeavyPayload(target, {
        card,
        hostContext,
        errorMessage,
      });
    } catch (loadError) {
      if (target !== currentPayloadContainer || !expanded) return;

      setPayloadLoading(target, false);
      renderStatus(
        target,
        loadError instanceof Error ? loadError.message : "Unable to load details.",
        "error",
      );
    }
    return;
  }

  if (isReviewTool(card.tool) || isPatchTool(card.tool)) {
    const visibleFileCount = isReviewTool(card.tool) && !reviewFilesExpanded
      ? Math.max(3, (card.files ?? []).slice(0, 3).length)
      : undefined;

    if (currentPayload) {
      currentPayload.update({ card, hostContext, errorMessage, visibleFileCount });
      return;
    }

    renderStatus(target, isReviewTool(card.tool) ? "Loading review..." : "Loading diff...");

    const { mountReviewPayload } = await import("./review-payload.js");
    if (target !== currentPayloadContainer || !card) return;

    currentPayload = mountReviewPayload(target, {
      card,
      hostContext,
      errorMessage,
      visibleFileCount,
    });
    return;
  }

  const text = payloadText(card.payload);
  if (!text) {
    renderStatus(target, "No details available.");
    return;
  }

  renderPrePayload(target, text, card.tool);
}

function shouldUseHeavyPayload(card: ToolResultCard): boolean {
  return isReadTool(card.tool) || isEditTool(card.tool) || isWriteTool(card.tool);
}

function unmountPayload(): void {
  unmountCurrentPayload();
  currentPayload = null;
  currentPayloadContainer = null;
}

function unmountCurrentPayload(): void {
  currentPayload?.unmount();
  currentPayload = null;
}

function renderStatus(
  container: HTMLElement,
  message: string,
  tone: "muted" | "error" = "muted",
): void {
  unmountCurrentPayload();
  container.replaceChildren(element("div", { className: `status ${tone}`, text: message }));
}

function renderPrePayload(
  container: HTMLElement,
  text: string,
  tool: string,
): void {
  unmountCurrentPayload();
  container.replaceChildren(element("pre", {
    className: `text-payload pretty-scrollbar ${tool}`,
    text,
  }));
}

function renderHeaderSummary(card: ToolResultCard): HTMLElement {
  const summary = getToolHeaderSummary(card);

  if (summary.kind === "diff") {
    const stats = element("span", { className: "stats" });
    stats.setAttribute("aria-label", "Diff statistics");
    stats.append(
      element("span", { className: "add", text: `+${String(summary.additions)}` }),
      element("span", { className: "remove", text: `-${String(summary.removals)}` }),
    );
    return stats;
  }

  const meta = element("span", {
    className: `header-meta ${summary.kind === "empty" ? "empty" : ""}`,
    text: summary.kind === "text" ? summary.text : "",
  });
  if (summary.kind === "empty") meta.setAttribute("aria-hidden", "true");
  return meta;
}

function renderReviewCard(card: ToolResultCard, display: ToolDisplay): void {
  unmountPayload();

  const files = card.files ?? [];
  const visibleFiles = reviewFilesExpanded ? files : files.slice(0, 3);
  const hiddenCount = Math.max(0, files.length - visibleFiles.length);
  const expandable = isExpandableCard(card);
  const main = element("main", { className: "shell" });
  const section = element("section", { className: toolCardClassName(display) });
  const header = element("button", {
    className: "tool-header review-header",
    type: "button",
    ariaExpanded: String(expanded),
    disabled: !expandable,
  });

  if (expandable) {
    header.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });
  }

  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.append(renderIcon(display.icon));
  const titleGroup = element("span", { className: "tool-main review-title-group" });

  titleGroup.append(element("span", { className: "tool-title", text: display.title }));
  if (display.label) {
    titleGroup.append(element("span", {
      className: "tool-label",
      text: display.label,
      title: display.label,
    }));
  }
  header.append(
    icon,
    titleGroup,
    renderHeaderSummary(card),
    renderChevron(expanded, expandable),
  );

  section.append(header);
  if (expanded) {
    const body = element("div", { className: "review-summary" });
    const payload = element("div", { className: "review-payload" });
    currentPayloadContainer = payload;
    body.append(payload);

    if (hiddenCount > 0) {
      const showMore = element("button", {
        className: "review-more",
        type: "button",
        text: `Show ${hiddenCount} more ${hiddenCount === 1 ? "file" : "files"}`,
      });
      showMore.addEventListener("click", () => {
        reviewFilesExpanded = true;
        render();
      });
      body.append(showMore);
    }

    section.append(body);
  }

  main.append(section);
  appRoot.replaceChildren(main);
  renderPayloadIfNeeded();
}

function renderChevron(isExpanded: boolean, visible: boolean): HTMLElement {
  const chevron = element("span", {
    className: visible ? `chevron ${isExpanded ? "expanded" : ""}` : "chevron",
    ariaHidden: "true",
  });

  if (visible) {
    chevron.append(renderIcon(toolIcons.chevronDown));
  }

  return chevron;
}

function toolCardClassName(display: ToolDisplay): string {
  return ["tool-card", display.tone, display.state ? `state-${display.state}` : undefined]
    .filter(Boolean)
    .join(" ");
}

function setPayloadLoading(container: HTMLElement, loading: boolean): void {
  const header = container.previousElementSibling;
  const chevron = header?.querySelector<HTMLElement>(".chevron");
  if (!chevron) return;

  chevron.classList.toggle("loading", loading);
  chevron.replaceChildren(
    renderIcon(loading ? toolIcons.loading : toolIcons.chevronDown),
  );

  const button = header instanceof HTMLButtonElement ? header : null;
  if (button) button.setAttribute("aria-busy", String(loading));
}

function renderWorkspacePayload(container: HTMLElement, card: ToolResultCard): void {
  unmountCurrentPayload();

  const details = element("div", {
    className: "workspace-details pretty-scrollbar",
  });
  const rows = element("div", { className: "workspace-rows" });
  const worktree = card.worktree;

  if (worktree) {
    const base = [
      worktree.baseRef,
      worktree.baseSha?.slice(0, 8),
    ].filter((value): value is string => Boolean(value));
    const flags = [
      worktree.detached ? "detached" : undefined,
      worktree.managed ? "managed" : undefined,
      worktree.dirtySource ? "dirty source" : undefined,
    ].filter((value): value is string => Boolean(value));
    appendWorkspaceTextRow(
      rows,
      "Base",
      [...base, ...flags].join(" · ") || "Worktree",
      toolIcons.base,
    );
  }

  if (card.sourceRoot && card.sourceRoot !== card.root) {
    appendWorkspaceTextRow(
      rows,
      "Source checkout",
      card.sourceRoot,
      toolIcons.sourceCheckout,
      true,
    );
  }

  const instructionPaths = [
    ...(card.agentsFiles ?? []).map((file) => file.path ?? "AGENTS.md"),
    ...(card.availableAgentsFiles ?? []).map((file) => file.path ?? "Nested instructions"),
  ];
  if (instructionPaths.length > 0) {
    appendWorkspaceTextListRow(
      rows,
      "Instructions",
      instructionPaths,
      toolIcons.instructions,
      "instructions",
      true,
    );
  }

  const skills = card.skills ?? [];
  if (skills.length > 0) {
    appendWorkspaceSkills(rows, skills);
  }

  const providers = card.agentProviders ?? [];
  if (providers.length > 0) {
    const providerChips: WorkspaceChip[] = [];
    for (const provider of providers) {
      const unavailable = provider.available === false;
      providerChips.push({
        label: provider.name ?? "Unknown provider",
        tone: unavailable ? "muted" : undefined,
        title: unavailable ? provider.reason ?? "Provider unavailable" : undefined,
      });
    }
    appendWorkspaceChipRow(rows, "Providers", providerChips, toolIcons.providers);
  }

  const agentNames = (card.agents ?? []).map((agent) => {
    const name = agent.name ?? "Unnamed agent";
    return agent.provider ? `${name} · ${agent.provider}` : name;
  });
  if (agentNames.length > 0) {
    appendWorkspaceTextListRow(
      rows,
      "Agents",
      agentNames,
      toolIcons.agents,
      "agents",
    );
  }

  if (rows.childElementCount > 0) details.append(rows);

  if (details.childElementCount === 0) {
    details.append(element("div", { className: "status muted", text: "No workspace details available." }));
  }

  container.replaceChildren(details);
}

interface WorkspaceChip {
  label: string;
  title?: string;
  tone?: "muted";
}

function appendWorkspaceTextRow(
  container: HTMLElement,
  label: string,
  value: string,
  icon: ToolIcon,
  mono = false,
): void {
  const content = element("span", {
    className: `workspace-value${mono ? " mono" : ""}`,
    text: value,
    title: value,
  });
  appendWorkspaceRow(container, label, content, icon);
}

function appendWorkspaceTextListRow(
  container: HTMLElement,
  label: string,
  values: string[],
  icon: ToolIcon,
  disclosureKey: WorkspaceDisclosureKey,
  mono = false,
): void {
  if (values.length === 1) {
    appendWorkspaceTextRow(container, label, values[0], icon, mono);
    return;
  }

  const initiallyExpanded = expandedWorkspaceDisclosures.has(disclosureKey);
  const row = element("div", {
    className: `workspace-row workspace-row-disclosure${initiallyExpanded ? " expanded" : ""}`,
  });
  const disclosure = element("span", {
    className: `workspace-disclosure${initiallyExpanded ? " expanded" : ""}`,
  });
  const list = element("span", {
    className: `workspace-value-list${mono ? " mono" : ""}`,
  });
  for (const value of values) {
    list.append(element("span", {
      className: "workspace-value-item",
      text: value,
      title: value,
    }));
  }

  const toggle = renderWorkspaceDisclosureToggle(values.length, initiallyExpanded, (nextExpanded) => {
    disclosure.classList.toggle("expanded", nextExpanded);
    row.classList.toggle("expanded", nextExpanded);
    if (nextExpanded) {
      expandedWorkspaceDisclosures.add(disclosureKey);
    } else {
      expandedWorkspaceDisclosures.delete(disclosureKey);
    }
  });
  disclosure.append(list, toggle);
  row.append(
    renderWorkspaceRowIcon(icon),
    element("span", { className: "workspace-key", text: label }),
    disclosure,
  );
  container.append(row);
}

function appendWorkspaceChipRow(
  container: HTMLElement,
  label: string,
  chips: WorkspaceChip[],
  icon: ToolIcon,
): void {
  appendWorkspaceRow(container, label, renderWorkspaceChips(chips), icon);
}

function appendWorkspaceRow(
  container: HTMLElement,
  label: string,
  content: HTMLElement,
  icon: ToolIcon,
): void {
  const row = element("div", { className: "workspace-row" });
  row.append(
    renderWorkspaceRowIcon(icon),
    element("span", { className: "workspace-key", text: label }),
    content,
  );
  container.append(row);
}

function appendWorkspaceSkills(
  container: HTMLElement,
  skills: NonNullable<ToolResultCard["skills"]>,
): void {
  const skillChips = skills.map((skill) => ({
    label: skill.name ?? skill.path ?? "Unnamed skill",
    title: skill.path,
  }));
  if (skillChips.length === 1) {
    appendWorkspaceChipRow(container, "Skills", skillChips, toolIcons.skills);
    return;
  }

  const initiallyExpanded = expandedWorkspaceDisclosures.has("skills");
  const row = element("div", {
    className: `workspace-row workspace-row-disclosure${initiallyExpanded ? " expanded" : ""}`,
  });
  const disclosure = element("span", {
    className: `workspace-disclosure workspace-skills-disclosure${initiallyExpanded ? " expanded" : ""}`,
  });
  const chipList = renderWorkspaceChips(skillChips);
  chipList.classList.add("workspace-skills-list");

  const toggle = renderWorkspaceDisclosureToggle(skills.length, initiallyExpanded, (nextExpanded) => {
    disclosure.classList.toggle("expanded", nextExpanded);
    row.classList.toggle("expanded", nextExpanded);
    if (nextExpanded) {
      expandedWorkspaceDisclosures.add("skills");
    } else {
      expandedWorkspaceDisclosures.delete("skills");
    }
  });
  disclosure.append(chipList, toggle);

  row.append(
    renderWorkspaceRowIcon(toolIcons.skills),
    element("span", { className: "workspace-key", text: "Skills" }),
    disclosure,
  );
  container.append(row);
}

function renderWorkspaceDisclosureToggle(
  total: number,
  expanded: boolean,
  onToggle: (expanded: boolean) => void,
): HTMLButtonElement {
  const toggle = element("button", {
    className: "workspace-disclosure-toggle",
    type: "button",
    text: expanded ? "Show less" : `View all ${total}`,
    ariaExpanded: String(expanded),
  });
  toggle.addEventListener("click", () => {
    const nextExpanded = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(nextExpanded));
    toggle.textContent = nextExpanded ? "Show less" : `View all ${total}`;
    onToggle(nextExpanded);
  });
  return toggle;
}

function renderWorkspaceRowIcon(icon: ToolIcon): HTMLElement {
  const wrapper = element("span", {
    className: "workspace-row-icon",
    ariaHidden: "true",
  });
  wrapper.append(renderIcon(icon, "workspace-row-icon-svg"));
  return wrapper;
}

function renderWorkspaceChips(chips: WorkspaceChip[]): HTMLElement {
  const list = element("span", { className: "workspace-chip-list" });
  for (const chip of chips) {
    list.append(element("span", {
      className: `workspace-chip${chip.tone ? ` ${chip.tone}` : ""}`,
      text: chip.label,
      title: chip.title,
    }));
  }
  return list;
}

function toolNameFromMeta(result: CallToolResult): ToolName | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  const tool = meta?.tool;
  return isToolName(tool) ? tool : undefined;
}

function cardFromMeta(result: CallToolResult): Partial<ToolResultCard> | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  const metaCard = meta?.card;
  return metaCard && typeof metaCard === "object" ? metaCard : undefined;
}

function getStructuredContent<T>(result: CallToolResult): T | undefined {
  return result.structuredContent as T | undefined;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    type?: string;
    title?: string;
    ariaHidden?: string;
    ariaExpanded?: string;
    disabled?: boolean;
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type !== undefined && "type" in node) node.setAttribute("type", options.type);
  if (options.title !== undefined) node.title = options.title;
  if (options.ariaHidden !== undefined) node.setAttribute("aria-hidden", options.ariaHidden);
  if (options.ariaExpanded !== undefined) node.setAttribute("aria-expanded", options.ariaExpanded);
  if (options.disabled !== undefined && "disabled" in node) {
    (node as HTMLButtonElement).disabled = options.disabled;
  }
  return node;
}

