import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  activityRefreshDelayMs,
  applyActivityIndex,
  groupActivitySummaries,
  isActivityBashOutput,
  isActivityDetail,
  isActivityIndex,
  isHostTurnState,
  readActivityPanelDefaultExpanded,
  shouldFollowActivityTail,
  type ActivityBashOutput,
  type ActivityDetail,
  type ActivitySummary,
  type HostTurnState,
} from "./model.js";
import { renderIcon, toolIcons, type ToolIcon } from "../icons.js";
import "./panel.css";

const ACTIVITY_OUTPUT_REFRESH_INTERVAL_MS = 1_000;

export class ActivityPanelController {
  private app: App | null = null;
  private snapshot: HostTurnState | null = null;
  private activities: ActivitySummary[] = [];
  private indexRevision: number | undefined;
  private indexLoading = false;
  private indexInFlight = false;
  private indexError: string | null = null;
  private expanded = false;
  private refreshTimer: number | null = null;
  private refreshInFlight = false;
  private refreshError: string | null = null;
  private unchangedRefreshes = 0;
  private visibilityListenerAttached = false;
  private followTail = true;
  private scrollTop = 0;
  private selectedActivityId: string | null = null;
  private readonly details = new Map<string, ActivityDetail>();
  private readonly detailLoading = new Set<string>();
  private readonly detailErrors = new Map<string, string>();
  private readonly outputs = new Map<string, ActivityBashOutput>();
  private readonly outputLoading = new Set<string>();
  private readonly outputErrors = new Map<string, string>();
  private outputRefreshTimer: number | null = null;
  private readonly handleVisibilityChange = (): void => {
    if (document.hidden) {
      this.stopRefresh();
      this.stopOutputRefresh();
      return;
    }

    if (this.snapshot) {
      this.stopRefresh();
      this.scheduleRefresh(0, true);
    }
    const selected = this.activities.find(
      (activity) => activity.activityId === this.selectedActivityId,
    );
    if (selected && isBashOutputActivity(selected)) {
      const output = this.outputs.get(selected.outputId);
      if (output?.status === "running") this.scheduleOutputRefresh(selected, 0);
    }
  };

  constructor(
    private readonly root: HTMLElement,
    private readonly options: { embedded?: boolean } = {},
  ) {}

  get active(): boolean {
    return this.snapshot !== null;
  }

  accept(result: CallToolResult): boolean {
    const incoming = result.structuredContent as unknown;
    if (!isHostTurnState(incoming)) return false;

    const changedTurn = this.snapshot?.turnId !== incoming.turnId;
    this.snapshot = incoming;
    this.refreshError = null;
    if (changedTurn) {
      this.unchangedRefreshes = 0;
      this.expanded = readActivityPanelDefaultExpanded(result._meta);
      this.followTail = true;
      this.scrollTop = 0;
      this.activities = [];
      this.indexRevision = undefined;
      this.indexError = null;
      this.resetDetails();
    } else {
      this.unchangedRefreshes = incoming.changed ? 0 : this.unchangedRefreshes + 1;
    }
    this.stopRefresh();
    this.scheduleRefresh();
    if (this.expanded && incoming.revision > 0 && this.indexRevision !== incoming.revision) {
      void this.loadIndex(false);
    }
    return true;
  }

  attach(app: App): void {
    this.app = app;
    if (!this.visibilityListenerAttached) {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
      this.visibilityListenerAttached = true;
    }
    this.scheduleRefresh();
  }

  clear(): void {
    this.stopRefresh();
    this.snapshot = null;
    this.activities = [];
    this.indexRevision = undefined;
    this.indexLoading = false;
    this.indexInFlight = false;
    this.indexError = null;
    this.refreshError = null;
    this.unchangedRefreshes = 0;
    this.expanded = false;
    this.followTail = true;
    this.scrollTop = 0;
    this.resetDetails();
  }

  detach(): void {
    this.clear();
    if (this.visibilityListenerAttached) {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
      this.visibilityListenerAttached = false;
    }
    this.app = null;
  }

  render(): boolean {
    if (!this.snapshot) return false;
    if (this.snapshot.revision === 0) {
      this.root.replaceChildren();
      return true;
    }
    this.renderPanel(this.snapshot);
    return true;
  }

