# pi-codex-subagents

Codex-shaped, session-scoped subagents for [Pi](https://github.com/earendil-works/pi). Spawn isolated child Pi processes, receive their final responses automatically, steer active work, and inspect sessions in a live overlay.

Requires Pi 0.80.4 or newer and Node.js 22.19 or newer.

## Install

```bash
pi install npm:@ogulcancelik/pi-codex-subagents
```

For local development:

```bash
pi install /absolute/path/to/pi-extensions/packages/pi-codex-subagents
```

## Tools

| Tool | Purpose |
|---|---|
| `spawn_agent` | Spawn a fresh-context child Pi process |
| `wait_agent` | Wait up to a chosen duration for one completion |
| `wait_all_agents` | Wait up to a chosen duration for every selected agent |
| `list_agents` | List current-session agents, or explicitly include historical sessions |
| `read_agent_response` | Read an agent's latest final raw text response |
| `send_message` | Steer a running agent or start another turn when settled |
| `interrupt_agent` | Abort the current turn while preserving its session for later messages |

Agent names are unique within their parent session. The same task name can exist safely in different Pi sessions. Read and control tools are always scoped to the current parent session; only `list_agents(include_all: true)` crosses session boundaries, and that view is read-only.

## Bounded waits

Both wait tools use the same duration/message shape as the `sleep` tool: `seconds` and `message` are required, and `targets` is optional. Fractional seconds are allowed; the duration must be finite, positive, and no greater than `2147483.647` seconds (Node's timer limit). The tools block in the foreground, show elapsed/maximum time, and return early on the relevant completion condition.

```typescript
wait_agent({
  seconds: 60,
  message: "Reassess whether the review is ready.",
  targets: ["reviewer"],
});

wait_all_agents({
  seconds: 120,
  message: "Check the completed reviews and decide what to do next.",
  targets: ["reviewer", "editor"],
});
```

A completion returns `timed_out: false` and the final response(s). Reaching the duration returns normally with `timed_out: true`, not a tool error, and includes the supplied message. It never interrupts the child or cancels its work. `wait_all_agents` also returns completed responses and `pending_agents` at expiry; completed responses are consumed once, while pending targets remain available to subsequent waits and automatic completion delivery. `wait_agent` without targets waits for the next completion in the parent session, and `wait_all_agents` without targets selects outstanding agents spawned by this extension instance.

Cancellation or session shutdown still rejects the wait. A timed-out wait is removed from the completion-delivery registry so a later child result is not swallowed. Existing callers must add `seconds` and `message`; there is no implicit or unlimited wait duration. Only wait when the next action genuinely depends on a subagent result and no useful independent work remains.

## Agent templates

Templates are user-defined Markdown files in:

```text
~/.pi/agent/pi-codex-subagents/agents/*.md
```

No templates are installed automatically. Example:

```md
---
name: reviewer
description: Focused read-only code review agent
provider: openai-codex
model: gpt-5.6-sol
thinking: high
tools: read,bash,grep,find,ls
skills: web-investigate
extensions: @scope/pi-extra-tools, ~/.pi/agent/extensions/local-helper.ts
hint: Give this reviewer exact file paths and a narrow scope.
---
You are a focused review subagent. Return concise findings with file paths.
```

`provider` and `model` are an optional pair. When both are present, Pi launches that exact provider/model combination. If either is absent, the child inherits the parent agent's provider and model. `thinking` is also optional and otherwise inherits the parent. Template `tools` override inherited tool names.

`skills` may contain skill names or paths. `extensions` may contain local files/directories or npm package names already installed by Pi. Package names are resolved from project-local packages first and then Pi's global npm directory. Missing packages are never installed automatically.

When a template loads extensions but omits `tools`, the child uses Pi's normal tool activation so tools registered by those extensions are available. Set template `tools` when you want an explicit allowlist. Without configured extensions, omitted template tools inherit the parent's active tool names as before.

Automatic extension, skill, prompt-template, and context-file discovery is disabled in children. `AGENTS.md` and `CLAUDE.md` files are never loaded. Each child replaces Pi's default coding prompt with the contents of `~/.pi/agent/pi-codex-subagents/SYSTEM.md`, while only explicitly configured skills and extensions load. This file is created with a minimal subagent prompt when the extension first loads and can be edited directly. If the inherited parent model comes from an extension-registered provider, add that provider extension to the selected template; otherwise the isolated child cannot resolve the provider.

## Configuration

Optional configuration lives at:

```text
~/.pi/agent/pi-codex-subagents/config.json
```

```json
{
  "storageDir": "~/.local/state/pi-codex-subagents/runs",
  "retentionDays": 7,
  "modelResponseTimeoutMs": 600000,
  "models": ["openai-codex/gpt-5.6-sol", "anthropic/claude-opus-4-6"],
  "modelsFromEnabledModels": true,
  "defaults": {
    "skills": ["web-investigate"],
    "extensions": ["@scope/pi-extra-tools"]
  }
}
```

`storageDir` accepts an absolute path, `~/...`, or a path relative to the package configuration directory. By default runs are stored in `~/.pi/agent/pi-codex-subagents/runs`. `retentionDays` defaults to `7`; expired runs and oversized tool outputs are removed when the extension loads. Set it to `0` to disable automatic cleanup. Runtime sockets remain in the operating system temporary directory and are removed when agents stop.

`modelResponseTimeoutMs` limits one model response, from assistant message start to completion, and defaults to 10 minutes. It does not limit tool execution or the agent's total runtime. A response that keeps streaming forever is failed and its child process is terminated so waiters cannot block indefinitely. Set it to `0` to disable this guard.

`shortcut` optionally binds a key to the subagent browser, for example `"shortcut": "ctrl+shift+a"`. No shortcut is assigned by default; omit it or set it to `""` to leave it unbound. Run `/reload` after changing it.

Configuration is read when agents spawn, while cleanup runs when the extension loads. Restart Pi after changing `storageDir` or `retentionDays` so storage lookup and cleanup use the same configuration throughout the process.

Template skills and extensions override configured defaults. Skills explicitly requested by the parent are added to configured template/default skills. Tool selection belongs to the template or is inherited from the parent. A `model` and `thinking` level requested by the parent override the template and the inherited values, so one task can run on another model without a template.

## Model routing

An allowlist in `config.json` decides whether a parent may request a `model` and a `thinking` level per spawn, and which models it may pick. Both arguments appear together or not at all: an installation that configures nothing keeps routing in templates and inheritance. Two sources may be combined:

- `models` lists exact `provider/model-id` pairs approved for this extension alone, independent of any Pi setting.
- `modelsFromEnabledModels: true` adds the models Pi already scoped for the session, resolved from the `enabledModels` setting and `--models`. Models approved for the installation need no second approval here, and Pi has already expanded globs, preferred aliases over dated versions, and dropped unavailable entries. When Pi has no model scoping configured, this source adds nothing.

The arguments are offered only when at least one allowed model is available, and `model` enumerates exactly those pairs:

| Configuration | Allowed and available | `model` and `thinking` on the tool |
|---|---|---|
| neither key set | — | absent, routing belongs to templates |
| `"modelsFromEnabledModels": true`, Pi scoping unset | — | absent |
| `"modelsFromEnabledModels": true`, Pi scoping set | 2 models | present, `model` lists those 2 pairs |
| `"models": ["typo/xyz"]` | nothing available | absent, entry reported as a notification |
| both keys set | the union, deduplicated | present, `model` lists the union |

The list is resolved when a session starts: `models` entries are filtered to what is currently available, unavailable entries are reported as a warning notification, and the scoped models are merged in. Editing the configuration or the Pi setting takes effect when the next session starts, matching the `storageDir` and `retentionDays` behavior above. If a provider drops out mid-session, `spawn_agent` refuses that model at spawn time instead of serving a stale route.

An allowed model may belong to an extension-registered provider. Route to one only from a template that loads that provider extension, since children load none of their own.

A thinking level written into an `enabledModels` pattern, such as `anthropic/claude-opus-4-6:high`, is ignored here. `thinking` stays a separate argument, and the child clamps it to what its model supports.

## Completion delivery

A child completion or failure is delivered automatically to its parent session after the child reaches final status. If the parent is active, the result joins the current run; if the parent is idle, it starts a continuation turn. Continue independent work instead of waiting. Use `wait_agent` or `wait_all_agents` only when the next action depends on those responses and no useful work remains meanwhile; an active wait receives the result directly without a duplicate automatic message.

## Visible message exchanges

Lead-to-child messages are the `message` arguments of `spawn_agent` (initial assignment) and `send_message` (steering or a new turn). Child-to-lead automatic completions are Pi custom messages of type `pi-codex-subagent-completion`, delivered as steering with `triggerTurn: true`; they are not ordinary user messages. If a wait tool claims a completion, the child response instead appears in that tool's result, without an additional automatic notification.

The normal transcript shows the actual assignment/steering text under a bold `spawn_agent` or `send_message` label followed by just the task name. Successful `send_message` calls have no redundant acknowledgement line; execution errors remain visible. Replies appear once in separate neutral cards labelled only with the task name and status, using the same padding and success/error backgrounds as Pi's results—not a fake `subagent_result` tool label. Wait rows show only elapsed/maximum time, targets, and a timeout marker when needed, without repeating the caller's message, completion summary, or child reply. `read_agent_response` still shows the requested response in its own tool result. Collapsed views preview up to eight rendered body lines and 2,000 characters; expand tool output (Ctrl+O by default, configurable as `app.tools.expand`) to read the full message within the standard output limits. Oversized responses retain a full-output file notice and readable bounded display text even when their model-facing JSON has been truncated. Saved ordinary completion messages from earlier versions also render as readable text rather than XML/JSON wrappers.

Reply cards are persistent UI-only custom entries (`pi-codex-subagent-reply`), excluded from model context. A completion observer records them independently of model delivery, so active waits also get a separate card. Stable identities include the child and turn generation; repeated waits do not redisplay a reply, while identical replies in different turns remain distinct. Unclaimed model notifications retain their content/routing but use `display: false`, so they do not create a second visible copy. Wait tools still return final responses to the model and suppress duplicate automatic model delivery. Elapsed time is restored from persisted execution details in the same render frame and remains fixed across redraw, expansion, and reload; it is not restarted when the finished row is rebuilt. Older wait replies without a separate card remain inspectable only on explicit expansion. No fake tool calls/results or additional model turns are created. Only final responses/failures are exchanged automatically; inspect `/subagents` to see a child's intermediate tools, thinking, or streamed progress. Reload the extension while children are idle, or start a fresh parent session, to install the updated renderers.

## Commands and TUI

While agents are starting or running, a compact one-line indicator appears above the editor. It shows the task name for one active agent or a count for multiple agents and points to `/subagents`. The indicator disappears when no agents are active.

`/subagents` opens the agent browser for the current session. Each row shows the task name, status, elapsed time, model, and thinking level, with the task preview underneath. Long names are shortened to fit the terminal. Press Tab to switch to the read-only all-sessions view, then Enter to open an agent.

The browser loads one metadata snapshot when opened. Navigation, redraws, and terminal resizing reuse that snapshot without reading historical agent files again. Press `r` to refresh statuses and discover newly created agents; switching between this-session and all-sessions views also reloads the snapshot.

The overlay uses the child working directory for tool rendering and synchronizes in-progress output when opened midway through a run. Use Left/Right to switch between agents in the current browser scope.

Child RPC processes are terminated after completion, failure, or interruption so settled agents do not keep consuming memory. `send_message` starts a fresh child process with the persisted session and continues from there. On startup, the extension also reconciles and terminates validated owned children left behind by an earlier extension process.

## Output limits

Automatic completions, wait tools, and response tools follow Pi's standard 50 KB / 2,000-line output limit. Oversized output is truncated and the complete text is written beside the runtime data; the returned notice includes a path that can be read with Pi's `read` tool.

## Environment

`PI_SUBAGENT_PI_BIN` overrides the Pi executable used for child processes. Normally children use the same Pi installation as the parent.

## Tests

Run the package regression suite with Bun and explicit test-only storage. The environment variables must be set before loading any test file, because modules imported by other tests may be cached before `core.test.ts` installs its mocks. The core harness rejects a non-isolated storage root rather than touching normal agent runs.

```sh
PI_CODING_AGENT_DIR=/tmp/pi-codex-subagents-tests \
PI_SUBAGENT_TEMP_DIR=/tmp/pi-codex-subagents-tests/temp \
bun test packages/pi-codex-subagents/{core,peek,picker,wait,transcript}.test.ts
```

## License

MIT
