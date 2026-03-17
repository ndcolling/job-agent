import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { randomUUID as nanoid } from "crypto";
import chalk from "chalk";
import { config } from "../config";
import { db, schema } from "../db/client";
import { NewJob } from "../db/schema";
import { loadProfile } from "../profile/store";
import { GreenhouseSource } from "../search/greenhouse";
import { AshbySource } from "../search/ashby";
import { scoreJob } from "../search/scorer";
import { tools, ToolName } from "./tools";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// ── Tool Handlers ─────────────────────────────────────────────────────────────

const greenhouse = new GreenhouseSource();
const ashby = new AshbySource();

// Map from tool name → handler function
type ToolInput = Record<string, unknown>;

async function handleTool(
  name: ToolName,
  input: ToolInput
): Promise<unknown> {
  const profile = loadProfile();

  switch (name) {
    case "search_greenhouse": {
      const listings = await greenhouse.search({
        keywords: (input.keywords as string[]) ?? [],
        remote: input.remoteOnly as boolean | undefined,
        limit: (input.limit as number) ?? 50,
      });
      return {
        count: listings.length,
        jobs: listings.slice(0, 20).map((j) => ({
          title: j.title,
          company: j.company,
          url: j.url,
          remote: j.remote,
          location: j.location,
        })),
        message: listings.length > 20
          ? `Showing first 20 of ${listings.length} results`
          : undefined,
      };
    }

    case "search_ashby": {
      const listings = await ashby.search({
        keywords: (input.keywords as string[]) ?? [],
        remote: input.remoteOnly as boolean | undefined,
        limit: (input.limit as number) ?? 50,
      });
      return {
        count: listings.length,
        jobs: listings.slice(0, 20).map((j) => ({
          title: j.title,
          company: j.company,
          url: j.url,
          remote: j.remote,
          location: j.location,
        })),
      };
    }

    case "score_and_save_jobs": {
      const urls = input.jobUrls as string[];
      const minScore = (input.minScore as number) ?? 60;

      // Find these jobs from recent search results (simplified — in prod you'd cache them)
      const allListings = [
        ...(await greenhouse.search({ keywords: profile.preferences.roles })),
        ...(await ashby.search({ keywords: profile.preferences.roles })),
      ];

      const toScore = allListings.filter((l) => urls.includes(l.url));
      const saved: string[] = [];
      const skipped: string[] = [];

      for (const listing of toScore) {
        const scored = await scoreJob(listing, profile);

        if (scored.score >= minScore) {
          const id = nanoid();
          const job: NewJob = {
            id,
            source: listing.source,
            sourceId: listing.sourceId,
            title: listing.title,
            company: listing.company,
            companySlug: listing.companySlug,
            url: listing.url,
            applyUrl: listing.applyUrl,
            location: listing.location,
            remote: listing.remote,
            description: listing.description,
            matchScore: scored.score,
            matchReasoning: scored.reasoning,
            scoredAt: new Date().toISOString(),
            status: "scored",
          };

          try {
            await db.insert(schema.jobs).values(job).onConflictDoNothing();
            saved.push(listing.url);
          } catch {
            // Already exists — update score
            await db
              .update(schema.jobs)
              .set({ matchScore: scored.score, matchReasoning: scored.reasoning, status: "scored" })
              .where(eq(schema.jobs.url, listing.url));
            saved.push(listing.url);
          }
        } else {
          skipped.push(listing.url);
        }
      }

      return { saved: saved.length, skipped: skipped.length, minScore };
    }

    case "list_approved_jobs": {
      const limit = (input.limit as number) ?? 20;
      const jobs = await db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.status, "approved"))
        .limit(limit);

      return jobs.map((j) => ({
        id: j.id,
        title: j.title,
        company: j.company,
        url: j.url,
        matchScore: j.matchScore,
        remote: j.remote,
        location: j.location,
      }));
    }

    case "get_job_details": {
      const jobs = await db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.id, input.jobId as string))
        .limit(1);

      return jobs[0] ?? { error: "Job not found" };
    }

    case "draft_cover_letter": {
      const jobs = await db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.id, input.jobId as string))
        .limit(1);

      const job = jobs[0];
      if (!job) return { error: "Job not found" };

      const response = await client.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: `Write a tailored cover letter for this job application.

CANDIDATE: ${profile.contact.firstName} ${profile.contact.lastName}
SUMMARY: ${profile.summary}
TOP SKILLS: ${profile.skills.slice(0, 15).join(", ")}
RECENT EXPERIENCE: ${profile.workExperience
              .slice(0, 2)
              .map((w) => `${w.title} at ${w.company}: ${w.description.slice(0, 200)}`)
              .join("\n")}

JOB: ${job.title} at ${job.company}
DESCRIPTION: ${job.description?.slice(0, 2000) ?? "Not available"}

TONE: ${input.tone ?? "professional"}

Write 3 concise paragraphs. Do not use generic filler. Reference specific skills and experience relevant to this role.`,
          },
        ],
      });

      const text =
        response.content[0].type === "text" ? response.content[0].text : "";
      return { coverLetter: text, jobId: job.id, company: job.company };
    }

    case "draft_answer": {
      const jobs = await db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.id, input.jobId as string))
        .limit(1);

      const job = jobs[0];
      if (!job) return { error: "Job not found" };

      const response = await client.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: `Answer this application question for the candidate.

CANDIDATE PROFILE SUMMARY:
Name: ${profile.contact.firstName} ${profile.contact.lastName}
Summary: ${profile.summary}
Skills: ${profile.skills.slice(0, 20).join(", ")}
Experience: ${profile.workExperience
              .slice(0, 2)
              .map((w) => `${w.title} at ${w.company}`)
              .join(", ")}

JOB: ${job.title} at ${job.company}

QUESTION: ${input.question}
${input.maxLength ? `MAX LENGTH: ${input.maxLength} characters` : ""}

Write a direct, specific answer. Draw on the candidate's real experience.`,
          },
        ],
      });

      const text =
        response.content[0].type === "text" ? response.content[0].text : "";
      return { answer: text, question: input.question };
    }

    case "update_job_status": {
      await db
        .update(schema.jobs)
        .set({
          status: input.status as string,
          notes: (input.notes as string) ?? undefined,
          updatedAt: new Date().toISOString(),
          ...(input.status === "applied" ? { appliedAt: new Date().toISOString() } : {}),
        })
        .where(eq(schema.jobs.id, input.jobId as string));

      return { success: true, jobId: input.jobId, newStatus: input.status };
    }

    case "get_profile_summary": {
      return {
        name: `${profile.contact.firstName} ${profile.contact.lastName}`,
        email: profile.contact.email,
        summary: profile.summary,
        skills: profile.skills.slice(0, 20),
        totalSkills: profile.skills.length,
        experienceCount: profile.workExperience.length,
        projectCount: profile.projects.length,
        preferences: profile.preferences,
        workAuth: profile.workAuth,
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Agent Loop ────────────────────────────────────────────────────────────────

export interface AgentOptions {
  task: string;
  maxIterations?: number;
  verbose?: boolean;
}

export async function runAgent(options: AgentOptions): Promise<string> {
  const { task, maxIterations = 20, verbose = true } = options;
  const profile = loadProfile();

  const systemPrompt = `You are a job search agent helping ${profile.contact.firstName} ${profile.contact.lastName} find and apply to relevant jobs.

Your job is to use the available tools to:
1. Search for jobs matching the user's profile and preferences
2. Score and save promising opportunities to the database
3. Help draft application materials when asked
4. Keep the user informed of what you find

USER PROFILE SUMMARY:
- Target roles: ${profile.preferences.roles.join(", ")}
- Seniority: ${profile.preferences.seniorityLevels.join(", ")}
- Remote preference: ${profile.preferences.remote}
- Key skills: ${profile.skills.slice(0, 15).join(", ")}
- Min salary: ${profile.preferences.salaryMin ? `$${profile.preferences.salaryMin.toLocaleString()}` : "Not specified"}
- Industries to avoid: ${profile.preferences.industriesToAvoid.join(", ") || "None"}

Always use tools to take real actions. After completing the task, provide a clear summary of what was accomplished.`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: task },
  ];

  let iterations = 0;
  let finalResponse = "";

  if (verbose) {
    console.log(chalk.dim(`\nAgent starting: "${task}"\n`));
  }

  while (iterations < maxIterations) {
    iterations++;

    const response = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });

    // Add assistant message to history
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      finalResponse =
        textBlock?.type === "text" ? textBlock.text : "Task complete.";
      break;
    }

    if (response.stop_reason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        const toolName = block.name as ToolName;
        if (verbose) {
          console.log(chalk.cyan(`  → ${toolName}`), chalk.dim(JSON.stringify(block.input).slice(0, 100)));
        }

        let result: unknown;
        try {
          result = await handleTool(toolName, block.input as ToolInput);
          if (verbose) {
            const summary = JSON.stringify(result).slice(0, 120);
            console.log(chalk.green(`  ✓`), chalk.dim(summary));
          }
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
          if (verbose) {
            console.log(chalk.red(`  ✗`), chalk.dim(String(err)));
          }
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: "user", content: toolResults });
    }
  }

  if (iterations >= maxIterations) {
    finalResponse = "Agent reached maximum iterations without completing the task.";
  }

  return finalResponse;
}