  private scheduleRefresh(delayMs?: number, force = false): void {
    if (!this.app || !this.snapshot || this.refreshTimer !== null || document.hidden) return;
    const resolvedDelay = delayMs ?? activityRefreshDelayMs(
      this.snapshot.state,
      this.unchangedRefreshes,
      true,
    );
    if (!force && resolvedDelay === null) return;
    if (resolvedDelay === null) return;
    if (!this.app.getHostCapabilities()?.serverTools) {
      this.refreshError = "Live Activity refresh is unavailable in this host.";
      this.render();
      return;
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshSnapshot();
    }, resolvedDelay);
  }

  private stopRefresh(): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async refreshSnapshot(): Promise<void> {
    if (!this.app || !this.snapshot || this.refreshInFlight) return;
    const requestedTurnId = this.snapshot.turnId;
    const knownRevision = this.snapshot.revision;
    this.refreshInFlight = true;

    try {
      const result = await this.app.callServerTool({
        name: "activity_snapshot",
        arguments: { turnId: requestedTurnId, knownRevision },
      });
      if (result.isError) throw new Error("Activity snapshot refresh failed.");

      const incoming = result.structuredContent as unknown;
      if (!isHostTurnState(incoming) || incoming.turnId !== requestedTurnId) {
        throw new Error("Activity snapshot refresh returned an invalid Host Turn state.");
      }
      if (!this.snapshot || this.snapshot.turnId !== requestedTurnId) return;

      const shouldRender = incoming.changed || this.refreshError !== null;
      this.snapshot = incoming;
      this.unchangedRefreshes = incoming.changed ? 0 : this.unchangedRefreshes + 1;
      this.refreshError = null;
      if (shouldRender) this.render();
      if (incoming.changed && this.expanded && incoming.revision > 0) void this.loadIndex(false);
    } catch (refreshError) {
      this.unchangedRefreshes += 1;
      const message = refreshError instanceof Error
        ? refreshError.message
        : "Activity snapshot refresh failed.";
      if (this.refreshError !== message) {
        this.refreshError = message;
        this.render();
      }
    } finally {
      this.refreshInFlight = false;
      this.scheduleRefresh();
    }
  }

  private async loadIndex(showLoading: boolean): Promise<void> {
    if (!this.app || !this.snapshot || !this.expanded || this.snapshot.revision === 0 || this.indexInFlight) return;
    const turnId = this.snapshot.turnId;
    const knownRevision = this.indexRevision;
    this.indexInFlight = true;
    if (showLoading) {
      this.indexLoading = true;
      this.indexError = null;
      this.render();
    }

    try {
      const result = await this.app.callServerTool({
        name: "activity_index",
        arguments: {
          turnId,
          ...(knownRevision !== undefined ? { knownRevision } : {}),
        },
      });
      if (result.isError) throw new Error("Activity index request failed.");
      const incoming = result.structuredContent as unknown;
      if (!isActivityIndex(incoming) || incoming.turnId !== turnId) {
        throw new Error("Activity index returned an invalid Activity index.");
      }
      if (!this.snapshot || this.snapshot.turnId !== turnId) return;
      this.activities = applyActivityIndex(this.activities, incoming);
      this.indexRevision = incoming.revision;
      if (incoming.revision >= this.snapshot.revision) {
        this.snapshot = {
          turnId: incoming.turnId,
          revision: incoming.revision,
          changed: incoming.changed,
          state: incoming.state,
        };
      }
      this.indexError = null;
    } catch (indexError) {
      if (!this.snapshot || this.snapshot.turnId !== turnId) return;
      this.indexError = indexError instanceof Error
        ? indexError.message
        : "Activity index request failed.";
    } finally {
      this.indexLoading = false;
      this.indexInFlight = false;
      if (this.snapshot?.turnId === turnId) this.render();
      if (
        this.expanded && this.snapshot?.turnId === turnId &&
        this.indexRevision !== undefined && this.indexRevision !== this.snapshot.revision
      ) {
        void this.loadIndex(false);
      }
    }
  }

  private resetDetails(): void {
    this.stopOutputRefresh();
    this.selectedActivityId = null;
    this.details.clear();
    this.detailLoading.clear();
    this.detailErrors.clear();
    this.outputs.clear();
    this.outputLoading.clear();
    this.outputErrors.clear();
  }

  private toggleDetail(activity: ActivitySummary): void {
    if (!activity.detailAvailable) return;
    this.stopOutputRefresh();
    if (this.selectedActivityId === activity.activityId) {
      this.selectedActivityId = null;
      this.render();
      return;
    }

    this.selectedActivityId = activity.activityId;
    this.render();
    if (isBashOutputActivity(activity)) {
      const output = this.outputs.get(activity.outputId);
      if (output?.status === "running") this.scheduleOutputRefresh(activity);
      if (!output && !this.outputLoading.has(activity.outputId) && !this.outputErrors.has(activity.outputId)) {
        void this.loadOutput(activity, true);
      }
      return;
    }

    if (
      !this.details.has(activity.activityId) &&
      !this.detailLoading.has(activity.activityId) &&
      !this.detailErrors.has(activity.activityId)
    ) {
      void this.loadDetail(activity);
    }
  }

  private async loadDetail(activity: ActivitySummary): Promise<void> {
    if (!this.app || !this.snapshot || !activity.detailAvailable) return;
    const turnId = this.snapshot.turnId;
    const activityId = activity.activityId;
    this.detailLoading.add(activityId);
    this.detailErrors.delete(activityId);
    this.render();

    try {
      const result = await this.app.callServerTool({
        name: "activity_detail",
        arguments: { turnId, activityId },
      });
      if (result.isError) throw new Error("Activity detail request failed.");
      const detail = result.structuredContent as unknown;
      if (!isActivityDetail(detail) || detail.activity.activityId !== activityId) {
        throw new Error("Activity detail returned an invalid Activity record.");
      }
      if (!this.snapshot || this.snapshot.turnId !== turnId) return;
      this.details.set(activityId, detail);
    } catch (detailError) {
      if (!this.snapshot || this.snapshot.turnId !== turnId) return;
      this.detailErrors.set(
        activityId,
        detailError instanceof Error ? detailError.message : "Activity detail request failed.",
      );
    } finally {
      this.detailLoading.delete(activityId);
      if (this.snapshot?.turnId === turnId) this.render();
    }
  }

  private stopOutputRefresh(): void {
    if (this.outputRefreshTimer !== null) {
      window.clearTimeout(this.outputRefreshTimer);
      this.outputRefreshTimer = null;
    }
  }

  private scheduleOutputRefresh(
    activity: ActivitySummary,
    delayMs = ACTIVITY_OUTPUT_REFRESH_INTERVAL_MS,
  ): void {
    if (!isBashOutputActivity(activity) || this.outputRefreshTimer !== null || document.hidden) return;
    if (this.selectedActivityId !== activity.activityId) return;
    this.outputRefreshTimer = window.setTimeout(() => {
      this.outputRefreshTimer = null;
      if (this.selectedActivityId === activity.activityId) void this.loadOutput(activity, false);
    }, delayMs);
  }

  private async loadOutput(activity: ActivitySummary, showLoading: boolean): Promise<void> {
    if (!this.app || !this.snapshot || !isBashOutputActivity(activity)) return;
    const turnId = this.snapshot.turnId;
    const outputId = activity.outputId;
    if (showLoading) this.outputLoading.add(outputId);
    this.outputErrors.delete(outputId);
    if (showLoading) this.render();

    let shouldRefresh = false;
    try {
      const currentOutput = this.outputs.get(outputId);
      const result = await this.app.callServerTool({
        name: "activity_output",
        arguments: {
          turnId,
          outputId,
          ...(currentOutput ? { cursor: currentOutput.cursor } : {}),
        },
      });
      if (result.isError) throw new Error("Bash output request failed.");
      const output = result.structuredContent as unknown;
      if (!isActivityBashOutput(output) || output.outputId !== outputId) {
        throw new Error("Bash output returned an invalid durable output record.");
      }
      if (currentOutput && output.cursor < currentOutput.cursor) {
        throw new Error("Bash output cursor moved backwards.");
      }
      if (!this.snapshot || this.snapshot.turnId !== turnId) return;
      this.outputs.set(outputId, currentOutput
        ? { ...output, output: currentOutput.output + output.output }
        : output);
      shouldRefresh = output.status === "running";
    } catch (outputError) {
      if (!this.snapshot || this.snapshot.turnId !== turnId) return;
      this.outputErrors.set(
        outputId,
        outputError instanceof Error ? outputError.message : "Bash output request failed.",
      );
    } finally {
      this.outputLoading.delete(outputId);
      if (this.snapshot?.turnId === turnId) this.render();
      if (shouldRefresh && this.selectedActivityId === activity.activityId) {
        this.scheduleOutputRefresh(activity);
      }
    }
  }

  private renderActivityEntry(activity: ActivitySummary, child: boolean): HTMLElement {
    const selected = this.selectedActivityId === activity.activityId;
    const entry = element("div", {
      className: `activity-entry${selected ? " expanded" : ""}`,
    });
    entry.append(renderActivityRow(
      activity,
      child,
      selected,
      activity.detailAvailable ? () => this.toggleDetail(activity) : undefined,
    ));
    if (selected) entry.append(this.renderActivityDetail(activity));
    return entry;
  }

  private renderActivityDetail(activity: ActivitySummary): HTMLElement {
    if (isBashOutputActivity(activity)) return this.renderBashOutput(activity);

    const container = element("div", { className: "activity-detail" });
    const activityId = activity.activityId;
    if (this.detailLoading.has(activityId)) {
      container.append(element("div", { className: "activity-detail-status", text: "Loading details..." }));
      return container;
    }

    const detailError = this.detailErrors.get(activityId);
    if (detailError) {
      container.append(element("div", {
        className: "activity-detail-status error",
        text: detailError,
      }));
      return container;
    }

    const detail = this.details.get(activityId);
    if (!detail) {
      container.append(element("div", { className: "activity-detail-status", text: "Details unavailable." }));
      return container;
    }

    if (detail.error) appendDetailSection(container, "Error", detail.error, true);
    if (detail.request !== undefined) appendDetailSection(container, "Request", detail.request);
    if (detail.result !== undefined) appendDetailSection(container, "Result", detail.result);
    if (container.childElementCount === 0) {
      container.append(element("div", { className: "activity-detail-status", text: "No additional details." }));
    }
    return container;
  }

  private renderBashOutput(activity: ActivitySummary & { outputId: string }): HTMLElement {
    const container = element("div", { className: "activity-detail activity-terminal" });
    const outputId = activity.outputId;
    if (this.outputLoading.has(outputId)) {
      container.append(element("div", { className: "activity-detail-status", text: "Loading terminal output..." }));
      return container;
    }

    const outputError = this.outputErrors.get(outputId);
    if (outputError) {
      container.append(element("div", {
        className: "activity-detail-status error",
        text: outputError,
      }));
      return container;
    }

    const output = this.outputs.get(outputId);
    if (!output) {
      container.append(element("div", { className: "activity-detail-status", text: "Terminal output unavailable." }));
      return container;
    }

    container.append(
      element("pre", {
        className: "activity-terminal-command",
        text: output.command,
      }),
      element("pre", {
        className: "activity-terminal-output pretty-scrollbar",
        text: output.output || "(no output)",
      }),
      element("div", {
        className: `activity-terminal-meta status-${output.status}`,
        text: bashOutputMeta(output),
      }),
    );
    return container;
  }

  private renderPanel(snapshot: HostTurnState): void {
    const previousViewport = this.root.querySelector<HTMLElement>(".activity-viewport");
    if (previousViewport) this.scrollTop = previousViewport.scrollTop;

    const section = element("section", {
      className: `activity-panel state-${snapshot.state}`,
    });
    const header = element("button", {
      className: "activity-panel-header",
      type: "button",
      ariaExpanded: String(this.expanded),
    });
    header.addEventListener("click", () => {
      this.expanded = !this.expanded;
      if (!this.expanded) {
        this.stopOutputRefresh();
      }
      this.render();
      if (this.expanded && snapshot.revision > 0 && this.indexRevision !== snapshot.revision) {
        void this.loadIndex(true);
      }
    });

    const status = element("span", {
      className: `activity-panel-status state-${snapshot.state}`,
      ariaHidden: "true",
    });
    const titleGroup = element("span", { className: "activity-panel-title-group" });
    titleGroup.append(
      element("span", { className: "activity-panel-title", text: "Activity" }),
      element("span", {
        className: "activity-panel-subtitle",
        text: `Host Turn · revision ${snapshot.revision}`,
      }),
    );
    const count = this.activities.length;
    const summary = element("span", {
      className: `activity-panel-count state-${snapshot.state}`,
      text: this.expanded && this.indexRevision !== undefined
        ? `${count} ${count === 1 ? "activity" : "activities"}`
        : activityStateLabel(snapshot.state),
    });

    header.append(
      status,
      titleGroup,
      summary,
      renderChevron(this.expanded),
    );
    section.append(header);

    if (this.expanded) {
      const body = element("div", { className: "activity-panel-body" });
      const viewport = element("div", {
        className: "activity-viewport pretty-scrollbar",
        ariaLabel: "ForgeRelay Activity Panel",
      });
      viewport.addEventListener("scroll", () => {
        this.scrollTop = viewport.scrollTop;
        this.followTail = shouldFollowActivityTail(viewport);
      });

      const groups = groupActivitySummaries(this.activities);
      if (this.indexLoading && this.indexRevision === undefined) {
        viewport.append(element("div", {
          className: "activity-empty",
          text: "Loading Activity index...",
        }));
      } else if (this.indexError) {
        viewport.append(element("div", {
          className: "activity-empty error",
          text: this.indexError,
        }));
      } else if (groups.length === 0) {
        viewport.append(element("div", {
          className: "activity-empty",
          text: "Waiting for ForgeRelay activity...",
        }));
      } else {
        const list = element("div", { className: "activity-list" });
        for (const group of groups) {
          const groupElement = element("div", {
            className: `activity-group${group.children.length > 0 ? " grouped" : ""}`,
          });
          groupElement.append(this.renderActivityEntry(group.activity, false));
          if (group.children.length > 0) {
            const children = element("div", { className: "activity-children" });
            for (const child of group.children) {
              children.append(this.renderActivityEntry(child, true));
            }
            groupElement.append(children);
          }
          list.append(groupElement);
        }
        viewport.append(list);
      }

      if (this.refreshError) {
        body.append(element("div", {
          className: "activity-refresh-error",
          text: this.refreshError,
        }));
      }
      body.prepend(viewport);
      section.append(body);
      this.replacePanel(section);

      if (this.followTail) {
        viewport.scrollTop = viewport.scrollHeight;
        this.scrollTop = viewport.scrollTop;
      } else {
        viewport.scrollTop = Math.min(
          this.scrollTop,
          Math.max(0, viewport.scrollHeight - viewport.clientHeight),
        );
      }
      return;
    }

    this.replacePanel(section);
  }

  private replacePanel(section: HTMLElement): void {
    if (this.options.embedded) {
      this.root.replaceChildren(section);
      return;
    }
    const main = element("main", { className: "shell" });
    main.append(section);
    this.root.replaceChildren(main);
  }
}

