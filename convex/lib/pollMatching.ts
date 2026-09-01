export type PendingPollCandidate = {
  providerPollId?: string;
  question: string;
  options: readonly string[];
};

function normalize(value: string): string {
  return value
    .trim()
    .replace(/\s+·\s+[a-z0-9]{1,12}$/iu, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

export function isSamePollText(left: string, right: string): boolean {
  return normalize(left) === normalize(right);
}

/**
 * A native iMessage poll event is already authenticated by Photon and scoped
 * to one DM before this runs. Prefer its durable poll GUID, but accept the
 * only pending poll with that exact option when Photon exposes a different
 * modal/view identifier on send than it later exposes as the poll GUID.
 *
 * Never guess when more than one pending poll could own the selection.
 */
export function selectPendingPollCandidate<T extends PendingPollCandidate>(input: {
  pending: readonly T[];
  pollTitle: string;
  providerPollId?: string;
  selectedOption: string;
}): T | null {
  const selected = normalize(input.selectedOption);
  const optionMatches = input.pending.filter((candidate) =>
    candidate.options.some((option) => normalize(option) === selected),
  );

  if (input.providerPollId !== undefined) {
    const providerMatch = optionMatches.find(
      (candidate) => candidate.providerPollId === input.providerPollId,
    );
    if (providerMatch !== undefined) return providerMatch;
  }

  const title = normalize(input.pollTitle);
  if (title) {
    const titleMatches = optionMatches.filter(
      (candidate) => normalize(candidate.question) === title,
    );
    if (titleMatches.length === 1) return titleMatches[0] ?? null;
  }

  return optionMatches.length === 1 ? (optionMatches[0] ?? null) : null;
}
