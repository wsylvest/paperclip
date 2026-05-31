// Kimi Code CLI contract (as of 2026-05-30, verified from kimi.ai/code/docs):
//
// Headless invocation:
//   kimi --print -                  -- reads prompt from stdin, auto-exits, headless/yolo mode
//   kimi --print -p "<prompt>"      -- inline prompt
//
// --print flag: auto-exits after task, implicitly enables unattended mode
//   (analogous to claude's --dangerously-skip-permissions in headless use).
//
// Streaming output: --output-format stream-json  (JSONL, same "Message format" as Claude Code)
// Model selection:  --model <id>
// Session resume:   -r <sessionId>  (also: --resume <sessionId>)
//
// MCP config: ~/.kimi/mcp.json (same JSON shape as Claude Code's .mcp.json)
//
// --allowedTools: NOT confirmed in public Kimi docs as of 2026-05-30.
// Per-tool MCP narrowing is therefore handled exclusively by the gateway's
// skill-selection enforcement (commit 492e9e88). The skillSelection.selectedMcpTools
// field is still passed to the onMeta log for observability but is NOT forwarded
// as a CLI flag. If Kimi adds --allowedTools in a future release, update
// buildKimiArgs and this comment.

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  overrideAdapterExecutionTargetRemoteCwd,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  applyPaperclipWorkspaceEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  renderTemplate,
  renderPaperclipWakePrompt,
  refreshPaperclipWorkspaceEnvForExecution,
  rewriteWorkspaceCwdEnvVarsForExecution,
  shapePaperclipWorkspaceEnvForExecution,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensurePaperclipSkillSymlink,
  resolvePaperclipInstanceRootForAdapter,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseKimiStreamJson,
  describeKimiFailure,
  detectKimiLoginRequired,
  isKimiMaxTurnsResult,
  isKimiTransientUpstreamError,
  isKimiUnknownSessionError,
} from "./parse.js";
import { prepareMcpConfig } from "./mcp-config.js";
import { resolveKimiDesiredSkillNames } from "./skills.js";
import { SANDBOX_INSTALL_COMMAND, DEFAULT_KIMI_LOCAL_MODEL } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Kimi prompt bundle
//
// Kimi Code reads --add-dir from the CLI and uses the same .claude/skills
// discovery path as Claude Code. We maintain a content-addressed bundle in
// the Paperclip instance root so repeated runs with the same skills reuse the
// same on-disk directory rather than copying on every heartbeat.
// ---------------------------------------------------------------------------

interface KimiPromptBundle {
  bundleKey: string;
  addDir: string;
}

function resolveKimiPromptCacheRoot(companyId: string): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: process.env.PAPERCLIP_HOME?.trim() || undefined,
    instanceId: process.env.PAPERCLIP_INSTANCE_ID?.trim() || undefined,
    env: process.env,
  });
  return path.resolve(instanceRoot, "companies", companyId, "kimi-prompt-cache");
}