function isBashOutputActivity(
  activity: ActivitySummary,
): activity is ActivitySummary & { outputId: string } {
  return (
    (activity.kind === "shell" || activity.kind === "shell-result") &&
    typeof activity.outputId === "string" &&
    activity.outputId.length > 0
  );
}

function bashOutputMeta(output: ActivityBashOutput): string {
  const parts = [`Process ${output.processId}`, output.status];
  if (output.timedOut) parts.push("timed out");
  else if (output.signal) parts.push(`signal ${output.signal}`);
  else if (output.exitCode !== undefined) parts.push(`exit ${output.exitCode}`);
  return parts.join(" · ");
}

function renderActivityRow(
  activity: ActivitySummary,
  child: boolean,
  expanded: boolean,
  onToggle?: () => void,
): HTMLElement {
  const row = onToggle
    ? element("button", {
        className: [
          "activity-row",
          "interactive",
          child ? "child" : "parent",
          `kind-${activityTone(activity)}`,
          `phase-${activityPhase(activity)}`,
          activity.kind === "shell-result" ? "shell-result" : undefined,
        ].filter(Boolean).join(" "),
        type: "button",
        ariaExpanded: String(expanded),
      })
    : element("div", {
        className: [
          "activity-row",
          child ? "child" : "parent",
          `kind-${activityTone(activity)}`,
          `phase-${activityPhase(activity)}`,
          activity.kind === "shell-result" ? "shell-result" : undefined,
        ].filter(Boolean).join(" "),
      });
  if (onToggle) row.addEventListener("click", onToggle);
  row.dataset.activityId = activity.activityId;

  const icon = element("span", { className: "activity-icon", ariaHidden: "true" });
  icon.append(renderIcon(activityIcon(activity), "activity-icon-svg"));

  const main = element("span", { className: "activity-main" });
  const titleLine = element("span", { className: "activity-title-line" });
  titleLine.append(element("span", { className: "activity-title", text: activity.title }));
  if (activity.member) {
    titleLine.append(element("span", {
      className: "activity-member",
      text: activity.member,
      title: `Composite member: ${activity.member}`,
    }));
  }
  titleLine.append(element("span", {
    className: "activity-target",
    text: activity.target,
    title: activity.target,
  }));
  main.append(titleLine);

  if (activity.children) {
    main.append(renderActivityProgress(activity.children));
  }

  const meta = element("span", { className: "activity-meta" });
  const phase = element("span", {
    className: "activity-phase",
    text: activityPhaseLabel(activity),
  });
  const duration = activityDurationLabel(activity.durationMs);
  meta.append(phase);
  if (duration) meta.append(element("span", { className: "activity-duration", text: duration }));

  const detailChevron = activity.detailAvailable
    ? renderChevron(expanded)
    : element("span", { className: "activity-detail-spacer", ariaHidden: "true" });
  detailChevron.classList.add("activity-detail-chevron");

  row.append(icon, main, meta, detailChevron);
  return row;
}

