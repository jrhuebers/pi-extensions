import { describe, expect, test } from "bun:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { MAX_WAIT_SECONDS, renderWaitCall, renderWaitResult, waitMessage, waitParameters, waitTimeoutMs } from "./wait.js";

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
  test("shows only elapsed/maximum and targets, then freezes the recorded duration", () => {
    const context: any = { state: {}, executionStarted: true, isPartial: true, invalidate() {} };
    const args = { seconds: 120, message: "Check progress.", targets: ["review"] };
    const call = renderWaitCall("wait_agent", args, theme, context, "any");
    expect(call.render(120).join("\n")).toContain("0s/120s review");
    expect(call.render(120).join("\n")).not.toContain("Check progress.");
    expect(context.state.timer).toBeDefined();
    context.state.startedAt -= 2000;
    context.lastComponent = call;
    const updated = renderWaitCall("wait_agent", args, theme, context, "any");
    expect(updated).toBe(call);
    expect(updated.render(120).join("\n")).toContain("2s/120s");
    context.isPartial = false;
    renderWaitCall("wait_agent", args, theme, context, "any");
    const result = { details: { elapsed_seconds: 2.3, timed_out: false }, content: [{ type: "text", text: "Reply must not appear in this box." }] };
    expect(renderWaitResult(result, { isPartial: false }, theme, context).render(120)).toEqual([]);
    expect(call.render(120).join("\n")).toContain("2.3s/120s review");
    expect(context.state.timer).toBeUndefined();
    const finalElapsed = context.state.finalElapsedSeconds;
    context.state.startedAt -= 5000;
    renderWaitCall("wait_agent", args, theme, context, "any");
    expect(context.state.finalElapsedSeconds).toBe(finalElapsed);
  });

  test("restores persisted elapsed time in the same frame after reload, rather than resetting to zero", () => {
    const context: any = { state: {}, executionStarted: true, isPartial: false };
    const call = renderWaitCall("wait_agent", { seconds: 30, targets: ["demo"] }, theme, context, "any");
    renderWaitResult({ details: { elapsed_seconds: 12.4, timed_out: false } }, { isPartial: false }, theme, context);
    expect(call.render(120).join("\n")).toContain("12.4s/30s demo");
    context.lastComponent = call;
    renderWaitCall("wait_agent", { seconds: 30, targets: ["demo"] }, theme, context, "any");
    expect(call.render(120).join("\n")).toContain("12.4s/30s demo");
    renderWaitResult({ details: { elapsed_seconds: 30.1, timed_out: true } }, { isPartial: false }, theme, context);
    expect(call.render(120).join("\n")).toContain("30.1s/30s demo · timed out");
  });

  test("native tool component retains recorded duration across replay, expansion, and redraw", () => {
    initTheme("dark", false);
    const component = new ToolExecutionComponent("wait_agent", "recorded-wait", { seconds: 30, targets: ["demo"], message: "No repeated message." }, {}, {
      renderCall: (args, theme, context) => renderWaitCall("wait_agent", args, theme, context, "any"),
      renderResult: renderWaitResult,
    }, { requestRender() {} } as any, "/tmp");
    component.markExecutionStarted();
    component.updateResult({ content: [{ type: "text", text: "Reply must not be duplicated in the wait row." }], details: { elapsed_seconds: 12.4, timed_out: false, reply_cards_present: true }, isError: false });
    for (const expanded of [false, true, false]) {
      component.setExpanded(expanded);
      component.invalidate();
      const text = component.render(120).map(stripVTControlCharacters).join("\n");
      expect(text).toContain("12.4s/30s demo");
      expect(text).not.toContain("Reply must not");
      expect(text).not.toContain("No repeated message.");
    }
  });

  test("keeps real execution errors visible while hiding successful results", () => {
    const result = { content: [{ type: "text", text: "Wait cancelled." }], details: { elapsed_seconds: 1.5 } };
    const context: any = { state: {}, isError: true };
    expect(renderWaitResult(result, { isPartial: false }, theme, context).render(120).join("\n")).toContain("Wait cancelled.");
  });

  test("historical wait replies without a separate card remain inspectable only on expansion", () => {
    const result = { content: [{ type: "text", text: JSON.stringify({ event: { agentName: "/old", status: "completed", finalResponse: "Historical reply." } }) }] };
    expect(renderWaitResult(result, { expanded: false, isPartial: false }, theme, {}).render(120)).toEqual([]);
    expect(renderWaitResult(result, { expanded: true, isPartial: false }, theme, {}).render(120).join("\n")).toContain("Historical reply.");
  });

  test("tolerates a partially streamed call before execution", () => {
    const context: any = { state: {}, executionStarted: false, isPartial: true };
    const result = renderWaitCall("wait_all_agents", {}, theme, context, "all");
    expect(result.render(120).join("\n")).toContain("?s all");
    expect(context.state.timer).toBeUndefined();
  });
});
