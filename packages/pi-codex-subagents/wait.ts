import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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
};

export function renderWaitCall(name: string, args: any, theme: Theme, context: any, defaultTargets: string): Text {
  const state = context.state as WaitRenderState;
  const seconds = typeof args.seconds === "number" ? args.seconds : Number.NaN;
  if (context.executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
  if (context.executionStarted && context.isPartial && state.timer === undefined) {
    state.timer = setInterval(() => context.invalidate(), 1_000);
    state.timer.unref?.();
  }
  if (!context.isPartial && state.timer !== undefined) {
    clearInterval(state.timer);
    state.timer = undefined;
  }
  const elapsed = state.startedAt === undefined ? 0 : Math.min(seconds, (Date.now() - state.startedAt) / 1_000);
  if (context.executionStarted && !context.isPartial && state.finalElapsedSeconds === undefined) state.finalElapsedSeconds = elapsed;
  const duration = Number.isFinite(seconds) ? `${seconds}s` : "?s";
  const progress = Number.isFinite(state.finalElapsedSeconds ?? elapsed)
    ? `${Math.round((state.finalElapsedSeconds ?? elapsed) * 10) / 10}s`
    : "?s";
  const targets = Array.isArray(args.targets) && args.targets.length ? args.targets.join(",") : defaultTargets;
  const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  component.setText(
    theme.fg("toolTitle", theme.bold(`${name} `)) +
    theme.fg("muted", `${progress}/${duration}`) +
    theme.fg("accent", ` ${targets}`) +
    theme.fg("dim", `: ${JSON.stringify(typeof args.message === "string" ? args.message.trim() : "?")}`),
  );
  return component;
}