function appendDetailSection(
  container: HTMLElement,
  label: string,
  value: unknown,
  error = false,
): void {
  const section = element("section", {
    className: `activity-detail-section${error ? " error" : ""}`,
  });
  section.append(
    element("div", { className: "activity-detail-label", text: label }),
    element("pre", {
      className: "activity-detail-value pretty-scrollbar",
      text: detailValueText(value),
    }),
  );
  container.append(section);
}

function detailValueText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function renderActivityProgress(children: NonNullable<ActivitySummary["children"]>): HTMLElement {
  const container = element("span", { className: "activity-progress-wrap" });
  const counts = element("span", {
    className: "activity-progress-counts",
    text: activityProgressLabel(children),
  });
  const track = element("span", { className: "activity-progress-track", ariaHidden: "true" });
  const fill = element("span", { className: "activity-progress-fill" });
  const completed = children.done + children.error;
  fill.style.width = `${children.total > 0 ? Math.min(100, (completed / children.total) * 100) : 0}%`;
  track.append(fill);
  container.append(counts, track);
  return container;
}

function activityProgressLabel(children: NonNullable<ActivitySummary["children"]>): string {
  const completed = children.done + children.error;
  const parts = [`${completed}/${children.total}`];
  if (children.working > 0) parts.push(`${children.working} running`);
  if (children.error > 0) parts.push(`${children.error} failed`);
  return parts.join(" · ");
}

