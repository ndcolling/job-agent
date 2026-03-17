import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { QABank } from "./types";
import { loadProfile, saveProfile } from "./store";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// ── Types ─────────────────────────────────────────────────────────────────────

export type MatchConfidence = "exact" | "pattern" | "semantic";

export interface BankMatch {
  answer: string;
  matchedQuestion: string;
  confidence: MatchConfidence;
}

// ── Common Question Patterns ──────────────────────────────────────────────────
// Each entry maps a set of trigger phrases to a canonical topic label.
// We check stored questions against these to find pattern matches.

const QUESTION_PATTERNS: Array<{ topic: string; triggers: string[] }> = [
  {
    topic: "years_of_experience",
    triggers: [
      "years of experience",
      "how many years",
      "years have you",
      "years working",
      "years in the industry",
      "years of professional",
    ],
  },
  {
    topic: "current_location",
    triggers: [
      "currently located",
      "where do you live",
      "where are you based",
      "current location",
      "where do you reside",
      "where are you located",
      "city do you live",
    ],
  },
  {
    topic: "work_authorization",
    triggers: [
      "authorized to work",
      "work authorization",
      "visa sponsorship",
      "require sponsorship",
      "eligible to work",
      "legally authorized",
      "us citizen",
      "work in the us",
      "work in the united states",
    ],
  },
  {
    topic: "salary_expectations",
    triggers: [
      "salary expectation",
      "expected salary",
      "compensation expectation",
      "desired salary",
      "salary range",
      "what are you looking for",
      "target compensation",
    ],
  },
  {
    topic: "start_date",
    triggers: [
      "when can you start",
      "earliest start",
      "available to start",
      "start date",
      "notice period",
      "how soon",
    ],
  },
  {
    topic: "remote_preference",
    triggers: [
      "remote work",
      "work from home",
      "onsite preference",
      "remote or onsite",
      "hybrid preference",
      "office preference",
    ],
  },
  {
    topic: "linkedin",
    triggers: ["linkedin", "linkedin profile", "linkedin url"],
  },
  {
    topic: "github",
    triggers: ["github", "github profile", "github url", "code repository"],
  },
  {
    topic: "portfolio",
    triggers: ["portfolio", "personal website", "personal site", "website url"],
  },
  {
    topic: "referral",
    triggers: [
      "how did you hear",
      "how did you find",
      "referred by",
      "source of application",
    ],
  },
];

// ── Lookup ────────────────────────────────────────────────────────────────────

/**
 * Looks up a question in the QA bank using three tiers:
 * 1. Exact match (normalized)
 * 2. Pattern match (common question types)
 * 3. Semantic match via Claude (fallback for edge cases)
 *
 * Returns null if no confident match is found.
 */
export async function findSimilarAnswer(
  question: string,
  qaBank: QABank
): Promise<BankMatch | null> {
  const entries = Object.entries(qaBank);
  if (entries.length === 0) return null;

  const normalized = normalizeQuestion(question);

  // Tier 1: Exact match
  for (const [storedQ, answer] of entries) {
    if (normalizeQuestion(storedQ) === normalized) {
      return { answer, matchedQuestion: storedQ, confidence: "exact" };
    }
  }

  // Tier 2: Pattern match
  // Find which topic the incoming question belongs to
  const incomingTopic = detectTopic(normalized);

  if (incomingTopic) {
    // Find a stored question with the same topic
    for (const [storedQ, answer] of entries) {
      if (detectTopic(normalizeQuestion(storedQ)) === incomingTopic) {
        return { answer, matchedQuestion: storedQ, confidence: "pattern" };
      }
    }
  }

  // Tier 3: Semantic match via Claude (only if bank has entries worth checking)
  if (entries.length > 0) {
    return await semanticLookup(question, entries);
  }

  return null;
}

async function semanticLookup(
  question: string,
  entries: [string, string][]
): Promise<BankMatch | null> {
  const bankSummary = entries
    .map(([q], i) => `${i + 1}. ${q}`)
    .join("\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001", // fast + cheap for this lookup
    max_tokens: 100,
    messages: [
      {
        role: "user",
        content: `Does any stored question ask essentially the same thing as the new question?

NEW QUESTION: "${question}"

STORED QUESTIONS:
${bankSummary}

Reply with ONLY the number of the matching question (e.g. "3"), or "none" if no question is a clear semantic match. Do not explain.`,
      },
    ],
  });

  const text =
    response.content[0].type === "text"
      ? response.content[0].text.trim().toLowerCase()
      : "none";

  if (text === "none") return null;

  const idx = parseInt(text, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= entries.length) return null;

  const [matchedQuestion, answer] = entries[idx];
  return { answer, matchedQuestion, confidence: "semantic" };
}

// ── Save ──────────────────────────────────────────────────────────────────────

/**
 * Saves a question+answer pair to the profile's QA bank.
 * Uses the canonical question text as the key.
 */
export function saveToBank(question: string, answer: string): void {
  const profile = loadProfile();
  profile.qaBank = {
    ...profile.qaBank,
    [question.trim()]: answer.trim(),
  };
  saveProfile(profile);
}

export function deleteFromBank(question: string): boolean {
  const profile = loadProfile();
  if (!(question in profile.qaBank)) return false;
  const { [question]: _removed, ...rest } = profile.qaBank;
  profile.qaBank = rest;
  saveProfile(profile);
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectTopic(normalizedQuestion: string): string | null {
  for (const { topic, triggers } of QUESTION_PATTERNS) {
    if (triggers.some((t) => normalizedQuestion.includes(t))) {
      return topic;
    }
  }
  return null;
}
