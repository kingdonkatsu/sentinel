/**
 * The 50 reference distress phrases used for semantic similarity scoring.
 *
 * Each phrase represents a distinct facet of emotional distress so that the
 * embedding space is well-covered. The MiniLM model encodes these into
 * 384-dimensional vectors at first load; cosine similarity then measures how
 * semantically close any new text is to this distress space.
 *
 * Phrases are organised by severity tier (severe → mild) so that the
 * maximum-similarity score reflects the closest match rather than an average.
 */

// Tier 1 — Suicidal ideation / self-harm
export const DISTRESS_PHRASES_SEVERE = [
  "I want to kill myself",
  "I don't want to be alive anymore",
  "I'm going to end it tonight",
  "Nobody would miss me if I was gone",
  "I've been cutting myself",
  "I took too many pills",
  "I just want it all to stop forever",
  "There's no reason to keep going",
  "I've been thinking about suicide",
  "I wrote a note just in case",
] as const;

// Tier 2 — Hopelessness / severe depression
export const DISTRESS_PHRASES_HIGH = [
  "I feel completely hopeless",
  "Nothing will ever get better",
  "I'm trapped and there's no way out",
  "I'm so exhausted I can't go on",
  "I feel empty inside all the time",
  "I've given up on everything",
  "I'm worthless and a burden to everyone",
  "I can't see any future for myself",
  "I've been crying every single day",
  "I just want to disappear",
] as const;

// Tier 3 — Anxiety / acute distress
export const DISTRESS_PHRASES_MODERATE = [
  "I'm scared and I don't know why",
  "I can't breathe I'm panicking so bad",
  "I feel like I'm falling apart",
  "I haven't slept in days",
  "Everyone hates me and I deserve it",
  "I'm so alone it physically hurts",
  "I can't stop shaking",
  "My mind won't let me rest",
  "I feel numb to everything",
  "I can't keep pretending I'm okay",
] as const;

// Tier 4 — Loneliness / low mood
export const DISTRESS_PHRASES_MILD = [
  "I have no one to talk to",
  "I feel like nobody understands me",
  "I'm so tired of being sad all the time",
  "I've been really struggling lately",
  "I just feel so lost",
  "I don't see the point in anything",
  "Life feels really heavy right now",
  "I wish I could just disappear for a while",
  "I'm so stressed I can't think straight",
  "Everything feels overwhelming",
] as const;

// Tier 5 — Subtle / implicit distress
export const DISTRESS_PHRASES_SUBTLE = [
  "Does it get better or does it just hurt less",
  "Sometimes I wonder if anyone would notice",
  "I keep smiling but it doesn't reach my eyes",
  "Another night where I can't stop thinking",
  "3am thoughts again",
  "I'm fine becomes a habit after a while",
  "Existing is exhausting",
  "I just need someone to ask if I'm really okay",
  "My mind is a really dark place right now",
  "I've been wearing long sleeves in summer",
] as const;

export const ALL_DISTRESS_PHRASES: readonly string[] = [
  ...DISTRESS_PHRASES_SEVERE,
  ...DISTRESS_PHRASES_HIGH,
  ...DISTRESS_PHRASES_MODERATE,
  ...DISTRESS_PHRASES_MILD,
  ...DISTRESS_PHRASES_SUBTLE,
];

/**
 * Urgency markers: these short patterns indicate time-critical distress.
 * If ANY of these appear in text with a non-trivially elevated score,
 * the confidence is bumped up and the score is floored.
 */
export const URGENCY_PATTERNS = [
  /tonight/i,
  /right now/i,
  /this moment/i,
  /can'?t take it anymore/i,
  /last time/i,
  /never again/i,
  /goodbye everyone/i,
  /final post/i,
  /last message/i,
  /\btoday\b.*(?:end|stop|done)/i,
] as const;
