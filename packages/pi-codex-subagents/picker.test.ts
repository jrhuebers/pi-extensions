import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createAgentPicker, type AgentSelection } from "./picker.js";
import type { AgentInfo } from "./core.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
function info(index: number, parentSessionId = "parent"): AgentInfo {
  return {
    id: `id-${index}`, taskName: `task-${index}`, canonicalName: `/task-${index}`,
    parentSessionId, provider: "test", modelId: "model", model: "test:model",
    cwd: "/tmp", sessionFile: "", infoFile: "", logFile: "",
    createdAt: 1000, updatedAt: 2000, completedAt: 2000,
    messageCount: 1, status: "completed", lastTaskMessage: `Task ${index}`,
  };
}

function harness(entries: AgentInfo[]) {
  let loads = 0;
  const scopes: boolean[] = [];
  let result: AgentSelection | undefined;
  let doneCalls = 0;
  const picker = createAgentPicker({ requestRender() {} }, theme, (scope) => {
    loads++;
    scopes.push(scope);
    return entries.slice();
  }, (selection) => { result = selection; doneCalls++; });
  return { picker, scopes, loads: () => loads, result: () => result, doneCalls: () => doneCalls };
}

describe("subagent picker metadata snapshot", () => {
  test("opens with one snapshot and performs zero loads on navigation/render/invalidation", () => {
    const h = harness(Array.from({ length: 1000 }, (_, i) => info(i)));
    h.picker.render(100);
    for (let i = 0; i < 100; i++) {
      for (const key of ["j", "k", "\x1b[B", "\x1b[A", "unrelated"]) {
        h.picker.handleInput(key);
        h.picker.invalidate(); // Pi may invalidate on every frame.
        h.picker.render(i % 2 ? 80 : 100);
      }
    }
    expect(h.loads()).toBe(1);
    h.picker.handleInput("j");
    h.picker.handleInput("\r");
    expect(h.result()).toEqual({ task: "/task-1", parentSessionId: "parent", includeAll: false });
    expect(h.loads()).toBe(1);
  });

  test("refresh reloads once, updates status, and preserves selected identity", () => {
    const entries = [info(0), info(1), info(2)];
    const h = harness(entries);
    h.picker.handleInput("j");
    entries[1] = { ...entries[1], status: "failed" };
    entries.unshift(info(3));
    h.picker.handleInput("r");
    expect(h.loads()).toBe(2);
    expect(h.picker.render(100).join("\n")).toContain("failed");
    h.picker.handleInput("\r");
    expect(h.result()?.task).toBe("/task-1");
  });

  test("scope changes reload once and distinguish identical task names in different sessions", () => {
    const h = harness([info(0, "other-parent"), info(0, "parent")]);
    h.picker.handleInput("\t");
    h.picker.render(100);
    h.picker.handleInput("j");
    h.picker.handleInput("\r");
    expect(h.scopes).toEqual([false, true]);
    expect(h.result()).toEqual({ task: "/task-0", parentSessionId: "parent", includeAll: true });
    h.picker.handleInput("\t");
    expect(h.scopes).toEqual([false, true, false]);
  });

  test("handles empty/shrinking lists and closes without disk access", () => {
    const entries = [info(0), info(1)];
    const h = harness(entries);
    h.picker.handleInput("j");
    entries.length = 0;
    h.picker.handleInput("r");
    for (const key of ["j", "k", "\r"]) h.picker.handleInput(key);
    expect(h.doneCalls()).toBe(0);
    expect(h.picker.render(60).join("\n")).toContain("No subagents");
    h.picker.handleInput("q");
    expect(h.doneCalls()).toBe(1);
    expect(h.loads()).toBe(2);
  });

  test("bounds rendered lines across widths and only shows the visible page", () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({ ...info(i),
      canonicalName: `/長い名前-${i}-` + "x".repeat(100), lastTaskMessage: "多くの文字 " .repeat(500),
    }));
    const h = harness(entries);
    for (const width of [1, 10, 30, 50, 80, 120]) {
      for (const line of h.picker.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(h.picker.render(120).filter((line) => line.includes("completed"))).toHaveLength(10);
    expect(h.loads()).toBe(1);
  });
});
