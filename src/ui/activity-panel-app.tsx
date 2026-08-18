import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { HostContext } from "./card-types.js";
import { ActivityPanelController } from "./activity/panel.js";
import "./workspace-app.css";

const maybeAppRoot = document.querySelector<HTMLElement>("#app");
if (!maybeAppRoot) throw new Error("Missing #app root element.");

const appRoot = maybeAppRoot;
const activityPanel = new ActivityPanelController(appRoot);
let app: App | null = null;
let hostContext: HostContext | undefined;
let connected = false;
let connectionError: string | null = null;

void boot();

async function boot(): Promise<void> {
  render();

  app = new App(
    { name: "forgerelay-activity-panel", version: "0.1.0" },
    {},
  );

  app.ontoolresult = (result) => {
    if (activityPanel.accept(result)) {
      activityPanel.render();
      return;
    }
    renderEmpty("Waiting for Activity Panel state.");
  };

  app.onhostcontextchanged = (ctx) => {
    hostContext = { ...hostContext, ...ctx };
    applyHostContext();
    if (activityPanel.active) activityPanel.render();
  };

  app.onteardown = async () => {
    connected = false;
    activityPanel.detach();
    return {};
  };

  try {
    await app.connect();
    const initialContext = app.getHostContext();
    if (initialContext) hostContext = initialContext;
    applyHostContext();
    connected = true;
    activityPanel.attach(app);
  } catch (error) {
    connectionError = error instanceof Error ? error.message : String(error);
  }

  render();
}

function applyHostContext(): void {
  if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
  if (hostContext?.styles?.variables) applyHostStyleVariables(hostContext.styles.variables);
  if (hostContext?.styles?.css?.fonts) applyHostFonts(hostContext.styles.css.fonts);

  const insets = hostContext?.safeAreaInsets;
  if (insets) {
    document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
  }
}

function render(): void {
  if (connectionError) {
    renderEmpty(connectionError, "error");
    return;
  }
  if (!connected) {
    renderEmpty("Connecting to host...");
    return;
  }
  if (activityPanel.render()) return;
  renderEmpty("Waiting for Activity Panel state.");
}

function renderEmpty(message: string, tone: "muted" | "error" = "muted"): void {
  const main = document.createElement("main");
  main.className = "shell";
  const section = document.createElement("section");
  section.className = `empty ${tone}`;
  section.textContent = message;
  main.append(section);
  appRoot.replaceChildren(main);
}
