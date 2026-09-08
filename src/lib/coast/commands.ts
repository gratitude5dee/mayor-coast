import { emptyTurnPlan, type TurnPlan } from "./contracts";
import {
  parseCreativeCommand,
  type CreativeCommand,
} from "../creative";

export type CoastCommand =
  | "forget_me"
  | "help"
  | "start"
  | "stop"
  | "credits"
  | "topup"
  | "disconnect_link";

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
    case "CREDITS":
      return "credits";
    case "TOPUP":
    case "TOP UP":
      return "topup";
    case "DISCONNECT LINK":
      return "disconnect_link";
    default:
      return null;
  }
}

/** Creative commands are parsed separately so they never enter concierge intent routing. */
export function classifyCreativeCommand(value: string): CreativeCommand | null {
  return parseCreativeCommand(value);
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
    case "credits":
      return {
        command,
        requiresLifecycleMutation: false,
        plan: emptyTurnPlan(
          "Free allowance: 10 images and 10 videos per rolling 24 hours. Purchased credit is used after the free allowance and carries forward.",
        ),
      };
    case "topup":
      return {
        command,
        requiresLifecycleMutation: false,
        plan: emptyTurnPlan(
          "Top-ups add $10 of generation credit for $9.99. Connect Link for approval, or use the secure Checkout link I’ll send when payment is available.",
        ),
      };
    case "disconnect_link":
      return {
        command,
        requiresLifecycleMutation: true,
        plan: emptyTurnPlan("Your Link wallet is disconnected from COAST."),
      };
  }
}
