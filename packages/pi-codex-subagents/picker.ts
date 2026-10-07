import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentInfo } from "./core.js";

export interface AgentSelection {
  task: string;
  parentSessionId: string;
  includeAll: boolean;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatColumn(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function runtimeLabel(info: AgentInfo): string {
  const start = info.startedAt || info.createdAt;
  const final = ["completed", "failed", "interrupted"].includes(info.status);
  const end = final ? (info.completedAt || info.updatedAt || Date.now()) : Date.now();
  return formatDuration(end - start);
}

/** One disk snapshot per open/refresh/scope change; rendering and navigation do no I/O. */
export function createAgentPicker(
  tui: { requestRender(): void },
  theme: Theme,
  loadInfos: (includeAll: boolean) => AgentInfo[],
  done: (selection: AgentSelection | undefined) => void,
) {
  let selected = 0;
  let showAll = false;
  let entries = loadInfos(showAll);
  let cached: string[] | undefined;
  let cachedWidth: number | undefined;
  const fg = theme.fg.bind(theme);
  const pageSize = 10;
  const refresh = () => { cached = undefined; tui.requestRender(); };
  const reload = () => {
    // Preserve selection by identity if new agents changed the ordering.
    const previous = entries[selected];
    const next = loadInfos(showAll);
    const index = previous ? next.findIndex((info) => info.id === previous.id && info.parentSessionId === previous.parentSessionId) : -1;
    entries = next;
    selected = index >= 0 ? index : Math.max(0, Math.min(selected, entries.length - 1));
    refresh();
  };

  return {
    render(width: number): string[] {
      if (cached && cachedWidth === width) return cached;
      const scopeLabel = showAll ? "all sessions" : "this session";
      const lines = [fg("accent", "─".repeat(width)), fg("accent", theme.bold(" Subagents")) + fg("dim", ` (${entries.length}, ${scopeLabel})`), ""];
      if (!entries.length) lines.push(fg("dim", showAll ? "No subagents found." : "No subagents for this session. Press tab to show all."));
      const viewStart = entries.length > pageSize ? Math.max(0, Math.min(selected - Math.floor(pageSize / 2), entries.length - pageSize)) : 0;
      const viewEnd = Math.min(viewStart + pageSize, entries.length);
      const statusWidth = 11;
      const durationWidth = 6;
      const thinkingWidth = 7;
      const fixedWidth = 2 + statusWidth + durationWidth + thinkingWidth + 4 + (showAll ? 9 : 0);
      const nameWidth = Math.min(28, Math.max(8, width - fixedWidth - 8));
      const modelWidth = Math.max(0, Math.min(28, width - fixedWidth - nameWidth));
      if (viewStart > 0) lines.push(fg("dim", `  ↑ ${viewStart} more`));
      for (let index = viewStart; index < viewEnd; index++) {
        const info = entries[index];
        const pointer = index === selected ? fg("accent", "› ") : "  ";
        const name = formatColumn(info.canonicalName, nameWidth);
        const parent = showAll ? ` ${info.parentSessionId.slice(-8)}` : "";
        const details = [
          formatColumn(runtimeLabel(info), durationWidth),
          formatColumn(info.modelId || "unknown", modelWidth),
          formatColumn(info.thinking || "off", thinkingWidth),
        ].join(" ");
        lines.push(pointer + fg(index === selected ? "accent" : "text", name) + " " + fg(info.status === "failed" ? "error" : info.status === "completed" ? "success" : "warning", info.status.padEnd(statusWidth)) + " " + fg("dim", details + parent));
        if (info.lastTaskMessage) {
          // Only normalize previews for visible rows, never all historical prompts.
          const preview = info.lastTaskMessage.replace(/\s+/g, " ").trim();
          const bounded = preview.length > 180 ? `${preview.slice(0, 179)}…` : preview;
          if (bounded) lines.push("  " + fg("dim", truncateToWidth(bounded, Math.max(0, width - 4))));
        }
      }
      if (viewEnd < entries.length) lines.push(fg("dim", `  ↓ ${entries.length - viewEnd} more`));
      lines.push("", fg("dim", "enter: open  tab: this/all sessions  r: refresh  q/esc: close"));
      cached = lines.map((line) => truncateToWidth(line, width));
      cachedWidth = width;
      return cached;
    },
    handleInput(data: string) {
      // Do not scan the filesystem even for unrelated keys or closing the picker.
      if (matchesKey(data, "escape") || data === "q") { done(undefined); return; }
      if (matchesKey(data, "tab") || data === "\t") {
        showAll = !showAll;
        selected = 0;
        entries = loadInfos(showAll);
        refresh();
        return;
      }
      if (data === "r") { reload(); return; }
      if (matchesKey(data, "down") || data === "j") { selected = Math.min(Math.max(0, entries.length - 1), selected + 1); refresh(); return; }
      if (matchesKey(data, "up") || data === "k") { selected = Math.max(0, selected - 1); refresh(); return; }
      if (matchesKey(data, "return") && entries[selected]) {
        const info = entries[selected];
        done({ task: info.canonicalName, parentSessionId: info.parentSessionId, includeAll: showAll });
      }
    },
    // Theme/width invalidation is layout-only: it must not rescan metadata.
    invalidate() { cached = undefined; },
  };
}
