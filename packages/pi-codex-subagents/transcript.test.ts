import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { boundedDisplayText, renderCompletion, renderExchange, renderResponseResult, responseBody } from "./transcript.js";

const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const rendered = (component: any, width = 120) => component.render(width).map((line: string) => line.trimEnd()).join("\n");

function notification(response: string, status = "completed") {
  return {
    content: `<subagent_notification>\n${JSON.stringify({ agent_name: "/review", status, ...(status === "failed" ? { error: response } : { final_response: response }) }, null, 2)}\n</subagent_notification>`,
    details: { agent_name: "/review", status },
  };
}

describe("visible subagent exchanges", () => {
  test("shows readable automatic responses without expansion or protocol JSON", () => {
    const message = notification('Review complete.\nUse "safe" defaults.');
    const original = message.content;
    const text = rendered(renderCompletion(message, false, theme));
    expect(text).toContain("/review → lead");
    expect(text).toContain('Review complete.\nUse "safe" defaults.');
    expect(text).not.toContain("<subagent_notification>");
    expect(text).not.toContain("final_response");
    expect(message.content).toBe(original);
  });

  test("shows failure text and historical text-block content", () => {
    const failed = notification("Request failed.", "failed");
    failed.content = [{ type: "text", text: failed.content }] as any;
    expect(rendered(renderCompletion(failed, false, theme))).toContain("Request failed.");
    expect(rendered(renderCompletion(failed, false, theme))).toContain("failed");
  });

  test("previews long single-paragraph prompts, and expansion reveals their full text", () => {
    const body = "assignment ".repeat(500) + "FINAL_PROMPT_LINE";
    const collapsed = rendered(renderExchange("lead → review", body, theme, false), 80);
    expect(collapsed).toContain("assignment");
    expect(collapsed).toContain("expand tools");
    expect(collapsed).not.toContain("FINAL_PROMPT_LINE");
    const expanded = rendered(renderExchange("lead → review", body, theme, true), 80);
    expect(expanded).toContain("FINAL_PROMPT_LINE");
    expect(expanded).not.toContain("expand tools");
  });

  test("previews long responses by rendered lines and preserves terminal width", () => {
    const body = Array.from({ length: 50 }, (_, i) => `line ${i}: 文字`).join("\n");
    for (const width of [1, 10, 40, 80]) {
      const component = renderExchange("/review → lead", body, theme, false);
      component.invalidate();
      expect(component.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(rendered(renderExchange("/review → lead", body, theme, false))).not.toContain("line 49");
    expect(rendered(renderExchange("/review → lead", body, theme, true))).toContain("line 49");
  });

  test("wait and read tool results show responses and partial-wait pending names", () => {
    const payload = {
      responses: [
        { agent_name: "/first", status: "completed", finalResponse: "First review." },
        { agent_name: "/second", status: "failed", error: "Second failed." },
      ],
      pending_agents: ["/third"],
    };
    const result = { content: [{ type: "text", text: JSON.stringify(payload) }], details: { message: "Wait expired.", timed_out: true } };
    const text = rendered(renderResponseResult(result, false, theme, "fallback"));
    expect(text).toContain("First review.");
    expect(text).toContain("Second failed.");
    expect(text).toContain("Pending: /third");
    expect(responseBody({ event: { agentName: "/event", status: "completed", finalResponse: "Event reply." } })).toContain("Event reply.");
    expect(responseBody({ agent_name: "/read", status: "completed", finalResponse: "Read reply." })).toContain("Read reply.");
  });

  test("oversized/truncated JSON still shows readable response text and its file notice", () => {
    const singleLine = boundedDisplayText("文字".repeat(30_000), "/tmp/single-line.txt");
    expect(singleLine).toContain("文字");
    expect(singleLine).not.toContain("�");
    expect(Buffer.byteLength(singleLine)).toBeLessThan(50 * 1024);
    const display = boundedDisplayText("Readable response.\n".repeat(5000), "/tmp/full-output.txt");
    expect(Buffer.byteLength(display)).toBeLessThan(50 * 1024);
    expect(display).toContain("Full output saved to: /tmp/full-output.txt");
    const message = { content: '<subagent_notification>\n{"final_response":"incomplete', details: { agent_name: "/large", status: "completed", display_text: display } };
    const expanded = rendered(renderCompletion(message, true, theme));
    expect(expanded).toContain("Readable response.");
    expect(expanded).toContain("/tmp/full-output.txt");
    const result = { content: [{ type: "text", text: '{"event":{"finalResponse":"incomplete' }], details: { display_text: display } };
    expect(rendered(renderResponseResult(result, true, theme, "wait finished"))).toContain("Readable response.");
    const historical = { content: [{ type: "text", text: '{"event":{"finalResponse":"legacy text\n[Full output saved to: /tmp/legacy.txt]' }] };
    expect(rendered(renderResponseResult(historical, true, theme, "wait finished"))).toContain("legacy text");
    expect(rendered(renderResponseResult(historical, true, theme, "wait finished"))).toContain("/tmp/legacy.txt");
  });

  test("does not hide tool execution errors", () => {
    const result = { isError: true, content: [{ type: "text", text: "Agent not found." }] };
    expect(rendered(renderResponseResult(result, false, theme, "wait failed"))).toContain("Agent not found.");
    const thrownError = { content: [{ type: "text", text: "Real TUI execution error." }] };
    const text = rendered(renderResponseResult(thrownError, false, theme, "wait finished", true));
    expect(text).toContain("Real TUI execution error.");
    expect(text).toContain("failed");
  });
});
