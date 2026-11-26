import type { AgentSlashCommand, AgentSlashCommandKind } from "../../agent-sdk-types.js";
import type { OmpRpcSlashCommand, OmpSlashSubcommand } from "./rpc-types.js";
import { OmpAvailableCommandsUpdateEventSchema, type OmpAvailableCommand } from "./rpc-types.js";

export const OMP_HANDLED_BUILTIN_SLASH_COMMANDS: readonly AgentSlashCommand[] = [
  {
    name: "compact",
    description: "Manually compact the session context",
    argumentHint: "[instructions]",
    kind: "command",
  },
  {
    name: "autocompact",
    description: "Toggle automatic context compaction",
    argumentHint: "[on|off|toggle]",
    kind: "command",
  },
  {
    name: "handoff",
    description: "Hand off from planning to implementation",
    argumentHint: "[instructions]",
    kind: "command",
  },
  {
    name: "steer",
    description: "Steer the active OMP turn",
    argumentHint: "<message>",
    kind: "command",
  },
  {
    name: "follow-up",
    description: "Queue a follow-up message for OMP",
    argumentHint: "<message>",
    kind: "command",
  },
  // RPC-only OMP ops with no OMP slash twin; Paseo intercepts these instead of
  // passing them through as prompt text (see OmpAgentSession.tryHandleOutOfBand).
  {
    name: "goal",
    description: "Set or manage the OMP goal",
    argumentHint: "<objective>|pause|resume|clear|status",
    kind: "command",
  },
  {
    name: "btw",
    description: "Ask a side question while OMP works",
    argumentHint: "<question>",
    kind: "command",
  },
  {
    name: "queue",
    description: "Manage OMP's queued messages",
    argumentHint: "remove <text>|promote <text>|clear",
    kind: "command",
  },
  {
    name: "autoretry",
    description: "Control OMP auto-retry",
    argumentHint: "[on|off|abort]",
    kind: "command",
  },
  {
    name: "fork",
    description: "Fork the OMP session from a message",
    argumentHint: "[entryId]",
    kind: "command",
  },
  {
    name: "export-html",
    description: "Export the OMP session as HTML",
    argumentHint: "[path]",
    kind: "command",
  },
];

export function mapOmpSlashCommands(commands: readonly OmpAvailableCommand[]): AgentSlashCommand[] {
  const mappedCommands = new Map<string, AgentSlashCommand>(
    OMP_HANDLED_BUILTIN_SLASH_COMMANDS.map((command) => [command.name, { ...command }]),
  );
  for (const command of commands) {
    const knownCommand = mappedCommands.get(command.name);
    const subcommands = mapOmpSubcommands(command.subcommands);
    mappedCommands.set(command.name, {
      name: command.name,
      description: command.description ?? command.source ?? "command",
      argumentHint: command.input?.hint ?? knownCommand?.argumentHint ?? "",
      kind: mapOmpCommandKind(command.source),
      ...(subcommands.length > 0 ? { subcommands } : {}),
    });
  }
  return [...mappedCommands.values()];
}

function mapOmpSubcommands(
  subcommands: readonly OmpSlashSubcommand[] | undefined,
): AgentSlashCommand[] {
  return (subcommands ?? []).map((subcommand) => {
    const mappedSubcommands = mapOmpSubcommands(subcommand.subcommands);
    const mapped: AgentSlashCommand = {
      name: subcommand.name,
      description: subcommand.description ?? subcommand.source ?? "command",
      argumentHint: subcommand.input?.hint ?? "",
      kind: mapOmpCommandKind(subcommand.source),
    };
    if (mappedSubcommands.length > 0) {
      mapped.subcommands = mappedSubcommands;
    }
    return mapped;
  });
}

export function mapOmpRuntimeSlashCommands(
  commands: readonly OmpRpcSlashCommand[],
): AgentSlashCommand[] {
  return mapOmpSlashCommands(
    commands.map((command) => ({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
      source: command.source,
      ...(command.input ? { input: command.input } : {}),
      ...(command.subcommands ? { subcommands: command.subcommands } : {}),
    })),
  );
}

export function mapOmpAvailableCommandsUpdate(event: unknown): AgentSlashCommand[] | null {
  const parsed = OmpAvailableCommandsUpdateEventSchema.safeParse(event);
  return parsed.success ? mapOmpSlashCommands(parsed.data.commands) : null;
}

function mapOmpCommandKind(source: string | undefined): AgentSlashCommandKind {
  return source === "skill" ? "skill" : "command";
}