function activityIcon(activity: ActivitySummary): ToolIcon {
  switch (activity.kind) {
    case "read":
      return toolIcons.readFile;
    case "write":
      return toolIcons.writeFile;
    case "edit":
    case "rename":
      return toolIcons.editFile;
    case "delete":
      return toolIcons.deleteFile;
    case "shell":
      return toolIcons.terminalSquare;
    case "shell-result":
      return toolIcons.terminal;
    case "capability":
    case "batch":
      return toolIcons.skills;
    default:
      return toolIcons.files;
  }
}

function activityTone(activity: ActivitySummary): string {
  switch (activity.kind) {
    case "read":
    case "write":
    case "edit":
    case "rename":
    case "delete":
    case "shell":
    case "shell-result":
    case "capability":
    case "batch":
      return activity.kind;
    default:
      return "tool";
  }
}

function activityPhase(activity: ActivitySummary): "executing" | "returned" | "done" | "error" {
  if (activity.bashPhase) return activity.bashPhase;
  if (activity.status === "working") return "executing";
  if (activity.status === "error") return "error";
  return "done";
}

function activityStateLabel(state: HostTurnState["state"]): string {
  switch (state) {
    case "working":
      return "Working";
    case "done":
      return "Done";
    case "error":
      return "Error";
  }
}

function activityPhaseLabel(activity: ActivitySummary): string {
  if (activity.state === "blocked") return "Blocked";
  switch (activityPhase(activity)) {
    case "executing":
      return "Running";
    case "returned":
      return "Returned";
    case "done":
      return "Done";
    case "error":
      return "Error";
  }
}

function activityDurationLabel(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function renderChevron(expanded: boolean): HTMLElement {
  const chevron = element("span", {
    className: `chevron ${expanded ? "expanded" : ""}`,
    ariaHidden: "true",
  });
  chevron.append(renderIcon(toolIcons.chevronDown));
  return chevron;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    type?: string;
    title?: string;
    ariaHidden?: string;
    ariaLabel?: string;
    ariaExpanded?: string;
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type !== undefined && "type" in node) node.setAttribute("type", options.type);
  if (options.title !== undefined) node.title = options.title;
  if (options.ariaHidden !== undefined) node.setAttribute("aria-hidden", options.ariaHidden);
  if (options.ariaLabel !== undefined) node.setAttribute("aria-label", options.ariaLabel);
  if (options.ariaExpanded !== undefined) node.setAttribute("aria-expanded", options.ariaExpanded);
  return node;
}
