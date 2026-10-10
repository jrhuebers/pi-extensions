import { describe, expect, test } from "bun:test";
import { MAX_WAIT_SECONDS, renderWaitCall, waitMessage, waitParameters, waitTimeoutMs } from "./wait.js";

const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

describe("sleep-shaped bounded wait parameters", () => {
  test("requires seconds and message, with optional targets and the same timer limit as sleep", () => {
    const schema = waitParameters("Targets.");
    expect(schema.required).toEqual(["seconds", "message"]);
    expect(schema.properties.seconds.exclusiveMinimum).toBe(0);
    expect(schema.properties.seconds.maximum).toBe(MAX_WAIT_SECONDS);
    expect(schema.properties.targets.type).toBe("array");
    expect(waitTimeoutMs(0.25)).toBe(250);
    expect(waitTimeoutMs(MAX_WAIT_SECONDS)).toBe(2147483647);
    expect(waitTimeoutMs(0.00001)).toBe(1);
  });

  test("rejects omitted, nonfinite, nonpositive, and overflowing durations", () => {
    for (const seconds of [undefined, null, "1", NaN, Infinity, -Infinity, 0, -1, MAX_WAIT_SECONDS + 1]) {
      expect(() => waitTimeoutMs(seconds as number)).toThrow("seconds");
    }
    for (const message of [undefined, null, 1, "", "  "]) {
      expect(() => waitMessage(message)).toThrow("message");
    }
    expect(waitMessage("  Reassess.  ")).toBe("Reassess.");
  });
});

describe("bounded wait progress renderer", () => {
  test("shows elapsed/maximum, message and targets, then clears its refresh interval", () => {
    const context: any = { state: {}, executionStarted: true, isPartial: true, invalidate() {} };
    const args = { seconds: 120, message: "Check progress.", targets: ["review"] };
    const call = renderWaitCall("wait_agent", args, theme, context, "any");
    expect(call.render(120).join("\n")).toContain('0s/120s review: "Check progress."');
    expect(context.state.timer).toBeDefined();
    context.state.startedAt -= 2000;
    context.lastComponent = call;
    const updated = renderWaitCall("wait_agent", args, theme, context, "any");
    expect(updated).toBe(call);
    expect(updated.render(120).join("\n")).toContain("2s/120s");
    context.isPartial = false;
    renderWaitCall("wait_agent", args, theme, context, "any");
    expect(context.state.timer).toBeUndefined();
    const finalElapsed = context.state.finalElapsedSeconds;
    context.state.startedAt -= 5000;
    renderWaitCall("wait_agent", args, theme, context, "any");
    expect(context.state.finalElapsedSeconds).toBe(finalElapsed);
  });

  test("tolerates a partially streamed call before execution", () => {
    const context: any = { state: {}, executionStarted: false, isPartial: true };
    const result = renderWaitCall("wait_all_agents", {}, theme, context, "all");
    expect(result.render(120).join("\n")).toContain("?s all");
    expect(context.state.timer).toBeUndefined();
  });
});
