import { createExternalProcessEnv } from "../../../paseo-env.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";
import { z } from "zod";

import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import {
  JSONL_RPC_NO_TIMEOUT,
  JsonlRpcProcess,
  type JsonlRpcLaunch,
} from "../jsonl-rpc-process.js";
import { establishOmpProtocol } from "./protocol-session.js";
import {
  buildOmpLaunch,
  type OmpRuntime,
  type OmpRuntimeLaunch,
  type OmpRuntimeSession,
  type OmpPromptInput,
  type OmpStartSessionInput,
} from "./runtime.js";
import {
  OmpAbortRestoreQueueResultSchema,
  OmpAutoRetryResultSchema,
  OmpBranchMessagesResultSchema,
  OmpBranchResultSchema,
  OmpBtwCancelResultSchema,
  OmpBtwHistoryResultSchema,
  OmpBtwResultSchema,
  OmpCacheWarmingResultSchema,
  OmpCommandsResultSchema,
  OmpExportHtmlResultSchema,
  type OmpExtensionUiResponse,
  OmpForkResultSchema,
  OmpGoalResultSchema,
  OmpHostToolsResultSchema,
  OmpMessagesResultSchema,
  OmpModelSchema,
  OmpModelsResultSchema,
  OmpPromptAckSchema,
  OmpPromoteQueuedResultSchema,
  OmpRemoveQueuedResultSchema,
  OmpRpcCommandSchema,
  parseOmpRuntimeEvent,
  OmpSessionStateSchema,
  OmpSessionStatsSchema,
  OmpSlowModeResultSchema,
  OmpTodosResultSchema,
  type OmpThinkingLevel,
  type OmpAgentMessage,
  type OmpModel,
  type OmpPromptAck,
  type OmpRpcCommand,
  type OmpRpcHostToolDefinition,
  type OmpRpcHostToolResult,
  type OmpRpcHostToolUpdate,
  type OmpRpcSlashCommand,
  type OmpRuntimeEvent,
  type OmpSessionState,
  type OmpSessionStats,
  type OmpSubagentSubscriptionLevel,
  type OmpTodoPhase,
} from "./rpc-types.js";

const DEFAULT_OMP_COMMAND: [string, ...string[]] = [process.env.OMP_COMMAND ?? "omp"];
const DEFAULT_COMMANDS_RPC_NAME = "get_available_commands";

export interface OmpCliRuntimeOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  command?: [string, ...string[]];
  commandsRpcName?: "get_available_commands";
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  spawnProcess?: (launch: OmpRuntimeLaunch) => ChildProcessWithoutNullStreams;
}

export class OmpCliRuntime implements OmpRuntime {
  private readonly command: [string, ...string[]];
  private readonly commandsRpcName: "get_available_commands";
  private readonly spawnProcess?: (launch: OmpRuntimeLaunch) => ChildProcessWithoutNullStreams;

  constructor(private readonly options: OmpCliRuntimeOptions) {
    this.command = options.command ?? DEFAULT_OMP_COMMAND;
    this.commandsRpcName = options.commandsRpcName ?? DEFAULT_COMMANDS_RPC_NAME;
    this.spawnProcess = options.spawnProcess;
  }

  async startSession(input: OmpStartSessionInput): Promise<OmpRuntimeSession> {
    const launch = buildOmpLaunch({
      command: this.command,
      runtimeSettings: this.options.runtimeSettings,
      session: input,
    });
    launch.env = createExternalProcessEnv(globalThis.process.env, launch.env ?? {});
    const [command, ...args] = launch.argv;
    const processLaunch: JsonlRpcLaunch = {
      command,
      args,
      cwd: launch.cwd,
      env: launch.env,
      wrap: launch.wrap,
    };
    const spawn = this.spawnProcess;
    const processOptions = {
      launch: processLaunch,
      logger: this.options.logger,
      diagnosticName: "OMP RPC",
      defaultRequestTimeoutMs: this.options.requestTimeoutMs,
      ...(spawn ? { spawn: () => spawn(launch) } : {}),
    };
    const process = new JsonlRpcProcess(processOptions);
    const handleAbort = () => void process.close(input.signal?.reason).catch(() => undefined);
    input.signal?.addEventListener("abort", handleAbort, { once: true });
    try {
      await establishOmpProtocol(process, this.options.logger, {
        readyTimeoutMs: this.options.readyTimeoutMs,
        requestTimeoutMs: this.options.requestTimeoutMs,
      });
      input.signal?.throwIfAborted();
      return new OmpCliRuntimeSession(process, this.commandsRpcName, launch.env);
    } catch (error) {
      const startupError = error instanceof Error ? error : new Error(String(error));
      await process.close(startupError);
      throw startupError;
    } finally {
      input.signal?.removeEventListener("abort", handleAbort);
    }
  }
}

class OmpCliRuntimeSession implements OmpRuntimeSession {
  private readonly subscribers = new Set<(event: OmpRuntimeEvent) => void>();
  activeBranchEntryId?: string;

