// Workspace Lifecycle has its own MCP App/resource identity while sharing the
// established workspace-card renderer with historical cards. Tool metadata
// ensures only open_workspace and close_workspace instantiate this entry.
document.documentElement.dataset.forgerelayApp = "workspace-lifecycle";
import "./workspace-app.js";
