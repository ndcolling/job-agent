import { Command } from "commander";
import chalk from "chalk";
import { eq, desc } from "drizzle-orm";
import { runWizard } from "./profile/wizard";
import { runAgent } from "./agent/orchestrator";
import { runMigrations, db, schema } from "./db/client";
import { loadProfile, profileExists } from "./profile/store";

const program = new Command();

program
  .name("job-agent")
  .description("AI-powered job search and application agent")
  .version("0.1.0");

// ── wizard ────────────────────────────────────────────────────────────────────

program
  .command("wizard")
  .description("Run the onboarding wizard to create or update your profile")
  .action(async () => {
    await ensureDb();
    await runWizard();
  });

// ── search ────────────────────────────────────────────────────────────────────

program
  .command("search")
  .description("Search for jobs matching your profile and save scored results")
  .option("--min-score <number>", "Minimum match score to save (0-100)", "60")
  .option("--sources <sources>", "Comma-separated sources: greenhouse,ashby", "greenhouse,ashby")
  .option("--remote-only", "Only include remote positions")
  .action(async (opts) => {
    await ensureDb();
    requireProfile();

    const profile = loadProfile();
    const sources = opts.sources.split(",").map((s: string) => s.trim());
    const keywords = [
      ...profile.preferences.roles,
      ...profile.skills.slice(0, 5),
    ];

    const task =
      `Search for jobs matching this profile. ` +
      `Use the following sources: ${sources.join(", ")}. ` +
      `Keywords to search: ${keywords.join(", ")}. ` +
      `Remote preference: ${profile.preferences.remote === "remote-only" ? "remote only" : "any"}. ` +
      `Score all results and save those with a match score of ${opts.minScore}+. ` +
      `Report how many jobs were found and saved.`;

    console.log(chalk.bold("\nSearching for jobs...\n"));
    const result = await runAgent({ task, verbose: true });
    console.log("\n" + chalk.bold("Summary:"), result);
  });

// ── list ──────────────────────────────────────────────────────────────────────

program
  .command("list")
  .description("List jobs in the pipeline")
  .option(
    "--status <status>",
    "Filter by status (discovered|scored|approved|applied|...)",
    "scored"
  )
  .option("--limit <number>", "Max results", "20")
  .action(async (opts) => {
    await ensureDb();

    const jobs = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.status, opts.status))
      .orderBy(desc(schema.jobs.matchScore))
      .limit(parseInt(opts.limit, 10));

    if (jobs.length === 0) {
      console.log(chalk.dim(`No jobs with status "${opts.status}"`));
      return;
    }

    console.log(
      chalk.bold(`\n${jobs.length} jobs — status: ${opts.status}\n`)
    );

    for (const job of jobs) {
      const score = job.matchScore != null
        ? chalk.green(`[${Math.round(job.matchScore)}]`)
        : chalk.dim("[--]");
      const remote = job.remote === "remote"
        ? chalk.cyan("remote")
        : chalk.dim(job.remote ?? "");

      console.log(
        `  ${score} ${chalk.bold(job.title)} @ ${job.company} ${remote}`
      );
      console.log(chalk.dim(`       ${job.url}`));
      if (job.matchReasoning) {
        console.log(chalk.dim(`       ${job.matchReasoning.slice(0, 100)}...`));
      }
      console.log();
    }
  });

// ── approve ───────────────────────────────────────────────────────────────────

program
  .command("approve <jobId>")
  .description("Approve a job for application")
  .action(async (jobId: string) => {
    await ensureDb();

    await db
      .update(schema.jobs)
      .set({ status: "approved", updatedAt: new Date().toISOString() })
      .where(eq(schema.jobs.id, jobId));

    console.log(chalk.green(`✓ Job ${jobId} approved for application`));
  });

// ── skip ──────────────────────────────────────────────────────────────────────

program
  .command("skip <jobId>")
  .description("Skip a job (won't be shown in scored list again)")
  .action(async (jobId: string) => {
    await ensureDb();

    await db
      .update(schema.jobs)
      .set({ status: "skipped", updatedAt: new Date().toISOString() })
      .where(eq(schema.jobs.id, jobId));

    console.log(chalk.dim(`Skipped job ${jobId}`));
  });

// ── draft ─────────────────────────────────────────────────────────────────────

program
  .command("draft <jobId>")
  .description("Draft a cover letter for a job")
  .option("--tone <tone>", "Tone: professional | conversational | technical", "professional")
  .action(async (jobId: string, opts) => {
    await ensureDb();
    requireProfile();

    const task =
      `Draft a ${opts.tone} cover letter for job ID: ${jobId}. ` +
      `Return the full cover letter text.`;

    const result = await runAgent({ task, verbose: false });
    console.log("\n" + result);
  });

// ── ask ───────────────────────────────────────────────────────────────────────

program
  .command("ask <prompt...>")
  .description("Ask the agent anything (free-form)")
  .action(async (promptParts: string[]) => {
    await ensureDb();
    if (profileExists()) requireProfile();

    const task = promptParts.join(" ");
    const result = await runAgent({ task, verbose: true });
    console.log("\n" + chalk.bold("Agent:"), result);
  });

// ── Helpers ───────────────────────────────────────────────────────────────────

async function ensureDb() {
  await runMigrations();
}

function requireProfile() {
  if (!profileExists()) {
    console.error(
      chalk.red("No profile found. Run `npm run dev wizard` to create one.")
    );
    process.exit(1);
  }
}

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red("Error:"), err.message);
  process.exit(1);
});
