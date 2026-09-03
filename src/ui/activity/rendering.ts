import type { ToolResultCard } from "../core/card-types.js";
import { renderIcon, toolIcons, type ToolIcon } from "../core/icons.js";
import type { ActivityBashOutput, ActivitySummary, HostTurnState } from "./model.js";

export function isBashOutputActivity(
  activity: ActivitySummary,
): activity is ActivitySummary & { outputId: string } {
  return (
    (activity.kind === "shell" || activity.kind === "shell-result") &&
    typeof activity.outputId === "string" &&
    activity.outputId.length > 0
  );
}

export function bashOutputMeta(output: ActivityBashOutput): string {
  const parts = [`Process ${output.processId}`, output.status];
  if (output.timedOut) parts.push("timed out");
  else if (output.signal) parts.push(`signal ${output.signal}`);
  else if (output.exitCode !== undefined) parts.push(`exit ${output.exitCode}`);
  return parts.join(" · ");
}

export function renderActivityRow(
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

export function appendDetailSection(
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

export function detailValueText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function renderActivityProgress(children: NonNullable<ActivitySummary["children"]>): HTMLElement {
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

export function activityProgressLabel(children: NonNullable<ActivitySummary["children"]>): string {
  const completed = children.done + children.error;
  const parts = [`${completed}/${children.total}`];
  if (children.working > 0) parts.push(`${children.working} running`);
  if (children.error > 0) parts.push(`${children.error} failed`);
  return parts.join(" · ");
}

export function activityIcon(activity: ActivitySummary): ToolIcon {
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

export function activityTone(activity: ActivitySummary): string {
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

export function activityPhase(activity: ActivitySummary): "executing" | "returned" | "done" | "error" {
  if (activity.bashPhase) return activity.bashPhase;
  if (activity.status === "working") return "executing";
  if (activity.status === "error") return "error";
  return "done";
}

export function activityStateLabel(state: HostTurnState["state"]): string {
  switch (state) {
    case "working":
      return "Working";
    case "done":
      return "Done";
    case "error":
      return "Error";
  }
}

export function activityPhaseLabel(activity: ActivitySummary): string {
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

export function activityDurationLabel(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

export function renderChevron(expanded: boolean): HTMLElement {
  const chevron = element("span", {
    className: `chevron ${expanded ? "expanded" : ""}`,
    ariaHidden: "true",
  });
  chevron.append(renderIcon(toolIcons.chevronDown));
  return chevron;
}

export function element<K extends keyof HTMLElementTagNameMap>(
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
