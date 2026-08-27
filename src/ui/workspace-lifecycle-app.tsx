// Historical compatibility entry for cards created while ForgeRelay exposed a
// dedicated Workspace Lifecycle App. New rendering is owned by activity_panel.
document.documentElement.dataset.forgerelayApp = "workspace-lifecycle-compatibility";
import "./workspace-app.js";
