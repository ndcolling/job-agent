import * as p from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { desc, eq } from "drizzle-orm";
import { runAgent } from "./agent/orchestrator";
import { applyToWellfoundJob } from "./apply/wellfound";
import { runMigrations, db, schema } from "./db/client";
import { findJobByUrl, upsertJob, updateJobStatus, recordApplicationRun, getApplicationHistory } from "./db/jobs";
import { deleteFromBank, saveToBank } from "./profile/qabank";
import { loadProfile, profileExists, saveProfile } from "./profile/store";
import { runWizard } from "./profile/wizard";
import { scrapeWellfoundJob } from "./search/wellfound";
import { scoreJob } from "./search/scorer";

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

// ── apply ─────────────────────────────────────────────────────────────────────

program
  .command("apply <url>")
  .description("Scrape a Wellfound job URL, score it, draft responses, and apply")
  .option("--skip-score", "Skip scoring and proceed directly to application")
  .option("--dry-run", "Scrape and draft but do not submit")
  .action(async (url: string, opts) => {
    await ensureDb();
    requireProfile();

    const profile = loadProfile();
    const spin = p.spinner();

    // ── 1. Pre-flight: check if this URL is already in the pipeline ──────────
    const existing = await findJobByUrl(url);
    if (existing) {
      const alreadyApplied =
        existing.status === "applied" ||
        existing.status === "email_ready" ||
        existing.status === "interviewing" ||
        existing.status === "offer";

      if (alreadyApplied) {
        const history = await getApplicationHistory(existing.id);
        const lastRun = history[history.length - 1];

        p.note(
          [
            `Status  : ${chalk.bold(existing.status)}`,
            `Applied : ${existing.appliedAt ?? "unknown"}`,
            lastRun?.submittedAt
              ? `Last run: ${lastRun.submittedAt}`
              : undefined,
            existing.notes ? `Notes   : ${existing.notes}` : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
          `Already in pipeline: ${existing.title} @ ${existing.company}`
        );

        const reapply = await p.confirm({
          message: `This job is marked "${existing.status}". Apply again anyway?`,
          initialValue: false,
        });
        if (p.isCancel(reapply) || !reapply) {
          p.outro("Cancelled.");
          return;
        }
      } else {
        // In pipeline but not yet applied — resume from where it was
        console.log(
          chalk.dim(
            `\n  Resuming: ${existing.title} @ ${existing.company} (status: ${existing.status})\n`
          )
        );
      }
    }

    // ── 2. Scrape ────────────────────────────────────────────────────────────
    spin.start("Scraping job listing...");
    let job;
    try {
      job = await scrapeWellfoundJob(url);
      spin.stop(`Found: ${chalk.bold(job.title)} @ ${chalk.bold(job.company)}`);
    } catch (err) {
      spin.stop("Failed to scrape job");
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }

    // ── 3. Show summary ──────────────────────────────────────────────────────
    console.log();
    console.log(chalk.dim(`  Location : ${job.location ?? "not specified"} ${job.remote ? "(remote)" : ""}`));
    console.log(chalk.dim(`  Method   : ${job.applicationMethod}`));
    if (job.compensation) console.log(chalk.dim(`  Comp     : ${job.compensation}`));
    if (job.formQuestions.length > 0) {
      console.log(chalk.dim(`  Questions: ${job.formQuestions.map((q) => q.label).join(" | ")}`));
    }
    if (job.applicationMethod === "email") {
      console.log(chalk.dim(`  Email    : ${job.emailAddress}`));
    }
    console.log();

    // ── 4. Score ─────────────────────────────────────────────────────────────
    let matchScore: number | undefined;
    if (!opts.skipScore) {
      spin.start("Scoring against your profile...");
      const scored = await scoreJob(
        {
          title: job.title,
          company: job.company,
          url,
          source: "wellfound",
          description: job.description,
          remote: job.remote ? "remote" : "onsite",
          location: job.location ?? undefined,
          salaryCurrency: "USD",
        },
        profile
      );
      matchScore = scored.score;
      spin.stop(`Match score: ${chalk.bold(String(Math.round(scored.score)))} / 100`);

      console.log(chalk.dim(`  ${scored.reasoning}`));
      scored.highlights.forEach((h) => console.log(chalk.green(`  ✓ ${h}`)));
      scored.redFlags.forEach((f) => console.log(chalk.yellow(`  ⚠ ${f}`)));
      console.log();

      if (scored.score < 40) {
        const proceed = await p.confirm({
          message: `Score is ${Math.round(scored.score)}/100 — low match. Proceed anyway?`,
          initialValue: false,
        });
        if (p.isCancel(proceed) || !proceed) {
          p.outro("Cancelled.");
          return;
        }
      }
    }

    // Save/update the job record now so we have an ID for the application run
    const jobRecord = await upsertJob({
      source: "wellfound",
      title: job.title,
      company: job.company,
      url,
      description: job.description,
      location: job.location ?? undefined,
      remote: job.remote ? "remote" : "onsite",
      atsPlatform: job.applicationMethod,
      matchScore,
      status: "applying", // mark in-progress so a crash doesn't leave it as "scored"
      salaryCurrency: "USD",
    });

    if (opts.dryRun) {
      await updateJobStatus(jobRecord.id, "scored");
      p.note("Dry run — stopped before application. Status reset to 'scored'.", "Dry run");
      return;
    }

    // ── 5. Apply ─────────────────────────────────────────────────────────────
    const result = await applyToWellfoundJob(job, profile);

    // ── 6. Persist result ─────────────────────────────────────────────────────
    if (result.status === "submitted") {
      await updateJobStatus(jobRecord.id, "applied", {
        appliedAt: new Date().toISOString(),
      });
      await recordApplicationRun(jobRecord.id, { status: "submitted" });
      p.outro(chalk.green("Application submitted and saved to pipeline."));

    } else if (result.status === "email_ready") {
      await updateJobStatus(jobRecord.id, "email_ready");
      await recordApplicationRun(jobRecord.id, {
        status: "email_ready",
        notes: `Email to: ${job.emailAddress}`,
      });
      p.outro(
        "Email draft copied to clipboard. Mark as applied once sent:\n" +
        chalk.cyan(`  pnpm dev status ${jobRecord.id} applied`)
      );

    } else if (result.status === "external") {
      await updateJobStatus(jobRecord.id, "scored", {
        notes: `External ATS: ${result.url}`,
      });
      await recordApplicationRun(jobRecord.id, {
        status: "external",
        notes: result.url,
      });
      p.outro(`External ATS — open manually: ${result.url}`);

    } else if (result.status === "error") {
      await updateJobStatus(jobRecord.id, "scored", {
        notes: `Error: ${result.message}`,
      });
      await recordApplicationRun(jobRecord.id, {
        status: "failed",
        errorMessage: result.message,
      });
      console.error(chalk.red(`Error: ${result.message}`));

    } else {
      // cancelled — reset back to scored so it stays in the review queue
      await updateJobStatus(jobRecord.id, "scored");
    }
  });

// ── status ────────────────────────────────────────────────────────────────────

program
  .command("status <jobId> <status>")
  .description("Manually update a job's pipeline status")
  .option("--notes <text>", "Optional notes")
  .action(async (jobId: string, status: string, opts) => {
    await ensureDb();

    const validStatuses = [
      "discovered", "scored", "approved", "skipped", "applying",
      "applied", "email_ready", "interviewing", "rejected", "ghosted", "offer",
    ];
    if (!validStatuses.includes(status)) {
      console.error(chalk.red(`Invalid status "${status}". Valid: ${validStatuses.join(", ")}`));
      process.exit(1);
    }

    const extras: { notes?: string; appliedAt?: string } = {};
    if (opts.notes) extras.notes = opts.notes;
    if (status === "applied") extras.appliedAt = new Date().toISOString();

    await updateJobStatus(jobId, status as any, extras);
    console.log(chalk.green(`✓ ${jobId} → ${status}`));
  });

// ── history ───────────────────────────────────────────────────────────────────

program
  .command("history <jobId>")
  .description("Show all application attempts for a job")
  .action(async (jobId: string) => {
    await ensureDb();

    const runs = await getApplicationHistory(jobId);
    if (runs.length === 0) {
      console.log(chalk.dim("No application runs recorded for this job."));
      return;
    }

    console.log(chalk.bold(`\n${runs.length} application run(s):\n`));
    runs.forEach((run, i) => {
      const statusColor =
        run.status === "submitted" ? chalk.green
        : run.status === "failed" ? chalk.red
        : chalk.yellow;

      console.log(`  ${i + 1}. ${statusColor(run.status)}  ${chalk.dim(run.startedAt ?? "")}`);
      if (run.notes) console.log(chalk.dim(`     ${run.notes}`));
      if (run.errorMessage) console.log(chalk.red(`     Error: ${run.errorMessage}`));
    });
    console.log();
  });

// ── bank ──────────────────────────────────────────────────────────────────────

const bank = program
  .command("bank")
  .description("Manage your QA bank of reusable application answers");

bank
  .command("list")
  .description("Show all stored questions and answers")
  .action(() => {
    requireProfile();
    const { qaBank } = loadProfile();
    const entries = Object.entries(qaBank);

    if (entries.length === 0) {
      console.log(chalk.dim("QA bank is empty. Answers are saved automatically after applying."));
      return;
    }

    console.log(chalk.bold(`\n${entries.length} stored answer(s):\n`));
    entries.forEach(([question, answer], i) => {
      console.log(chalk.cyan(`${i + 1}. ${question}`));
      console.log(`   ${answer.replace(/\n/g, "\n   ")}`);
      console.log();
    });
  });

bank
  .command("add")
  .description("Manually add a question and answer to the bank")
  .action(async () => {
    requireProfile();

    const question = await p.text({
      message: "Question (use a generalised form, e.g. 'Where are you currently located?'):",
      validate: (v) => (!v ? "Required" : undefined),
    });
    if (p.isCancel(question)) return;

    const answer = await p.text({
      message: "Your answer:",
      validate: (v) => (!v ? "Required" : undefined),
    });
    if (p.isCancel(answer)) return;

    saveToBank(String(question), String(answer));
    console.log(chalk.green("\n✓ Saved to QA bank"));
  });

bank
  .command("delete <question>")
  .description("Delete an entry from the bank by its exact question text")
  .action((question: string) => {
    requireProfile();
    const deleted = deleteFromBank(question);
    if (deleted) {
      console.log(chalk.green(`✓ Deleted: "${question}"`));
    } else {
      console.log(chalk.red(`Not found: "${question}"`));
    }
  });

bank
  .command("edit")
  .description("Edit an existing bank entry")
  .action(async () => {
    requireProfile();
    const profile = loadProfile();
    const entries = Object.entries(profile.qaBank);

    if (entries.length === 0) {
      console.log(chalk.dim("QA bank is empty."));
      return;
    }

    const selected = await p.select({
      message: "Which entry to edit?",
      options: entries.map(([q]) => ({ value: q, label: q })),
    });
    if (p.isCancel(selected)) return;

    const currentAnswer = profile.qaBank[String(selected)];
    const newAnswer = await p.text({
      message: "Updated answer:",
      initialValue: currentAnswer,
      validate: (v) => (!v ? "Required" : undefined),
    });
    if (p.isCancel(newAnswer)) return;

    profile.qaBank[String(selected)] = String(newAnswer);
    saveProfile(profile);
    console.log(chalk.green("✓ Updated"));
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
