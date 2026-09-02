import { emptyTurnPlan, type TurnPlan } from "./contracts";

export type CoastCommand = "forget_me" | "help" | "start" | "stop";

export interface CoastCommandResult {
  command: CoastCommand;
  plan: TurnPlan;
  requiresLifecycleMutation: boolean;
}

function normalizeCommand(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z\s]/gu, "")
    .replace(/\s+/gu, " ");
}

export function classifyCoastCommand(value: string): CoastCommand | null {
  switch (normalizeCommand(value)) {
    case "HELP":
      return "help";
    case "STOP":
      return "stop";
    case "START":
      return "start";
    case "FORGET ME":
      return "forget_me";
    default:
      return null;
  }
}

export function buildCommandResult(command: CoastCommand): CoastCommandResult {
  switch (command) {
    case "help":
      return {
        command,
        requiresLifecycleMutation: false,
        plan: emptyTurnPlan(
          "I’m COAST, your unofficial mayor of SF. Tell me your mood, neighborhood, timing, and budget; I’ll pull a source-backed move from the city guide. Text STOP to pause or FORGET ME to erase your saved history.",
        ),
      };
    case "stop":
      return {
        command,
        requiresLifecycleMutation: true,
        plan: emptyTurnPlan(
          "You’re paused. I won’t send concierge replies until you text START.",
        ),
      };
    case "start":
      return {
        command,
        requiresLifecycleMutation: true,
        plan: emptyTurnPlan(
          "COAST is back on. Tell me what kind of SF move you’re looking for.",
        ),
      };
    case "forget_me":
      return {
        command,
        requiresLifecycleMutation: true,
        plan: emptyTurnPlan(
          "Got it. Your saved preferences and conversation history will be removed.",
        ),
      };
  }
}
