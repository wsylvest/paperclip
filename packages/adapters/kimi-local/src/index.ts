export const type = "kimi_local";
export const label = "Kimi Code (local)";

// Default install command for Kimi Code CLI.
// NOTE: The actual npm package name is not publicly confirmed as of 2026-05-30.
// Using the documented install path from Moonshot AI's Kimi Code docs.
// VERIFY at https://kimi.ai/code/docs before production use.
export const SANDBOX_INSTALL_COMMAND = "npm install -g kimi-code";

export const DEFAULT_KIMI_LOCAL_MODEL = "kimi-k2";

export const models = [
  { id: "kimi-k2", label: "Kimi K2" },
  { id: "kimi-k1.5", label: "Kimi K1.5" },
];

export const agentConfigurationDoc = `# kimi_local agent configuration

Adapter: kimi_local

Use when:
- You want Paperclip to run the Kimi Code CLI locally on the host machine
- You want resumable Kimi sessions across heartbeats via \`--resume\`
- Kimi Code CLI is installed and authenticated on the machine running Paperclip

Don't use when:
- You need a webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Kimi CLI is not installed or authenticated on the host

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected at runtime
- model (string, optional): Kimi model id. Defaults to kimi-k2.
- maxTurnsPerRun (number, optional): max turns for one run
- command (string, optional): defaults to "kimi"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use \`kimi --print\` with \`--output-format stream-json\`. The \`--print\` flag
  auto-exits after the task and implicitly enables headless/yolo mode (no interactive
  permission prompts).
- Sessions resume with \`-r <sessionId>\` when the saved session cwd matches the current cwd.
- MCP gateway is configured via ~/.kimi/mcp.json (same JSON shape as Claude Code's .mcp.json).
- Kimi's --allowedTools flag is not confirmed in the public docs as of 2026-05-30.
  Per-tool MCP narrowing falls back to server-side gateway enforcement (commit 492e9e88).
`;