  constructor(
    private readonly process: JsonlRpcProcess,
    private readonly commandsRpcName: "get_available_commands",
    private readonly launchEnvironment: Record<string, string>,
  ) {
    process.onMessage((message) => {
      const event = parseOmpRuntimeEvent(message);
      if (event) {
        this.emit(event);
      }
    });
    process.onExit(({ error }) => {
      this.emit({ type: "process_exit", error: error.message });
    });
  }

  get environment(): Record<string, string> {
    return this.launchEnvironment;
  }

  onEvent(callback: (event: OmpRuntimeEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async prompt({ message, images, streamingBehavior }: OmpPromptInput): Promise<OmpPromptAck> {
    const { id: requestId, promise } = this.process.startRequest({
      type: "prompt",
      message,
      ...(images?.length ? { images } : {}),
      ...(streamingBehavior ? { streamingBehavior: streamingBehavior } : {}),
    });
    const ack = OmpPromptAckSchema.parse(await promise) ?? {};
    return { requestId, ...ack };
  }

  async compact(customInstructions?: string): Promise<void> {
    await this.request(
      {
        type: "compact",
        ...(customInstructions ? { customInstructions } : {}),
      },
      JSONL_RPC_NO_TIMEOUT,
    );
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.request({ type: "set_auto_compaction", enabled });
  }

  async abort(): Promise<void> {
    await this.requestStopWork({ type: "abort" });
  }

  async getState(): Promise<OmpSessionState> {
    return OmpSessionStateSchema.parse(await this.request({ type: "get_state" }));
  }

  async setFastMode(enabled: boolean): Promise<{ enabled: boolean; active: boolean }> {
    const result = await this.request({ type: "set_fast_mode", enabled });
    return z.object({ enabled: z.boolean(), active: z.boolean() }).parse(result);
  }

  async getMessages(): Promise<OmpAgentMessage[]> {
    const data = OmpMessagesResultSchema.parse(await this.request({ type: "get_messages" }));
    return data.messages ?? [];
  }

  async getAvailableModels(timeoutMs?: number | null): Promise<OmpModel[]> {
    const data = OmpModelsResultSchema.parse(
      await this.request({ type: "get_available_models" }, timeoutMs),
    );
    return data.models ?? [];
  }

  async setModel(provider: string, modelId: string): Promise<OmpModel> {
    return OmpModelSchema.parse(await this.request({ type: "set_model", provider, modelId }));
  }

  async setThinkingLevel(level: OmpThinkingLevel): Promise<void> {
    await this.request({ type: "set_thinking_level", level });
  }

  async getSessionStats(): Promise<OmpSessionStats> {
    // COMPAT(ompGetStateFallback): added in v0.1.105 — older OMP binaries
    // lack the `get_session_stats` RPC command; fall back to extracting
    // context window usage from `get_state`. Remove after 2027-01-10 once the
    // supported OMP floor includes `get_session_stats`.
    let stats: OmpSessionStats | undefined;
    try {
      stats = OmpSessionStatsSchema.parse(await this.request({ type: "get_session_stats" }));
    } catch {
      // get_session_stats not supported by this binary — will try get_state below
    }
    if (stats?.tokens == null && stats?.cost == null && stats?.contextUsage == null) {
      try {
        const state = OmpSessionStateSchema.parse(await this.request({ type: "get_state" }));
        const ctx = state.contextUsage;
        if (ctx) {
          return {
            contextUsage: {
              tokens: typeof ctx.tokens === "number" ? ctx.tokens : undefined,
              contextWindow: typeof ctx.contextWindow === "number" ? ctx.contextWindow : undefined,
            },
          };
        }
      } catch {
        // get_state also failed — nothing we can do
      }
    }
    return stats ?? {};
  }

  async getCommands(): Promise<OmpRpcSlashCommand[]> {
    const data = OmpCommandsResultSchema.parse(await this.request({ type: this.commandsRpcName }));
    return data.commands ?? [];
  }

  async setSubagentSubscription(level: OmpSubagentSubscriptionLevel): Promise<void> {
    await this.request({ type: "set_subagent_subscription", level });
  }

  async setHostTools(tools: OmpRpcHostToolDefinition[]): Promise<string[]> {
    const data = OmpHostToolsResultSchema.parse(
      await this.request({ type: "set_host_tools", tools }),
    );
    return data.toolNames ?? [];
  }

  sendHostToolResult(result: OmpRpcHostToolResult): void {
    this.process.send({ ...result });
  }

  sendHostToolUpdate(update: OmpRpcHostToolUpdate): void {
    this.process.send({ ...update });
  }

  async branch(entryId: string): Promise<{ text: string }> {
    const data = OmpBranchResultSchema.parse(await this.request({ type: "branch", entryId }));
    if (data.cancelled === true) {
      throw new Error("OMP branch was cancelled");
    }
    if (typeof data.text !== "string") {
      throw new Error("OMP branch response did not include restored prompt text");
    }
    this.activeBranchEntryId = entryId;
    return { text: data.text };
  }

  async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
    const data = OmpBranchMessagesResultSchema.parse(
      await this.request({ type: "get_branch_messages" }),
    );
    return data.messages ?? [];
  }

  async steer(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void> {
    await this.request({ type: "steer", message, ...(images?.length ? { images } : {}) });
  }

  async handoff(customInstructions?: string): Promise<void> {
    await this.request({
      type: "handoff",
      ...(customInstructions ? { customInstructions } : {}),
    });
  }

  async goal(
    op: "get" | "create" | "resume" | "pause" | "drop",
    objective?: string,
    tokenBudget?: number,
  ) {
    return OmpGoalResultSchema.parse(
      await this.request({
        type: "goal",
        op,
        ...(objective ? { objective } : {}),
        ...(tokenBudget !== undefined ? { token_budget: tokenBudget } : {}),
      }),
    );
  }

  async btw(question: string, recordId?: string) {
    return OmpBtwResultSchema.parse(
      await this.request(
        { type: "btw", question, ...(recordId ? { recordId } : {}) },
        // A btw answer can take as long as the main run does.
        JSONL_RPC_NO_TIMEOUT,
      ),
    );
  }

  async btwCancel(recordId?: string) {
    return OmpBtwCancelResultSchema.parse(
      await this.request({ type: "btw_cancel", ...(recordId ? { recordId } : {}) }),
    );
  }

  async getBtwHistory() {
    return OmpBtwHistoryResultSchema.parse(await this.request({ type: "get_btw_history" }));
  }

  async removeQueuedMessage(message: string, queue: "steering" | "followUp") {
    return OmpRemoveQueuedResultSchema.parse(
      await this.request({ type: "remove_queued_message", message, queue }),
    );
  }

  async promoteQueuedMessage(message: string) {
    return OmpPromoteQueuedResultSchema.parse(
      await this.request({ type: "promote_queued_message", message }),
    );
  }

  async abortAndRestoreQueue() {
    return OmpAbortRestoreQueueResultSchema.parse(
      await this.request({ type: "abort_and_restore_queue" }),
    );
  }

  async setAutoRetry(enabled: boolean) {
    return OmpAutoRetryResultSchema.parse(await this.request({ type: "set_auto_retry", enabled }));
  }

  async abortRetry(): Promise<void> {
    await this.requestStopWork({ type: "abort_retry" });
  }

  async setTodos(phases: OmpTodoPhase[]) {
    return OmpTodosResultSchema.parse(await this.request({ type: "set_todos", phases }));
  }

  bash(command: string, excludeFromContext?: boolean): Promise<unknown> {
    return this.request(
      { type: "bash", command, ...(excludeFromContext ? { excludeFromContext } : {}) },
      // Shell output can stream in after an arbitrarily long run.
      JSONL_RPC_NO_TIMEOUT,
    );
  }

  async abortBash(): Promise<void> {
    await this.requestStopWork({ type: "abort_bash" });
  }

  async setSessionName(name: string): Promise<void> {
    await this.request({ type: "set_session_name", name });
  }

  async forkFrom(entryId?: string) {
    const data = OmpForkResultSchema.parse(
      await this.request({ type: "fork", ...(entryId ? { entryId } : {}) }),
    );
    if (data.cancelled === true) {
      throw new Error("OMP fork was cancelled");
    }
    return data;
  }

  async exportHtml(outputPath?: string) {
    return OmpExportHtmlResultSchema.parse(
      await this.request(
        { type: "export_html", ...(outputPath ? { outputPath } : {}) },
        // Rendering a long session to HTML can take a while.
        JSONL_RPC_NO_TIMEOUT,
      ),
    );
  }

  async setSlowMode(enabled: boolean) {
    return OmpSlowModeResultSchema.parse(await this.request({ type: "set_slow_mode", enabled }));
  }

  async setCacheWarming(mode: "off" | "streaming" | "idle") {
    return OmpCacheWarmingResultSchema.parse(
      await this.request({ type: "set_cache_warming", mode }),
    );
  }

  respondToExtensionUiRequest(id: string, response: OmpExtensionUiResponse): void {
    this.process.send({ type: "extension_ui_response", id, ...response });
  }

  cancelExtensionUiRequest(id: string): void {
    this.respondToExtensionUiRequest(id, { cancelled: true });
  }

  async close(): Promise<void> {
    await this.process.close(new Error("OMP RPC session is closed"));
  }

  private request(command: OmpRpcCommand, timeoutMs?: number | null): Promise<unknown> {
    return this.process.request(OmpRpcCommandSchema.parse(command), timeoutMs);
  }

  private requestStopWork(command: OmpRpcCommand): Promise<void> {
    return this.process.requestStopWork(OmpRpcCommandSchema.parse(command));
  }

  private emit(event: OmpRuntimeEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}
