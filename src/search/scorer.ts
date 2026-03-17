import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { Profile } from "../profile/types";
import { JobListing } from "./types";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export interface ScoredJob {
  listing: JobListing;
  score: number; // 0-100
  reasoning: string;
  redFlags: string[];
  highlights: string[];
}

export async function scoreJob(
  listing: JobListing,
  profile: Profile
): Promise<ScoredJob> {
  const profileSummary = buildProfileSummary(profile);
  const jobSummary = `
Title: ${listing.title}
Company: ${listing.company}
Location: ${listing.location ?? "Not specified"}
Remote: ${listing.remote ?? "Not specified"}
Description: ${listing.description?.slice(0, 3000) ?? "No description available"}
  `.trim();

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Score this job listing's fit for the candidate. Return ONLY valid JSON.

CANDIDATE PROFILE:
${profileSummary}

JOB LISTING:
${jobSummary}

Return JSON:
{
  "score": <0-100 integer>,
  "reasoning": "<2-3 sentence explanation>",
  "highlights": ["<why this is a good fit>", ...],
  "redFlags": ["<concern or mismatch>", ...]
}

Scoring guide:
- 80-100: Excellent match, apply immediately
- 60-79: Good match, worth applying
- 40-59: Partial match, consider carefully
- 20-39: Poor match, likely to be filtered
- 0-19: Not a fit`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "{}";
  const jsonMatch =
    text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/);

  if (!jsonMatch) {
    return { listing, score: 0, reasoning: "Failed to score", redFlags: [], highlights: [] };
  }

  const result = JSON.parse(jsonMatch[1]);
  return {
    listing,
    score: result.score ?? 0,
    reasoning: result.reasoning ?? "",
    redFlags: result.redFlags ?? [],
    highlights: result.highlights ?? [],
  };
}

export async function scoreJobs(
  listings: JobListing[],
  profile: Profile,
  onProgress?: (current: number, total: number) => void
): Promise<ScoredJob[]> {
  const scored: ScoredJob[] = [];

  for (let i = 0; i < listings.length; i++) {
    onProgress?.(i + 1, listings.length);
    const result = await scoreJob(listings[i], profile);
    scored.push(result);
    // Small delay to avoid rate limiting
    if (i < listings.length - 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return scored.sort((a, b) => b.score - a.score);
}

function buildProfileSummary(profile: Profile): string {
  const exp = profile.workExperience
    .slice(0, 3)
    .map(
      (w) =>
        `- ${w.title} at ${w.company} (${w.startDate} – ${w.endDate ?? "present"}): ${w.description.slice(0, 200)}`
    )
    .join("\n");

  return `
Name: ${profile.contact.firstName} ${profile.contact.lastName}
Summary: ${profile.summary}
Skills: ${profile.skills.slice(0, 30).join(", ")}
Target roles: ${profile.preferences.roles.join(", ")}
Seniority: ${profile.preferences.seniorityLevels.join(", ")}
Remote preference: ${profile.preferences.remote}
Salary minimum: ${profile.preferences.salaryMin ? `$${profile.preferences.salaryMin.toLocaleString()}` : "Not specified"}
Work authorization: ${profile.workAuth.authorized ? "Authorized" : "Not authorized"}, Sponsorship needed: ${profile.workAuth.requiresSponsorship}

Recent experience:
${exp}

Industries to avoid: ${profile.preferences.industriesToAvoid.join(", ") || "None"}
  `.trim();
}
