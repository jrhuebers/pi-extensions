import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { renderResponseResult } from "./transcript.js";
import { Type } from "typebox";

export const MAX_WAIT_SECONDS = 2_147_483_647 / 1_000;

export function waitTimeoutMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_WAIT_SECONDS) {
    throw new Error(`seconds must be a positive finite number no greater than ${MAX_WAIT_SECONDS}.`);
  }
  return Math.max(1, Math.round(seconds * 1_000));
}

export function waitMessage(message: unknown): string {
  if (typeof message !== "string" || !message.trim()) throw new Error("message must not be empty.");
  return message.trim();
}

export function waitParameters(targetDescription: string) {
  return Type.Object({
    seconds: Type.Number({
      exclusiveMinimum: 0,
      maximum: MAX_WAIT_SECONDS,
      description: "Maximum number of seconds to wait. Fractional seconds are allowed. Completion can end the wait early.",
    }),
    message: Type.String({ description: "Message to return when the wait ends or a subagent completion ends it early." }),
    targets: Type.Optional(Type.Array(Type.String(), { description: targetDescription })),
  });
}

type WaitRenderState = {
  startedAt?: number;
  finalElapsedSeconds?: number;
  timer?: ReturnType<typeof setInterval>;
  timedOut?: boolean;
  refreshCall?: () => void;
};

export function renderWaitCall(name: string, args: any, theme: Theme, context: any, defaultTargets: string): Text {
  const state = context.state as WaitRenderState;
  const seconds = typeof args.seconds === "number" ? args.seconds : Number.NaN;
  if (context.executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
  if (context.executionStarted && context.isPartial && state.timer === undefined && state.finalElapsedSeconds === undefined) {
    state.timer = setInterval(() => context.invalidate(), 1_000);
    state.timer.unref?.();
  }
  if (!context.isPartial && state.timer !== undefined) {
    clearInterval(state.timer);
    state.timer = undefined;
  }
  const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  state.refreshCall = () => {
    const elapsed = state.finalElapsedSeconds ?? (state.startedAt === undefined ? 0 : (Date.now() - state.startedAt) / 1_000);
    const duration = Number.isFinite(seconds) ? `${seconds}s` : "?s";
    const progress = Number.isFinite(elapsed) ? `${Math.round(elapsed * 10) / 10}s` : "?s";
    const targets = Array.isArray(args.targets) && args.targets.length ? args.targets.join(",") : defaultTargets;
    component.setText(
      theme.fg("toolTitle", theme.bold(`${name} `)) +
      theme.fg("muted", `${progress}/${duration}`) +
      theme.fg("accent", ` ${targets}`) +
      (state.timedOut ? theme.fg("warning", " · timed out") : ""),
    );
  };
  state.refreshCall();
  return component;
}

export function renderWaitResult(result: any, options: any, theme: Theme, context: any): Component {
  const state = (context?.state ?? {}) as WaitRenderState;
  if (!options.isPartial) {
    // Persisted execution details are authoritative, including after a reload
    // creates fresh renderer state. Never re-time an already completed wait.
    const recorded = result.details?.elapsed_seconds;
    state.finalElapsedSeconds = typeof recorded === "number" && Number.isFinite(recorded)
      ? Math.max(0, recorded)
      : state.finalElapsedSeconds ?? (state.startedAt === undefined ? undefined : (Date.now() - state.startedAt) / 1_000);
    state.timedOut = result.details?.timed_out === true;
    if (state.timer !== undefined) clearInterval(state.timer);
    state.timer = undefined;
    // Pi renders the call before the result; refresh that same Text now so the
    // authoritative duration is visible in this frame, not the next redraw.
    state.refreshCall?.();
  }
  if (context?.isError || result.isError) {
    const text = result.content?.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n") || "Wait failed.";
    return new Text(theme.fg("error", text), 0, 0);
  }
  // Older history may contain replies only inside the wait result. Keep those
  // inspectable on explicit expansion, without cluttering the default row.
  if (options.expanded && result.details?.reply_cards_present !== true) {
    return renderResponseResult(result, true, theme, "Historical wait result");
  }
  return new Text("", 0, 0);
}
