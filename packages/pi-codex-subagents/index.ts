import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Text, truncateToWidth, visibleWidth, type KeyId } from "@earendil-works/pi-tui";
import {
  AgentManager,
  getAgentDefinitionsDescription,
  loadSubagentConfig,
  THINKING_LEVELS,
  type AgentCompletionEvent,
  type AgentInfo,
  type ThinkingLevel,
  writeFullToolOutput,
} from "./core.js";
import { SubagentPeekOverlay } from "./peek.js";
import { createAgentPicker, type AgentSelection } from "./picker.js";
import { renderWaitCall, waitMessage, waitParameters } from "./wait.js";

function textResult(text: string, details?: any) {
  return { content: [{ type: "text" as const, text }], details };
}

interface BoundedText {
  text: string;
  fullOutputPath?: string;
  truncated?: true;
}

function boundedText(text: string, maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES): BoundedText {
  const truncation = truncateHead(text, { maxBytes, maxLines });
  if (!truncation.truncated) return { text };
  const fullOutputPath = writeFullToolOutput(text);
  const notice = `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
  return { text: truncation.content + notice, fullOutputPath, truncated: true };
}

function boundedTextResult(text: string, details?: any) {
  const bounded = boundedText(text);
  if (!bounded.truncated) return textResult(bounded.text, details);
  return textResult(bounded.text, { ...details, fullOutputPath: bounded.fullOutputPath, truncated: true });
}

function cleanTarget(target: string): string {
  return target.trim().replace(/^\/+/, "");
}

function parseTargets(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((target) => cleanTarget(String(target))).filter(Boolean) : undefined;
}

function parentSessionId(ctx: any): string {
  const id = ctx?.sessionManager?.getSessionId?.();
  if (!id) throw new Error("The parent Pi session has no session id.");
  return String(id);
}

export default function (pi: ExtensionAPI) {
  const widgetKey = "pi-codex-subagents";
  const completionMessageType = "pi-codex-subagent-completion";
  let cachedSkills: Array<{ name: string; description: string; filePath: string }> = [];
  let cachedSkillsSignature = "";
  let activeContext: any;
  const activeAgents = new Set<string>();

  type SpawnModel = { provider: string; modelId: string };

  const exactPair = (pattern: string): SpawnModel | undefined => {
    const colon = pattern.lastIndexOf(":");
    const reference = colon > 0 && (THINKING_LEVELS as readonly string[]).includes(pattern.slice(colon + 1)) ? pattern.slice(0, colon) : pattern;
    const slash = reference.indexOf("/");
    if (slash <= 0 || /[*?[\]]/.test(reference)) return undefined;
    return { provider: reference.slice(0, slash), modelId: reference.slice(slash + 1) };
  };

  let spawnModels = new Map<string, SpawnModel>();

  const resolveSpawnModels = (ctx: any) => {
    const config = loadSubagentConfig();
    const models = new Map<string, SpawnModel>();
    const available = new Set(ctx.modelRegistry.getAvailable().map((model: any) => `${model.provider}/${model.id}`));
    const unavailable: string[] = [];
    for (const entry of config.models ?? []) {
      const pair = exactPair(entry);
      if (pair && available.has(`${pair.provider}/${pair.modelId}`)) models.set(`${pair.provider}/${pair.modelId}`, pair);
      else unavailable.push(entry);
    }
    if (config.modelsFromEnabledModels) {
      for (const { model } of ctx.scopedModels ?? []) models.set(`${model.provider}/${model.id}`, { provider: model.provider, modelId: model.id });
    }
    if (unavailable.length) ctx.ui?.notify?.(`spawn_agent models not available: ${unavailable.join(", ")}`, "warning");
    return models;
  };

  const isCurrentSession = (parentId: string) => {
    try { return activeContext && parentSessionId(activeContext) === parentId; }
    catch { return false; }
  };

  const refreshAgentWidget = () => {
    if (!activeContext || activeContext.mode !== "tui") return;
    const running = [...activeAgents];
    if (!running.length) {
      activeContext.ui.setWidget(widgetKey, undefined);
      return;
    }
    const label = running.length === 1
      ? `${running[0]} running`
      : `${running.length} subagents running`;
    activeContext.ui.setWidget(widgetKey, (_tui: any, theme: Theme) => ({
      render(width: number) {
        const marker = "◌ ";
        const suffix = " · /subagents";
        if (width <= visibleWidth(marker) + visibleWidth(suffix)) {
          return [truncateToWidth(theme.fg("dim", "/subagents"), width, "")];
        }
        const available = width - visibleWidth(marker) - visibleWidth(suffix);
        const clippedLabel = truncateToWidth(label, available, "…");
        return [
          theme.fg("accent", marker) + theme.fg("text", clippedLabel) + theme.fg("dim", suffix),
        ];
      },
      invalidate() {},
    }));
  };

  const deliverCompletion = (event: AgentCompletionEvent) => {
    if (!isCurrentSession(event.parentSessionId)) return;
    const payload = JSON.stringify({
      agent_name: event.agentName,
      status: event.status,
      ...(event.finalResponse !== undefined ? { final_response: event.finalResponse } : {}),
      ...(event.error ? { error: event.error } : {}),
    }, null, 2);
    const bounded = boundedText(payload, DEFAULT_MAX_BYTES - 1024, DEFAULT_MAX_LINES - 4);
    pi.sendMessage({
      customType: completionMessageType,
      content: `<subagent_notification>\n${bounded.text}\n</subagent_notification>`,
      display: true,
      details: {
        agent_name: event.agentName,
        status: event.status,
        ...(bounded.fullOutputPath ? { fullOutputPath: bounded.fullOutputPath } : {}),
      },
    }, { deliverAs: "steer", triggerTurn: true });
  };

  const manager = new AgentManager({
    onActivityChange: (event) => {
      if (!isCurrentSession(event.parentSessionId)) return;
      if (event.active) activeAgents.add(event.agentName);
      else activeAgents.delete(event.agentName);
      refreshAgentWidget();
    },
    onUnclaimedCompletion: deliverCompletion,
  });

  pi.registerMessageRenderer(completionMessageType, (message: any, { expanded }: any, theme: Theme) => {
    const status = message.details?.status;
    const color = status === "completed" ? "success" : status === "failed" ? "error" : "warning";
    let text = theme.fg(color, `${status === "completed" ? "✓" : "✗"} ${message.details?.agent_name || "subagent"} ${status || "finished"}`);
    if (expanded && typeof message.content === "string") text += `\n${theme.fg("dim", message.content)}`;
    return new Text(text, 0, 0);
  });

  const spawnAgentTool = {
    name: "spawn_agent",
    label: "Spawn Agent",
    get description() {
      return `Spawn a fresh-context Pi subagent for a concrete task. Automatic extension, skill, and prompt-template discovery is disabled. Agent templates may explicitly configure a provider/model pair, thinking level, tools, skills, and extensions. Omitted template settings inherit from the parent where applicable.
${spawnModels.size ? `
A task may run on a model of its own, without a template: \`model\` takes one of the values its schema lists, and \`thinking\` sets the reasoning effort.
` : ""}
Returns after the child accepts its initial task. Continue with independent work instead of waiting; the child's final response will be delivered automatically when ready. Use \`wait_agent\` or \`wait_all_agents\` only when your next action depends on the subagent response and you have no useful work to do meanwhile.

\`agent_type\` is optional. Omit it for a generic subagent. Use a template only when the task matches it.

Available agent templates:
${getAgentDefinitionsDescription()}

Available parent skills that may be added by name:
${cachedSkills.length ? cachedSkills.map((skill) => `- \`${skill.name}\` — ${skill.description}`).join("\n") : "No model-invocable skills are loaded in the parent session."}`;
    },
    get parameters() {
      return Type.Object({
        task_name: Type.String({ description: "Task name for the new agent. Use letters, digits, underscores, dashes, and optional slash path separators." }),
        message: Type.String({ description: "Initial task for the new agent." }),
        agent_type: Type.Optional(Type.String({ description: "Optional agent template name from ~/.pi/agent/pi-codex-subagents/agents/." })),
        skills: Type.Optional(Type.Array(Type.String(), { description: "Additional skill names from the loaded parent skills listed in this tool description." })),
        ...(spawnModels.size
          ? {
              model: Type.Optional(StringEnum([...spawnModels.keys()], { description: "Optional model for this one task, for example an independent review by another vendor. Defaults to the template model, otherwise the parent model." })),
              thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Optional thinking level. Defaults to the template level, otherwise the parent level." })),
            }
          : {}),
      });
    },
    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const currentModel = ctx.model;
      if (!currentModel?.provider || !currentModel?.id) throw new Error("spawn_agent failed: the parent has no active provider/model pair.");
      const requestedSkills: string[] = params.skills ?? [];
      const loadedSkillPaths = Object.fromEntries(cachedSkills.map((skill) => [skill.name, skill.filePath]));
      const unavailableSkills = requestedSkills.filter((skill) => !Object.hasOwn(loadedSkillPaths, skill));
      if (unavailableSkills.length) throw new Error(`spawn_agent failed: skills are not loaded in the parent session: ${unavailableSkills.join(", ")}`);
      const model = params.model ? spawnModels.get(params.model) : undefined;
      if (params.model && !model) throw new Error(`spawn_agent failed: model "${params.model}" is not in the configured spawn models: ${[...spawnModels.keys()].join(", ") || "none"}`);
      if (model && !ctx.modelRegistry.getAvailable().some((entry: any) => entry.provider === model.provider && entry.id === model.modelId)) {
        throw new Error(`spawn_agent failed: model "${params.model}" is not currently available.`);
      }
      try {
        const result = await manager.spawnAgent({
          task_name: params.task_name,
          message: params.message,
          agent_type: params.agent_type,
          skills: requestedSkills,
          loadedSkillPaths,
          cwd: ctx.cwd,
          parentSessionId: parentSessionId(ctx),
          parentSessionFile: ctx.sessionManager.getSessionFile?.(),
          inheritedProvider: currentModel.provider,
          inheritedModelId: currentModel.id,
          inheritedThinking: pi.getThinkingLevel() as ThinkingLevel,
          inheritedTools: pi.getActiveTools().join(","),
          model,
          thinking: params.thinking,
        });
        const info = manager.getAgentInfo(result.task_name, parentSessionId(ctx));
        return textResult(`Spawned ${result.task_name}.`, {
          ...result,
          provider: info.provider,
          modelId: info.modelId,
          thinking: info.thinking,
        });
      } catch (error) {
        throw new Error(`spawn_agent failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    renderCall(args: any, theme: Theme) {
      return new Text(theme.fg("toolTitle", theme.bold("spawn_agent ")) + theme.fg("accent", args.task_name || "?") + theme.fg("dim", (args.agent_type ? ` [${args.agent_type}]` : "") + (args.model ? ` ${args.model}` : "")), 0, 0);
    },
    renderResult(result: any, _options: any, theme: Theme) {
      if (result.isError) return new Text(theme.fg("error", `✗ ${result.content?.[0]?.text || "failed"}`), 0, 0);
      const model = result.details?.provider && result.details?.modelId
        ? ` · ${result.details.provider}/${result.details.modelId}`
        : "";
      const thinking = result.details?.thinking ? ` · ${result.details.thinking}` : "";
      return new Text(theme.fg("success", `✓ ${result.details?.task_name || "spawned"}${model}${thinking}`), 0, 0);
    },
  };

  pi.on("session_start", async (_event: any, ctx: any) => {
    activeContext = ctx;
    activeAgents.clear();
    try { spawnModels = resolveSpawnModels(ctx); }
    catch (error: any) { ctx.ui?.notify?.(`spawn_agent model resolution failed, keeping the previous list: ${error?.message || error}`, "warning"); }
    pi.registerTool(spawnAgentTool);
    await manager.ready();
    if (activeContext !== ctx) return;
    for (const entry of manager.listAgents(undefined, parentSessionId(ctx))) {
      if (entry.agent_status === "starting" || entry.agent_status === "running") activeAgents.add(entry.agent_name);
    }
    refreshAgentWidget();
  });

  pi.on("before_agent_start", async (event: any) => {
    const skills = event?.systemPromptOptions?.skills;
    const nextSkills = Array.isArray(skills)
      ? skills
          .filter((skill: any) => !skill?.disableModelInvocation && typeof skill?.name === "string" && typeof skill?.filePath === "string")
          .map((skill: any) => ({ name: skill.name, description: String(skill.description || ""), filePath: skill.filePath }))
      : [];
    const signature = JSON.stringify(nextSkills);
    if (signature !== cachedSkillsSignature) {
      cachedSkills = nextSkills;
      cachedSkillsSignature = signature;
      pi.registerTool(spawnAgentTool);
    }
  });

  pi.on("session_shutdown", async () => {
    if (activeContext?.mode === "tui") activeContext.ui.setWidget(widgetKey, undefined);
    activeContext = undefined;
    activeAgents.clear();
    await manager.shutdown();
  });

  pi.registerTool(spawnAgentTool);

  pi.registerTool({
    name: "wait_agent",
    label: "Wait Agent",
    description: "Wait in the foreground for at most seconds, ending early on one session-owned agent completion (the next completion if targets is omitted). Return the supplied message and any final response. Expiry is a normal timed_out result, not an error, and does not stop agents. Use only when your next action depends on the response and no useful work remains; otherwise let completion arrive automatically. Use wait_all_agents when every target must finish.",
    parameters: waitParameters("Agent task names to wait on. Omit to wait for the next completion in this parent session."),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      try {
        const message = waitMessage(params.message);
        const startedAt = Date.now();
        const result = await manager.waitAgent(parentSessionId(ctx), params.seconds, parseTargets(params.targets), signal);
        const details = { message: `${result.message} ${message}`, seconds: params.seconds, elapsed_seconds: (Date.now() - startedAt) / 1_000, timed_out: result.timed_out };
        return boundedTextResult(JSON.stringify({ ...result, ...details }, null, 2), details);
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(`wait_agent failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    renderCall(args: any, theme: Theme, context: any) {
      return renderWaitCall("wait_agent", args, theme, context, "any");
    },
    renderResult(result: any, _options: any, theme: Theme) {
      if (result.isError) return new Text(theme.fg("error", "✗ wait failed"), 0, 0);
      return new Text(theme.fg("success", result.details?.message || "done"), 0, 0);
    },
  });

  pi.registerTool({
    name: "wait_all_agents",
    label: "Wait All Agents",
    description: "Wait in the foreground for at most seconds, ending early when all targeted session-owned agents reach final status. Return the supplied message, completed responses, and pending agent names. Expiry is a normal timed_out result and does not stop pending agents or discard their later notifications. Use only when your next action depends on every response and no useful work remains; otherwise let completions arrive automatically.",
    parameters: waitParameters("Agent task names to wait for. Omit to wait for agents spawned by this extension instance."),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      try {
        const message = waitMessage(params.message);
        const startedAt = Date.now();
        const result = await manager.waitAllAgents(parentSessionId(ctx), params.seconds, parseTargets(params.targets), signal);
        const details = { message: `${result.message} ${message}`, seconds: params.seconds, elapsed_seconds: (Date.now() - startedAt) / 1_000, timed_out: result.timed_out, pending_agents: result.pending_agents };
        return boundedTextResult(JSON.stringify({ ...result, ...details }, null, 2), details);
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(`wait_all_agents failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    renderCall(args: any, theme: Theme, context: any) {
      return renderWaitCall("wait_all_agents", args, theme, context, "all");
    },
    renderResult(result: any, _options: any, theme: Theme) {
      if (result.isError) return new Text(theme.fg("error", "✗ wait failed"), 0, 0);
      return new Text(theme.fg("success", result.details?.message || "done"), 0, 0);
    },
  });

  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description: "List compact agent names and statuses for the current parent session, newest first with active agents prioritized. Returns 10 by default; use offset for another page or path_prefix to narrow the result. Set include_all only for an explicit read-only historical listing across parent sessions.",
    parameters: Type.Object({
      path_prefix: Type.Optional(Type.String({ description: "Task-path prefix filter without a trailing slash." })),
      include_all: Type.Optional(Type.Boolean({ description: "Include agents from all parent sessions and show parent_session_id. Default false." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum agents to return. Default 10; maximum 100." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based offset into the compact ordered result. Default 0." })),
    }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const listed = manager.listAgents(params.path_prefix, parentSessionId(ctx), params.include_all === true);
      const ordered = [
        ...listed.filter((agent) => agent.agent_status === "starting" || agent.agent_status === "running"),
        ...listed.filter((agent) => agent.agent_status !== "starting" && agent.agent_status !== "running"),
      ];
      const limit = Number.isInteger(params.limit) ? Math.max(1, Math.min(100, params.limit)) : 10;
      const offset = Number.isInteger(params.offset) ? Math.max(0, params.offset) : 0;
      const agents = ordered.slice(offset, offset + limit).map(({ agent_name, agent_status, parent_session_id }) => ({
        agent_name,
        agent_status,
        ...(parent_session_id ? { parent_session_id } : {}),
      }));
      const nextOffset = offset + agents.length < ordered.length ? offset + agents.length : null;
      const result = { total: ordered.length, returned: agents.length, offset, limit, next_offset: nextOffset, agents };
      return textResult(JSON.stringify(result, null, 2), result);
    },
    renderCall(_args: any, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("list_agents")), 0, 0); },
    renderResult(result: any, options: any, theme: Theme) {
      const agents = result.details?.agents || [];
      const total = result.details?.total ?? agents.length;
      if (!options.expanded) return new Text(theme.fg("success", `✓ ${agents.length} of ${total} agents`), 0, 0);
      return new Text(result.content?.[0]?.text || JSON.stringify(result.details, null, 2), 0, 0);
    },
  });

  pi.registerTool({
    name: "read_agent_response",
    label: "Read Agent Response",
    description: "Read one current-session agent's latest final raw text response. Tool calls and intermediate assistant text are excluded.",
    parameters: Type.Object({ target: Type.String({ description: "Session-owned agent task name." }) }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      try {
        const result = manager.readAgentResponse(cleanTarget(params.target), parentSessionId(ctx));
        return boundedTextResult(JSON.stringify(result, null, 2), { agent_name: result.agent_name, status: result.status });
      } catch (error) {
        throw new Error(`read_agent_response failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    renderCall(args: any, theme: Theme) {
      return new Text(theme.fg("toolTitle", theme.bold("read_agent_response ")) + theme.fg("accent", args.target || "?"), 0, 0);
    },
    renderResult(result: any, _options: any, theme: Theme) {
      if (result.isError) return new Text(theme.fg("error", "✗ read failed"), 0, 0);
      return new Text(theme.fg("success", `✓ ${result.details?.agent_name || "response"}`), 0, 0);
    },
  });

  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description: "Send a message to a session-owned agent. Steers the current run when active; otherwise starts a new turn.",
    parameters: Type.Object({
      target: Type.String({ description: "Session-owned agent task name." }),
      message: Type.String({ description: "Message text to send." }),
    }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      try {
        const result = await manager.sendMessage(parentSessionId(ctx), cleanTarget(params.target), params.message);
        return textResult(result.delivery === "steer" ? "Message steered into the running agent." : "Message started a new agent turn.", { target: params.target, ...result });
      } catch (error) {
        throw new Error(`send_message failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    renderCall(args: any, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("send_message ")) + theme.fg("accent", args.target || "?"), 0, 0); },
    renderResult(result: any, _options: any, theme: Theme) {
      if (result.isError) return new Text(theme.fg("error", "✗ send failed"), 0, 0);
      return new Text(theme.fg("success", result.details?.delivery === "steer" ? "✓ steered" : "✓ started"), 0, 0);
    },
  });

  pi.registerTool({
    name: "interrupt_agent",
    label: "Interrupt Agent",
    description: "Abort a session-owned agent's current turn while keeping its session available for later send_message calls.",
    parameters: Type.Object({ target: Type.String({ description: "Session-owned agent task name." }) }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      try {
        const result = await manager.interruptAgent(parentSessionId(ctx), cleanTarget(params.target));
        return textResult("Interrupt request handled.", result);
      } catch (error) {
        throw new Error(`interrupt_agent failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    renderCall(args: any, theme: Theme) { return new Text(theme.fg("toolTitle", theme.bold("interrupt_agent ")) + theme.fg("accent", args.target || "?"), 0, 0); },
    renderResult(result: any, _options: any, theme: Theme) {
      if (result.isError) return new Text(theme.fg("error", "✗ interrupt failed"), 0, 0);
      return new Text(theme.fg("warning", `↯ previous: ${result.details?.previous_status || "unknown"}`), 0, 0);
    },
  });

  async function openAgentOverlay(ctx: any, task: string, scopeId = parentSessionId(ctx), includeAll = false) {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Subagent overlays require interactive TUI mode.", "warning");
      return;
    }
    let info: AgentInfo;
    try { info = manager.getAgentInfo(task, scopeId); }
    catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); return; }

    while (true) {
      const navigation = await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: any) => new SubagentPeekOverlay(tui, theme, info, done), {
        overlay: true,
        overlayOptions: { anchor: "right-center", width: "45%", minWidth: 50, maxHeight: 60, margin: { right: 2, top: 2, bottom: 2 } },
      });
      if (navigation !== "previous" && navigation !== "next") return;

      const currentSessionId = parentSessionId(ctx);
      const entries = manager.listAgents(undefined, currentSessionId, includeAll);
      if (entries.length < 2) return;
      const currentIndex = entries.findIndex((entry) =>
        entry.agent_name === info.canonicalName &&
        (entry.parent_session_id || currentSessionId) === info.parentSessionId
      );
      if (currentIndex === -1) return;
      const offset = navigation === "next" ? 1 : -1;
      const next = entries[(currentIndex + offset + entries.length) % entries.length];
      info = manager.getAgentInfo(next.agent_name, next.parent_session_id || currentSessionId);
    }
  }

  async function pickAgent(ctx: any): Promise<AgentSelection | undefined> {
    const currentSessionId = parentSessionId(ctx);
    return await ctx.ui.custom((tui: any, theme: Theme, _keybindings: any, done: any) =>
      createAgentPicker(tui, theme, (includeAll) => manager.listAgentInfos(currentSessionId, includeAll), done),
    );
  }

  const browseAgents = async (ctx: any) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Subagent overlays require interactive TUI mode.", "warning");
      return;
    }
    const selected = await pickAgent(ctx);
    if (selected) await openAgentOverlay(ctx, selected.task, selected.parentSessionId, selected.includeAll);
  };

  const shortcut = loadSubagentConfig().shortcut?.trim();
  if (shortcut) {
    pi.registerShortcut(shortcut as KeyId, {
      description: "Browse subagents",
      handler: browseAgents,
    });
  }

  pi.registerCommand("subagents", {
    description: "Browse subagents",
    handler: async (_args, ctx) => browseAgents(ctx),
  });
}
