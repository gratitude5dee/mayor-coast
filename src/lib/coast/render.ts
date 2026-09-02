import {
  containsDestinationUrl,
  isExperienceEligible,
  type ExperienceRecord,
  type TurnPlan,
} from "./contracts";
import {
  buildExperiencePresentation,
  oneLine,
  type ExperiencePresentation,
} from "./presentation";

export interface RenderedCoastMessages {
  presentations: ExperiencePresentation[];
  response: string;
  results?: string;
}

export function renderCoastMessages(
  plan: TurnPlan,
  experiences: readonly ExperienceRecord[],
  nowMs = Date.now(),
): RenderedCoastMessages {
  if (containsDestinationUrl(plan.responseText)) {
    throw new Error("TurnPlan responseText must not contain a destination URL");
  }

  const byExternalId = new Map(
    experiences
      .filter((experience) => isExperienceEligible(experience, nowMs))
      .map((experience) => [experience.externalId, experience] as const),
  );

  const seen = new Set<string>();
  const presentations: ExperiencePresentation[] = [];

  for (const externalId of plan.selectedExternalIds) {
    if (seen.has(externalId) || presentations.length >= 5) {
      continue;
    }
    seen.add(externalId);

    const experience = byExternalId.get(externalId);
    if (!experience) {
      continue;
    }

    const presentation = buildExperiencePresentation({
      canonicalUrl: experience.canonicalUrl,
      endAtMs: experience.endAtMs ?? null,
      entityType: experience.entityType,
      externalId: experience.externalId,
      imageUrl: experience.imageUrl ?? null,
      neighborhoodId: experience.timingLabel,
      observedSummary: experience.observedSummary,
      startAtMs: experience.startAtMs ?? null,
      title: experience.title,
    });
    if (presentation) presentations.push(presentation);
  }

  const fallback = presentations.map((presentation) =>
    `${presentation.title} — ${presentation.canonicalUrl}\n${presentation.description}`,
  );

  return {
    presentations,
    response: oneLine(plan.responseText, 480),
    ...(fallback.length > 0 ? { results: fallback.join("\n\n") } : {}),
  };
}
