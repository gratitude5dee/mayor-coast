import type { CoastCommand } from "../coast/commands";
import type { TurnPlan } from "../coast/contracts";

type HistoryMessage = {
  direction: "inbound" | "outbound";
  body: string;
};

export interface ConversationRecoveryInput {
  plan: TurnPlan;
  command: CoastCommand | null;
  latestMessage: string;
  recentMessages: readonly HistoryMessage[];
  clarificationDepth?: number;
  suppressRecovery?: boolean;
}

type RecoveryPoll = NonNullable<TurnPlan["poll"]>;

const FOOD_OPTIONS = [
  "Casual bite",
  "Date-night dinner",
  "Great noodles",
  "Tacos or burritos",
  "Vegetarian-friendly",
  "Surprise me",
] as const;

const DRINK_OPTIONS = ["Cocktails", "Wine bar", "Beer & casual", "Surprise me"] as const;

const NIGHT_OPTIONS = ["Live music", "Comedy", "Dance & DJ", "Surprise me"] as const;

const NEIGHBORHOOD_OPTIONS = [
  "Mission",
  "North Beach",
  "Hayes Valley",
  "SoMa",
  "No preference",
] as const;

function normalize(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function recentInboundContext(
  latestMessage: string,
  recentMessages: readonly HistoryMessage[],
): string {
  const previousInbound = recentMessages
    .filter((message) => message.direction === "inbound")
    .slice(-3)
    .map((message) => message.body);
  return normalize([...previousInbound, latestMessage].join(" "));
}

function poll(question: string, options: readonly string[]): RecoveryPoll {
  return { question, options: [...options], multiple: false };
}

function isGreeting(value: string): boolean {
  return /^(?:hi|hey|hello|sup|yo|howdy|what'?s up)\b/iu.test(value);
}

/**
 * The model remains responsible for source-backed recommendations. This layer is
 * deliberately narrow: when there are no selected experiences and it would
 * otherwise leave the person at a conversational fork, make that fork native.
 */
export function withNativeChoiceRecovery(
  input: ConversationRecoveryInput,
): TurnPlan {
  const { plan } = input;
  if ((input.clarificationDepth ?? 0) >= 2) {
    if (plan.poll === null) return plan;
    return {
      ...plan,
      poll: null,
      responseText:
        plan.selectedExternalIds.length > 0
          ? plan.responseText
          : "I widened the verified search and didn’t find a clean match in this snapshot.",
    };
  }
  if (
    input.suppressRecovery ||
    input.command !== null ||
    plan.poll !== null ||
    plan.selectedExternalIds.length > 0
  ) {
    return plan;
  }

  const latest = normalize(input.latestMessage);
  const context = recentInboundContext(input.latestMessage, input.recentMessages);

  if (isGreeting(latest)) {
    return {
      ...plan,
      responseText: "COAST is on. What’s the move tonight?",
      poll: poll("What are we getting into?", [
        "Food",
        "Drinks",
        "Something to do",
        "Pick for me",
      ]),
    };
  }

  if (
    /\b(?:food|eat|meal|dinner|lunch|brunch|restaurant|pizza|taco|burrito|noodle|burger|sushi|ramen|vegetarian|vegan)\b/iu.test(
      context,
    )
  ) {
    return {
      ...plan,
      responseText: "Nice. What kind of food mood are we chasing?",
      poll: poll("Pick your food lane.", FOOD_OPTIONS),
    };
  }

  if (
    /\b(?:drink|bar|cocktail|wine|beer|brewery|happy hour|mocktail)\b/iu.test(
      context,
    )
  ) {
    return {
      ...plan,
      responseText: "Say less—what kind of drink move are you after?",
      poll: poll("Pick your bar lane.", DRINK_OPTIONS),
    };
  }

  if (
    /\b(?:event|concert|show|party|music|comedy|dj|dance|nightlife)\b/iu.test(
      context,
    )
  ) {
    return {
      ...plan,
      responseText: "What kind of night are we building?",
      poll: poll("Pick the energy.", NIGHT_OPTIONS),
    };
  }

  return {
    ...plan,
    responseText: "I can lock this in fast. Which part of SF should I hunt?",
    poll: poll("Pick a neighborhood.", NEIGHBORHOOD_OPTIONS),
  };
}