async function prepareKimiPromptBundle(input: {
  companyId: string;
  skills: PaperclipSkillEntry[];
  onLog: AdapterExecutionContext["onLog"];
}): Promise<KimiPromptBundle> {
  const { companyId, skills, onLog } = input;

  // Use a simple deterministic key: sorted skill keys + their source paths.
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  for (const s of [...skills].sort((a, b) => a.key.localeCompare(b.key))) {
    hash.update(`${s.key}:${s.source}:`);
  }
  const bundleKey = hash.digest("hex").slice(0, 16);

  const rootDir = path.join(resolveKimiPromptCacheRoot(companyId), bundleKey);
  const skillsHome = path.join(rootDir, ".claude", "skills");
  const fsModule = await import("node:fs/promises");
  await fsModule.mkdir(skillsHome, { recursive: true });

  for (const entry of skills) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      await ensurePaperclipSkillSymlink(entry.source, target);
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to materialize Kimi skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return { bundleKey, addDir: rootDir };
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveKimiBillingType(env: Record<string, string>): "api" | "subscription" {
  return hasNonEmptyEnvValue(env, "MOONSHOT_API_KEY") || hasNonEmptyEnvValue(env, "KIMI_API_KEY")
    ? "api"
    : "subscription";
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const {
    runId,
    agent,
    runtime,
    config,
    context,
    onLog,
    onMeta,
    onSpawn,
    authToken,
    mintMcpSessionKey,
    paperclipBaseUrl,
  } = ctx;

  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const command = asString(config.command, "kimi");
  const model = asString(config.model, DEFAULT_KIMI_LOCAL_MODEL).trim();
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const configEnv = parseObject(config.env);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceBranch = asString(workspaceContext.branchName, "") || null;
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "") || null;
  const agentHome = asString(workspaceContext.agentHome, "") || null;
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(context.paperclipRuntimeServiceIntents)
    ? context.paperclipRuntimeServiceIntents.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.paperclipRuntimeServices)
    ? context.paperclipRuntimeServices.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.paperclipRuntimePrimaryUrl, "");

  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);

  const shapedWorkspaceEnv = shapePaperclipWorkspaceEnvForExecution({
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceWorktreePath,
    workspaceHints,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });

  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const hasExplicitApiKey =
    typeof configEnv.PAPERCLIP_API_KEY === "string" && configEnv.PAPERCLIP_API_KEY.trim().length > 0;

  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;

  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: shapedWorkspaceEnv.workspaceCwd,
    workspaceSource,
    workspaceStrategy,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch,
    workspaceWorktreePath: shapedWorkspaceEnv.workspaceWorktreePath,
    agentHome,
  });
  if (shapedWorkspaceEnv.workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(shapedWorkspaceEnv.workspaceHints);
  }
  if (runtimeServiceIntents.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
  }
  if (runtimeServices.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
  }
  if (runtimePrimaryUrl) {
    env.PAPERCLIP_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;
  }

  const shapedEnvConfig = rewriteWorkspaceCwdEnvVarsForExecution({
    env: configEnv,
    workspaceCwd: effectiveWorkspaceCwd,
    executionCwd: shapedWorkspaceEnv.workspaceCwd,
    executionTargetIsRemote,
  });
  for (const [key, value] of Object.entries(shapedEnvConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
    executionTarget,
    asNumber(config.timeoutSec, 0),
  );
  const graceSec = asNumber(config.graceSec, 20);

  await ensureAdapterExecutionTargetRuntimeCommandInstalled({
    runId,
    target: executionTarget,
    installCommand: ctx.runtimeCommandSpec?.installCommand,
    detectCommand: ctx.runtimeCommandSpec?.detectCommand,
    cwd,
    env: runtimeEnv,
    timeoutSec,
    graceSec,
    onLog,
  });
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
    installCommand: SANDBOX_INSTALL_COMMAND,
    timeoutSec,
  });
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(
    command,
    executionTarget,
    cwd,
    runtimeEnv,
  );
  let loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveKimiBillingType(effectiveEnv);

  // Skills: Kimi uses the same --add-dir mechanism as Claude Code (Claude-Code-compatible).
  const kimiSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  let desiredSkillNames = new Set(resolveKimiDesiredSkillNames(config, kimiSkillEntries));

  // Skill-selection narrowing: when the analyzer ran and selected a subset of
  // skills for this task, intersect with that subset. Null = no analyzer ran.
  if (ctx.skillSelection != null) {
    const selected = new Set(ctx.skillSelection.selectedSkills);
    const before = desiredSkillNames.size;
    desiredSkillNames = new Set([...desiredSkillNames].filter((k) => selected.has(k)));
    await onLog(
      "stdout",
      `[paperclip] Kimi skill narrowing: ${before} → ${desiredSkillNames.size} skill(s) after analyzer selection (${ctx.skillSelection.rationale}).\n`,
    );
    // NOTE: MCP tool narrowing via --allowedTools is NOT applied here because
    // Kimi's --allowedTools flag is unconfirmed as of 2026-05-30.
    // The gateway enforces skill-selection via server-side enforcement (commit 492e9e88).
    if (ctx.skillSelection.selectedMcpTools && ctx.skillSelection.selectedMcpTools.length > 0) {
      await onLog(
        "stdout",
        `[paperclip] Kimi MCP tool narrowing: ${ctx.skillSelection.selectedMcpTools.length} tool(s) selected by analyzer; enforced via gateway (kimi_local does not support --allowedTools as of 2026-05-30).\n`,
      );
    }
  }

  const promptBundle = await prepareKimiPromptBundle({
    companyId: agent.companyId,
    skills: kimiSkillEntries.filter((entry) => desiredSkillNames.has(entry.key)),
    onLog,
  });

  // Materialise .mcp.json so Kimi connects to the Paperclip MCP gateway.
  const preparedMcpConfig =
    mintMcpSessionKey && paperclipBaseUrl
      ? await prepareMcpConfig({
          seedDir: null,
          workspaceCwd: cwd,
          companyId: agent.companyId,
          agentId: agent.id,
          runId,
          paperclipBaseUrl,
          mintKey: mintMcpSessionKey,
          onLog,
        })
      : null;

  const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(
    executionTarget,
    effectiveExecutionCwd,
  );

  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig: configEnv,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceStrategy,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch,
    workspaceWorktreePath,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
    adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
  const sessionId = canResumeSession ? runtimeSessionId : null;

  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Kimi session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
    );
  }

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const taskContextNote = asString(context.paperclipTaskMarkdown, "").trim();
  const prompt = joinPromptSections([
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    taskContextChars: taskContextNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  // Build the Kimi CLI args for a run attempt.
  // Verified flags: --print, -, --output-format stream-json, --model, -r (resume).
  // --add-dir: assumed supported since Kimi is Claude-Code-compatible; if not
  //   supported, remove it and use a different skill injection mechanism.
  const buildKimiArgs = (resumeSessionId: string | null) => {
    const args = ["--print", "-", "--output-format", "stream-json"];
    if (resumeSessionId) args.push("-r", resumeSessionId);
    if (model) args.push("--model", model);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    // --add-dir: stages the Paperclip skill bundle into Kimi's context.
    // ASSUMPTION: Kimi supports --add-dir (inherited from Claude Code compatibility).
    // If this flag is rejected, remove it and note the gap.
    args.push("--add-dir", promptBundle.addDir);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const parseFallbackErrorMessage = (proc: RunProcessResult) => {
    const stderrLine =
      proc.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";

    if ((proc.exitCode ?? 0) === 0) {
      return "Failed to parse Kimi JSON output";
    }

    return stderrLine
      ? `Kimi exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
      : `Kimi exited with code ${proc.exitCode ?? -1}`;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildKimiArgs(resumeSessionId);
    const commandNotes: string[] = [];
    if (!resumeSessionId) {
      commandNotes.push(`Using stable Kimi prompt bundle ${promptBundle.bundleKey}.`);
    }
    if (preparedMcpConfig) {
      commandNotes.push(`MCP gateway configured at ${preparedMcpConfig.projectFilePath}.`);
    }

    if (onMeta) {
      await onMeta({
        adapterType: "kimi_local",
        command: resolvedCommand,
        cwd: effectiveExecutionCwd,
        commandArgs: args,
        commandNotes,
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog,
      terminalResultCleanup: {
        graceMs: Math.max(0, asNumber(config.terminalResultCleanupGraceMs, 5_000)),
        hasTerminalResult: ({ stdout }) => parseKimiStreamJson(stdout).resultJson !== null,
      },
    });

    const parsedStream = parseKimiStreamJson(proc.stdout);
    const parsed = parsedStream.resultJson;
    return { proc, parsedStream, parsed };
  };

  const toAdapterResult = (
    attempt: {
      proc: RunProcessResult;
      parsedStream: ReturnType<typeof parseKimiStreamJson>;
      parsed: Record<string, unknown> | null;
    },
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ): AdapterExecutionResult => {
    const { proc, parsedStream, parsed } = attempt;
    const loginMeta = detectKimiLoginRequired({
      parsed,
      stdout: proc.stdout,
      stderr: proc.stderr,
    });
    const errorMeta =
      loginMeta.loginUrl != null ? { loginUrl: loginMeta.loginUrl } : undefined;

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        errorMeta,
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    if (!parsed) {
      const fallbackErrorMessage = parseFallbackErrorMessage(proc);
      const transientUpstream =
        !loginMeta.requiresLogin &&
        (proc.exitCode ?? 0) !== 0 &&
        isKimiTransientUpstreamError({
          parsed: null,
          stdout: proc.stdout,
          stderr: proc.stderr,
          errorMessage: fallbackErrorMessage,
        });
      const errorCode = loginMeta.requiresLogin
        ? "kimi_auth_required"
        : transientUpstream
        ? "kimi_transient_upstream"
        : null;
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: fallbackErrorMessage,
        errorCode,
        errorFamily: transientUpstream ? "transient_upstream" : null,
        errorMeta,
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
          ...(transientUpstream ? { errorFamily: "transient_upstream" } : {}),
        },
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    const usage =
      parsedStream.usage ??
      (() => {
        const usageObj = parseObject(parsed.usage);
        return {
          inputTokens: asNumber(usageObj.input_tokens, 0),
          cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
          outputTokens: asNumber(usageObj.output_tokens, 0),
        };
      })();

    const resolvedSessionId =
      parsedStream.sessionId ??
      (asString(parsed.session_id, opts.fallbackSessionId ?? "") || opts.fallbackSessionId);
    const resolvedSessionParams = resolvedSessionId
      ? ({
          sessionId: resolvedSessionId,
          cwd,
          ...(executionTargetIsRemote
            ? { remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget) }
            : {}),
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
        } as Record<string, unknown>)
      : null;

    const clearSessionForMaxTurns = isKimiMaxTurnsResult(parsed);
    const parsedIsError = parsed.is_error === true;
    const failed = (proc.exitCode ?? 0) !== 0 || parsedIsError;
    const errorMessage = failed
      ? describeKimiFailure(parsed) ?? `Kimi exited with code ${proc.exitCode ?? -1}`
      : null;
    const transientUpstream =
      failed &&
      !loginMeta.requiresLogin &&
      !clearSessionForMaxTurns &&
      isKimiTransientUpstreamError({ parsed, stdout: proc.stdout, stderr: proc.stderr, errorMessage });
    const resolvedErrorCode = loginMeta.requiresLogin
      ? "kimi_auth_required"
      : failed && clearSessionForMaxTurns
      ? "max_turns_exhausted"
      : transientUpstream
      ? "kimi_transient_upstream"
      : null;

    const mergedResultJson: Record<string, unknown> = {
      ...parsed,
      ...(failed && clearSessionForMaxTurns ? { stopReason: "max_turns_exhausted" } : {}),
      ...(transientUpstream ? { errorFamily: "transient_upstream" } : {}),
    };

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage,
      errorCode: resolvedErrorCode,
      errorFamily: transientUpstream ? "transient_upstream" : null,
      errorMeta,
      usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "moonshot",
      biller: "moonshot",
      model: parsedStream.model || asString(parsed.model, model),
      billingType,
      costUsd: parsedStream.costUsd ?? asNumber(parsed.total_cost_usd, 0),
      resultJson: mergedResultJson,
      summary: parsedStream.summary || asString(parsed.result, ""),
      clearSession:
        clearSessionForMaxTurns || Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  const initial = await runAttempt(sessionId ?? null);
  if (
    sessionId &&
    !initial.proc.timedOut &&
    (initial.proc.exitCode ?? 0) !== 0 &&
    initial.parsed &&
    isKimiUnknownSessionError(initial.parsed)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Kimi resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });
  }

  return toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
}
