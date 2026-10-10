import type { Theme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { StringDecoder } from "node:string_decoder";

const PREVIEW_LINES = 8;
const PREVIEW_CHARS = 2_000;

function textContent(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
  return "";
}

function parsePayload(text: string): any {
  const prefix = "<subagent_notification>";
  const suffix = "</subagent_notification>";
  const trimmed = text.trim();
  const json = trimmed.startsWith(prefix) && trimmed.endsWith(suffix)
    ? trimmed.slice(prefix.length, -suffix.length).trim()
    : trimmed;
  try { return JSON.parse(json); } catch { return undefined; }
}

export function responseBody(payload: any): string {
  const responses = payload?.event ? [payload.event]
    : Array.isArray(payload?.responses) ? payload.responses
    : payload?.agent_name ? [payload]
    : [];
  return responses.map((response: any) => {
    const name = response.agent_name ?? response.agentName ?? "subagent";
    const body = response.finalResponse ?? response.final_response ?? response.error ?? "(No final text returned.)";
    return `${name} → lead · ${response.status ?? "finished"}\n${body}`;
  }).join("\n\n");
}

// Keep oversized payloads readable without parsing an intentionally truncated
// JSON string or performing synchronous file I/O in a renderer.
export function boundedDisplayText(text: string, fullOutputPath?: string): string {
  const maxBytes = DEFAULT_MAX_BYTES - 1024;
  const bytes = Buffer.from(text, "utf8");
  // truncateHead drops a whole line when it does not fit. Byte-bound first so
  // even a giant single-paragraph response has a useful, valid UTF-8 preview.
  const prefix = bytes.length > maxBytes ? new StringDecoder("utf8").write(bytes.subarray(0, maxBytes)) : text;
  const bounded = truncateHead(prefix, { maxBytes, maxLines: DEFAULT_MAX_LINES - 4 });
  return bounded.content + (fullOutputPath ? `\n\n[Full output saved to: ${fullOutputPath}]` : "");
}

export function renderExchange(header: string, body: string, theme: Theme, expanded: boolean, color: "success" | "error" | "warning" | "toolTitle" = "toolTitle"): Component {
  const heading = new Text(theme.fg(color, header), 0, 0);
  const clipped = !expanded && body.length > PREVIEW_CHARS;
  const text = new Text(theme.fg("text", clipped ? body.slice(0, PREVIEW_CHARS) : body), 0, 0);
  const hint = new Text(theme.fg("dim", "… expand tools to read the full message"), 0, 0);
  return {
    render(width: number): string[] {
      if (width <= 0) return [];
      const bodyLines = body ? text.render(width) : [];
      const truncated = !expanded && (clipped || bodyLines.length > PREVIEW_LINES);
      return [
        ...heading.render(width),
        ...(expanded ? bodyLines : bodyLines.slice(0, PREVIEW_LINES)),
        ...(truncated ? hint.render(width) : []),
      ].map((line) => truncateToWidth(line, width, ""));
    },
    invalidate() { heading.invalidate(); text.invalidate(); hint.invalidate(); },
  };
}

export function renderCompletion(message: any, expanded: boolean, theme: Theme): Component {
  const content = textContent(message.content);
  const payload = parsePayload(content);
  const status = message.details?.status ?? payload?.status;
  const name = message.details?.agent_name ?? payload?.agent_name ?? "subagent";
  const body = message.details?.display_text ?? payload?.final_response ?? payload?.error ?? content;
  const header = theme.bold(String(name).replace(/^\/+/, "")) + theme.fg("dim", ` · ${status ?? "finished"}`);
  // A neutral reply card, not a pretend tool call. Display entries and legacy
  // notifications share the same framing as completed tool-result panels.
  const failed = status === "failed" || status === "interrupted";
  const box = new Box(1, 1, (text) => theme.bg(failed ? "toolErrorBg" : "toolSuccessBg", text));
  box.addChild(renderExchange(header, body || "(No final text returned.)", theme, expanded));
  return {
    render(width: number) { return width <= 0 ? [] : box.render(width).map((line) => truncateToWidth(line, width, "")); },
    invalidate() { box.invalidate(); },
  };
}

export function renderResponseResult(result: any, expanded: boolean, theme: Theme, fallback: string, executionError = false): Component {
  const content = textContent(result.content);
  const payload = parsePayload(content);
  const isError = executionError || result.isError === true;
  const header = isError ? "✗ Subagent tool failed" : result.details?.message ?? fallback;
  // Older oversized tool results have intentionally incomplete JSON and no
  // display_text. Keep their raw content/file notice visible on expansion.
  const body = result.details?.display_text ?? (payload === undefined ? content : responseBody(payload));
  const pending = payload?.pending_agents ?? result.details?.pending_agents;
  const pendingText = Array.isArray(pending) && pending.length ? `Pending: ${pending.join(", ")}` : "";
  const color = isError ? "error" : result.details?.timed_out ? "warning" : "success";
  return renderExchange(header, isError ? content : [body, pendingText].filter(Boolean).join("\n\n"), theme, expanded, color);
}
