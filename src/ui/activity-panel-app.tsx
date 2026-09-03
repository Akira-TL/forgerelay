import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { HostContext } from "./core/card-types.js";
import { ActivityPanelController } from "./activity/panel.js";
import { WorkspacePanelController } from "./workspace/panel.js";
import "./workspace/panel.css";
import "./review/panel.css";

document.documentElement.dataset.forgerelayApp = "panel";

const maybeAppRoot = document.querySelector<HTMLElement>("#app");
if (!maybeAppRoot) throw new Error("Missing #app root element.");

const appRoot = maybeAppRoot;
const panel = element("section", "forgerelay-panel");
const workspaceRoot = element("div", "workspace-panel-slot");
const activityRoot = element("div", "activity-panel-slot");
panel.append(workspaceRoot, activityRoot);
appRoot.replaceChildren(panel);

const workspacePanel = new WorkspacePanelController(workspaceRoot);
const activityPanel = new ActivityPanelController(activityRoot, { embedded: true });
let app: App | null = null;
let hostContext: HostContext | undefined;
let connected = false;
let connectionError: string | null = null;
let currentWorkspaceId: string | undefined;
let bootstrapInFlight = false;
let bootstrapAttemptedFor: string | undefined;

void boot();

async function boot(): Promise<void> {
  render();

  app = new App(
    { name: "forgerelay-panel", version: "0.1.0" },
    {},
  );

  app.ontoolinput = (input) => {
    const workspaceId = input.arguments?.workspaceId;
    if (typeof workspaceId === "string" && workspaceId.length > 0) {
      currentWorkspaceId = workspaceId;
      if (connected && !activityPanel.active) void bootstrapCurrentTurn();
    }
    render();
  };

  app.ontoolresult = (result) => {
    acceptToolResult(result);
  };

  app.onhostcontextchanged = (ctx) => {
    hostContext = { ...hostContext, ...ctx };
    applyHostContext();
  };

  app.onteardown = async () => {
    connected = false;
    activityPanel.detach();
    workspacePanel.detach();
    workspacePanel.clear();
    return {};
  };

  try {
    await app.connect();
    const initialContext = app.getHostContext();
    if (initialContext) hostContext = initialContext;
    applyHostContext();
    connected = true;
    activityPanel.attach(app);
    workspacePanel.attach(app);
    if (currentWorkspaceId && !activityPanel.active) void bootstrapCurrentTurn();
  } catch (error) {
    connectionError = error instanceof Error ? error.message : String(error);
  }

  render();
}

function acceptToolResult(result: CallToolResult): void {
  const workspaceAccepted = workspacePanel.accept(result);
  if (workspaceAccepted) currentWorkspaceId = workspacePanel.workspaceId;
  activityPanel.accept(result);
  render();
}

async function bootstrapCurrentTurn(): Promise<void> {
  const workspaceId = currentWorkspaceId;
  if (
    !app || !connected || !workspaceId || activityPanel.active || bootstrapInFlight ||
    bootstrapAttemptedFor === workspaceId
  ) {
    return;
  }
  if (!app.getHostCapabilities()?.serverTools) return;

  bootstrapAttemptedFor = workspaceId;
  bootstrapInFlight = true;
  render();
  try {
    const result = await app.callServerTool({
      name: "activity_snapshot",
      arguments: { workspaceId },
    });
    if (!result.isError) acceptToolResult(result);
  } finally {
    bootstrapInFlight = false;
    render();
  }
}

function applyHostContext(): void {
  if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
  if (hostContext?.styles?.variables) applyHostStyleVariables(hostContext.styles.variables);
  if (hostContext?.styles?.css?.fonts) applyHostFonts(hostContext.styles.css.fonts);

  const insets = hostContext?.safeAreaInsets;
  if (!insets) return;
  document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
}

function render(): void {
  if (!workspacePanel.render()) renderWorkspacePending();
  if (!activityPanel.render()) activityRoot.replaceChildren();
}

function renderWorkspacePending(): void {
  const section = element("section", "workspace-panel pending");
  const header = element("div", "workspace-panel-header");
  const titleGroup = element("span", "workspace-panel-title-group");
  titleGroup.append(
    element("span", "workspace-panel-title", "Workspace"),
    element(
      "span",
      "workspace-panel-subtitle",
      connectionError
        ? connectionError
        : currentWorkspaceId
          ? bootstrapInFlight
            ? "Loading workspace…"
            : currentWorkspaceId
          : connected
            ? "Waiting for workspace…"
            : "Connecting to host…",
    ),
  );
  header.append(titleGroup);
  section.append(header);
  workspaceRoot.replaceChildren(section);
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
