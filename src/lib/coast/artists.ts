export type CoastArtistShareKind = "direct" | "automatic";

/**
 * Intent is deliberately narrow so ordinary event/music discovery stays on the
 * SF experience corpus. Artist records are selected and linked by the
 * application; neither the model nor a free-form prompt creates a URL.
 */
export function isArtistDiscoveryRequest(value: string): boolean {
  const text = value.toLowerCase().replace(/\s+/gu, " ").trim();
  return (
    /\b(?:what|who) should i listen to\b/u.test(text) ||
    /\b(?:put (?:me|us) on(?:\s+to)?|recommend|suggest|share|show)\b.{0,48}\b(?:an? |new |bay |local )?(?:artists?|musicians?|rappers?|singers?|bands?)\b/u.test(text) ||
    /\b(?:bay(?: area)?|norcal|local)\s+(?:artists?|music|musicians?|rappers?|singers?|bands?)\b/u.test(text) ||
    /\b(?:music|artist)\s+(?:recommendation|recommendations|rec|recs)\b/u.test(text)
  );
}

export function artistLeadIn(shareKind: CoastArtistShareKind): string {
  return shareKind === "direct"
    ? "Yee—here’s a Bay soundcheck."
    : "Bay soundcheck for the night.";
}
