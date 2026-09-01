export const LUNA_MODEL = "gpt-5.6-luna" as const;
export const TERRA_MODEL = "gpt-5.6-terra" as const;

export type CoastModel = typeof LUNA_MODEL | typeof TERRA_MODEL;
export type ModelRouteReason =
  | "default_luna"
  | "failed_luna_structured_output"
  | "itinerary_intent"
  | "three_or_more_constraints"
  | "weak_retrieval";

export interface ModelRoute {
  model: CoastModel;
  reasons: readonly ModelRouteReason[];
  constraintCount: number;
}

const CONSTRAINT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["neighborhood", /\b(?:mission|soma|hayes valley|marina|north beach|richmond|sunset|castro|dogpatch|noe valley|nob hill|potrero|chinatown|tenderloin|fillmore|embarcadero)\b/iu],
  ["price", /(?:\$|\b(?:free|cheap|budget|under|less than|splurge|upscale|price)\b)/iu],
  ["time", /\b(?:tonight|tomorrow|weekend|weekday|morning|afternoon|evening|late[- ]night|after \d|before \d|at \d|september)\b/iu],
  ["food", /\b(?:asian|burgers?|middle eastern|mexican|italian|japanese|chinese|thai|indian|korean|pizza|seafood|vegan|vegetarian|gluten[- ]free|cuisine|dinner|brunch)\b/iu],
  ["drink", /\b(?:cocktails?|wine|beer|mocktails?|sake|drinks?|bar)\b/iu],
  ["format", /\b(?:concert|live music|dj|dance|comedy|festival|workshop|event|restaurant|nightclub|cafe)\b/iu],
  ["occasion", /\b(?:date night|birthday|anniversary|group|solo|client|family|friends?)\b/iu],
  ["vibe", /\b(?:intimate|lively|romantic|casual|quiet|rowdy|chill|fancy|cozy|outdoor)\b/iu],
  ["access", /\b(?:accessible|wheelchair|outdoor|indoors?|reservations?|walk[- ]in|all ages|21\+)\b/iu],
];

const ITINERARY_PATTERN = /\b(?:itinerary|plan (?:my|our|a|the) (?:day|date|evening|night|weekend)|whole night|full night|bar crawl|food crawl|progressive dinner|multi[- ]stop|sequence (?:the|our|these)|route (?:me|us|the night|our night))\b/iu;
const LEGACY_SAVED_PREFERENCE_CONSTRAINT =
  /^(?:preference|saved[-_ ]?preference):/iu;

export function countConstraints(
  message: string,
  explicitConstraints: readonly string[] = [],
): number {
  const constraintKinds = new Set(
    explicitConstraints
      .map((value) => value.trim().toLowerCase())
      .filter(
        (value) =>
          value.length > 0 && !LEGACY_SAVED_PREFERENCE_CONSTRAINT.test(value),
      ),
  );
  for (const [kind, pattern] of CONSTRAINT_PATTERNS) {
    if (pattern.test(message)) {
      constraintKinds.add(kind);
    }
  }
  return constraintKinds.size;
}

export function hasItineraryIntent(message: string): boolean {
  return ITINERARY_PATTERN.test(message);
}

export function selectInitialModel(input: {
  message: string;
  explicitConstraints?: readonly string[];
  retrievalQuality?: "strong" | "unknown" | "weak";
}): ModelRoute {
  const constraintCount = countConstraints(
    input.message,
    input.explicitConstraints,
  );
  const reasons: ModelRouteReason[] = [];

  if (hasItineraryIntent(input.message)) {
    reasons.push("itinerary_intent");
  }
  if (constraintCount >= 3) {
    reasons.push("three_or_more_constraints");
  }
  if (input.retrievalQuality === "weak") {
    reasons.push("weak_retrieval");
  }

  return {
    model: reasons.length > 0 ? TERRA_MODEL : LUNA_MODEL,
    reasons: reasons.length > 0 ? reasons : ["default_luna"],
    constraintCount,
  };
}

export function escalateRoute(
  route: ModelRoute,
  reason: Exclude<ModelRouteReason, "default_luna">,
): ModelRoute {
  const reasons = route.reasons.filter((item) => item !== "default_luna");
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
  return { ...route, model: TERRA_MODEL, reasons };
}
