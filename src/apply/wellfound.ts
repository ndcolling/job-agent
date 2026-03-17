import Anthropic from "@anthropic-ai/sdk";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { Page } from "playwright";
import { config } from "../config";
import { findSimilarAnswer, saveToBank, BankMatch } from "../profile/qabank";
import { Profile } from "../profile/types";
import { WellfoundJob, WellfoundFormQuestion } from "../search/wellfound";
import { createBrowserSession, humanDelay, humanType } from "./browser";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AnswerMeta {
  answer: string;
  source: "bank" | "generated";
  bankMatch?: BankMatch; // present when source === "bank"
}

export interface ApplicationDraft {
  method: WellfoundJob["applicationMethod"];
  // form
  introNote?: string;
  answers?: Record<string, AnswerMeta>; // question label → answer + source
  // email
  emailTo?: string;
  emailSubject?: string;
  emailBody?: string;
}

export type ApplicationResult =
  | { status: "submitted" }
  | { status: "email_ready"; draft: ApplicationDraft }
  | { status: "external"; url: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

// ── Main Entry Point ──────────────────────────────────────────────────────────

/**
 * Interactive guided flow: draft → human review → submit (or copy to clipboard).
 * Returns the final result so the caller can update the DB.
 */
export async function applyToWellfoundJob(
  job: WellfoundJob,
  profile: Profile
): Promise<ApplicationResult> {
  console.log();

  if (job.applicationMethod === "external") {
    p.note(
      `This job uses an external application system.\n${job.externalUrl}`,
      "External Application"
    );
    return { status: "external", url: job.externalUrl! };
  }

  if (job.applicationMethod === "unknown") {
    p.note(
      "Could not determine the application method for this job.\n" +
        "Open the URL manually and apply from the browser.",
      "Unknown Application Method"
    );
    return { status: "cancelled" };
  }

  // Draft responses
  const spin = p.spinner();
  spin.start("Drafting application with Claude...");
  const draft = await draftApplication(job, profile);
  spin.stop("Draft ready");

  // Human review
  const approved = await reviewDraft(job, draft);
  if (!approved) return { status: "cancelled" };

  // Execute
  if (job.applicationMethod === "email") {
    await copyEmailToClipboard(draft);
    return { status: "email_ready", draft };
  }

  if (job.applicationMethod === "wellfound-form") {
    return await submitForm(job, draft);
  }

  return { status: "cancelled" };
}

// ── Drafting ──────────────────────────────────────────────────────────────────

async function draftApplication(
  job: WellfoundJob,
  profile: Profile
): Promise<ApplicationDraft> {
  const profileContext = buildProfileContext(profile, job);

  if (job.applicationMethod === "wellfound-form") {
    return draftFormApplication(job, profile, profileContext);
  } else {
    return draftEmailApplication(job, profile, profileContext);
  }
}

async function draftFormApplication(
  job: WellfoundJob,
  profile: Profile,
  profileContext: string
): Promise<ApplicationDraft> {
  const draft: ApplicationDraft = {
    method: "wellfound-form",
    answers: {},
  };

  // Draft the intro note (cover note field)
  if (job.hasIntroField) {
    const response = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 600,
      messages: [
        {
          role: "user",
          content: `Write a compelling 3-paragraph introduction note for this job application.

${profileContext}

JOB: ${job.title} at ${job.company}
DESCRIPTION: ${job.description.slice(0, 3000)}

Guidelines:
- Be specific about why this role and company fit, not generic
- Highlight 2-3 directly relevant skills or experiences
- If the candidate has relevant personal interests (e.g. fitness for a sports-tech role), weave them in authentically — not forced
- Keep it under 250 words
- Don't start with "I am writing to..."
- Sound like a human, not a cover letter template`,
        },
      ],
    });
    draft.introNote =
      response.content[0].type === "text" ? response.content[0].text : "";
  }

  // Draft answers for each custom question — check bank first
  if (job.formQuestions.length > 0) {
    for (const question of job.formQuestions) {
      const bankMatch = await findSimilarAnswer(question.label, profile.qaBank);

      if (bankMatch) {
        draft.answers![question.label] = {
          answer: bankMatch.answer,
          source: "bank",
          bankMatch,
        };
      } else {
        const generated = await draftAnswer(
          question.label,
          job,
          profileContext,
          question.type
        );
        draft.answers![question.label] = { answer: generated, source: "generated" };
      }
    }
  }

  return draft;
}

async function draftEmailApplication(
  job: WellfoundJob,
  profile: Profile,
  profileContext: string
): Promise<ApplicationDraft> {
  const instructions = job.emailInstructions ?? job.description;

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1200,
    messages: [
      {
        role: "user",
        content: `Compose an application email for this job.

${profileContext}

JOB: ${job.title} at ${job.company}
APPLY TO: ${job.emailAddress}
APPLICATION INSTRUCTIONS / JD:
${instructions.slice(0, 3000)}

Return ONLY valid JSON:
{
  "subject": "...",
  "body": "..."
}

Email guidelines:
- Subject should be specific, not "Application for [role]"
- Body: open strong, address any specific questions asked in the instructions, close with a clear next step
- If specific questions are listed, answer each one clearly
- Weave in personal domain fit where authentic (e.g. fitness/health passion for a sports role)
- Under 400 words
- No attachments reference (resume will be attached separately)`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "{}";
  const jsonMatch =
    text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/);

  const parsed = jsonMatch ? JSON.parse(jsonMatch[1]) : {};

  return {
    method: "email",
    emailTo: job.emailAddress ?? "",
    emailSubject: parsed.subject ?? `Application: ${job.title}`,
    emailBody: parsed.body ?? "",
  };
}

async function draftAnswer(
  question: string,
  job: WellfoundJob,
  profileContext: string,
  fieldType: WellfoundFormQuestion["type"]
): Promise<string> {
  const maxWords = fieldType === "textarea" ? 150 : 60;

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 400,
    messages: [
      {
        role: "user",
        content: `Answer this application question for ${job.title} at ${job.company}.

${profileContext}

QUESTION: ${question}
MAX: ~${maxWords} words

Be direct and specific. Draw from the candidate's real experience and interests.`,
      },
    ],
  });

  return response.content[0].type === "text" ? response.content[0].text.trim() : "";
}

// ── Human Review ──────────────────────────────────────────────────────────────

async function reviewDraft(
  job: WellfoundJob,
  draft: ApplicationDraft
): Promise<boolean> {
  console.log();
  console.log(chalk.bold("── Application Draft ──────────────────────────────────"));
  console.log(chalk.dim(`  ${job.title} @ ${job.company}`));
  console.log(chalk.dim(`  Method: ${draft.method}`));
  console.log();

  if (draft.method === "wellfound-form") {
    if (draft.introNote) {
      console.log(chalk.cyan("Introduction note:"));
      console.log(draft.introNote);
      console.log();
    }

    if (draft.answers && Object.keys(draft.answers).length > 0) {
      for (const [question, meta] of Object.entries(draft.answers)) {
        const sourceLabel =
          meta.source === "bank"
            ? chalk.green(
                `[bank: ${meta.bankMatch?.confidence}${
                  meta.bankMatch?.matchedQuestion !== question
                    ? ` → "${meta.bankMatch?.matchedQuestion}"`
                    : ""
                }]`
              )
            : chalk.yellow("[generated]");

        console.log(chalk.cyan(`Q: ${question}`) + " " + sourceLabel);
        console.log(meta.answer);
        console.log();
      }
    }
  }

  if (draft.method === "email") {
    console.log(chalk.cyan("To:"), draft.emailTo);
    console.log(chalk.cyan("Subject:"), draft.emailSubject);
    console.log();
    console.log(draft.emailBody);
    console.log();
  }

  console.log(chalk.bold("──────────────────────────────────────────────────────"));

  const action = await p.select({
    message: "What would you like to do?",
    options: [
      { value: "submit", label: "Submit / proceed" },
      { value: "edit-intro", label: "Edit introduction note", hint: "opens $EDITOR" },
      { value: "save-answers", label: "Save generated answers to QA bank" },
      { value: "cancel", label: "Cancel" },
    ],
  });

  if (p.isCancel(action) || action === "cancel") return false;

  if (action === "edit-intro" && draft.method === "wellfound-form") {
    draft.introNote = await openInEditor(draft.introNote ?? "");
    return reviewDraft(job, draft);
  }

  if (action === "save-answers" && draft.answers) {
    await promptSaveAnswers(draft.answers);
    return reviewDraft(job, draft);
  }

  return true;
}

async function promptSaveAnswers(
  answers: Record<string, AnswerMeta>
): Promise<void> {
  const generated = Object.entries(answers).filter(
    ([, meta]) => meta.source === "generated"
  );

  if (generated.length === 0) {
    p.note("All answers came from your QA bank — nothing new to save.", "QA Bank");
    return;
  }

  for (const [question, meta] of generated) {
    const save = await p.confirm({
      message: `Save answer for "${question}" to QA bank?`,
      initialValue: true,
    });

    if (!p.isCancel(save) && save) {
      // Let user edit the canonical question key before saving
      const canonicalQ = await p.text({
        message: "Save under this question (edit to generalise):",
        initialValue: question,
      });
      if (!p.isCancel(canonicalQ) && canonicalQ) {
        saveToBank(String(canonicalQ), meta.answer);
        console.log(chalk.green(`  ✓ Saved`));
      }
    }
  }
}

// ── Form Submission ───────────────────────────────────────────────────────────

async function submitForm(
  job: WellfoundJob,
  draft: ApplicationDraft
): Promise<ApplicationResult> {
  const spin = p.spinner();
  spin.start("Opening browser and filling form...");

  const session = await createBrowserSession({ headless: false }); // headed so user can watch

  try {
    const page = session.page;
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await humanDelay(1500, 2500);

    // Click Apply button if needed to reveal form
    const applyBtn = page.locator(
      'button:has-text("Apply"), [data-test="ApplyButton"]'
    ).first();
    if (await applyBtn.isVisible().catch(() => false)) {
      await applyBtn.click();
      await humanDelay(800, 1200);
    }

    // Fill intro note
    if (draft.introNote) {
      const introSelectors = [
        'textarea[placeholder*="introduc"]',
        'textarea[placeholder*="yourself"]',
        'textarea[placeholder*="cover"]',
        'textarea[name*="intro"]',
        'textarea[name*="note"]',
      ];

      for (const sel of introSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible().catch(() => false)) {
          await humanType(page, sel, draft.introNote);
          await humanDelay(400, 800);
          break;
        }
      }
    }

    // Fill custom question answers
    if (draft.answers) {
      for (const question of job.formQuestions) {
        const meta = draft.answers[question.label];
        if (!meta) continue;

        await fillQuestion(page, question, meta.answer);
        await humanDelay(300, 600);
      }
    }

    spin.stop("Form filled — review in the browser before submitting");

    // Hand off to human for final review + submit
    const confirm = await p.confirm({
      message:
        "Form filled. Review it in the browser, then confirm to submit (or cancel to leave open).",
      initialValue: false,
    });

    if (p.isCancel(confirm) || !confirm) {
      p.note("Browser left open. Submit manually when ready.", "Handoff");
      // Don't close — let user submit manually
      return { status: "cancelled" };
    }

    // Click submit
    const submitBtn = page.locator(
      'button[type="submit"], button:has-text("Submit"), button:has-text("Send application")'
    ).first();

    if (await submitBtn.isVisible().catch(() => false)) {
      await submitBtn.click();
      await humanDelay(1500, 2500);
      p.note("Application submitted!", "Done");
      return { status: "submitted" };
    } else {
      p.note("Could not find submit button — submit manually in the browser.", "Handoff");
      return { status: "cancelled" };
    }
  } catch (err) {
    await session.close();
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // Note: session intentionally not closed here on success so user can see confirmation
}

async function fillQuestion(
  page: Page,
  question: WellfoundFormQuestion,
  answer: string
): Promise<void> {
  if (question.type === "textarea" || question.type === "text") {
    await humanType(page, question.selector, answer);
  } else if (question.type === "select") {
    await page.selectOption(question.selector, { label: answer }).catch(() => null);
  } else if (question.type === "checkbox") {
    // For yes/no checkboxes, check if answer is affirmative
    if (/yes|true|agree/i.test(answer)) {
      await page.check(question.selector).catch(() => null);
    }
  }
}

// ── Email Clipboard Copy ──────────────────────────────────────────────────────

async function copyEmailToClipboard(draft: ApplicationDraft): Promise<void> {
  const { execSync } = require("child_process") as typeof import("child_process");

  const emailText =
    `To: ${draft.emailTo}\n` +
    `Subject: ${draft.emailSubject}\n\n` +
    `${draft.emailBody}`;

  try {
    // macOS pbcopy
    execSync("pbcopy", { input: emailText });
    p.note(
      `Email draft copied to clipboard.\n\n` +
        `To: ${draft.emailTo}\n` +
        `Subject: ${draft.emailSubject}\n\n` +
        "Paste into your email client and attach your resume.",
      "Email Ready"
    );
  } catch {
    // Fallback: print it
    console.log(chalk.dim("(Could not copy to clipboard — printing instead)\n"));
    console.log(`To: ${draft.emailTo}`);
    console.log(`Subject: ${draft.emailSubject}`);
    console.log();
    console.log(draft.emailBody);
  }
}

// ── Editor Handoff ────────────────────────────────────────────────────────────

async function openInEditor(content: string): Promise<string> {
  const { execSync, spawnSync } = require("child_process") as typeof import("child_process");
  const { writeFileSync, readFileSync, unlinkSync } = require("fs") as typeof import("fs");
  const { tmpdir } = require("os") as typeof import("os");
  const { join } = require("path") as typeof import("path");

  const tmpFile = join(tmpdir(), `job-agent-edit-${Date.now()}.txt`);
  writeFileSync(tmpFile, content, "utf-8");

  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "nano";
  spawnSync(editor, [tmpFile], { stdio: "inherit" });

  const edited = readFileSync(tmpFile, "utf-8");
  unlinkSync(tmpFile);
  return edited;
}

// ── Profile Context Builder ───────────────────────────────────────────────────

function buildProfileContext(profile: Profile, job: WellfoundJob): string {
  const exp = profile.workExperience
    .slice(0, 3)
    .map(
      (w) =>
        `- ${w.title} at ${w.company} (${w.startDate}–${w.endDate ?? "present"}): ${w.description.slice(0, 300)}`
    )
    .join("\n");

  const projects = profile.projects
    .slice(0, 3)
    .map(
      (pr) =>
        `- ${pr.name}: ${pr.description.slice(0, 200)} [${pr.technologies.join(", ")}]`
    )
    .join("\n");

  const interestNote =
    profile.interests?.areas.length
      ? `Personal interests: ${profile.interests.areas.join(", ")}${
          profile.interests.narrative
            ? `\nPersonal narrative: ${profile.interests.narrative}`
            : ""
        }`
      : "";

  // Highlight intersection of candidate interests and job domain
  const domainMatch = detectDomainMatch(profile, job);

  return `CANDIDATE PROFILE:
Name: ${profile.contact.firstName} ${profile.contact.lastName}
Email: ${profile.contact.email}
Summary: ${profile.summary}
Top skills: ${profile.skills.slice(0, 20).join(", ")}

Work experience:
${exp}

Key projects:
${projects}

${interestNote}

${domainMatch ? `DOMAIN FIT NOTE: ${domainMatch}` : ""}
`.trim();
}

/**
 * Detects if the candidate's personal interests overlap with the job's domain.
 * Returns a note for Claude to use when this is relevant.
 */
function detectDomainMatch(profile: Profile, job: WellfoundJob): string | null {
  const interests = profile.interests?.areas ?? [];
  if (interests.length === 0) return null;

  const jobText = `${job.title} ${job.description}`.toLowerCase();

  const domainKeywords: Record<string, string[]> = {
    fitness: ["fitness", "workout", "training", "gym", "exercise", "athlete", "sport"],
    health: ["health", "wellness", "wellbeing", "medical", "clinical", "patient"],
    longevity: ["longevity", "lifespan", "aging", "anti-aging", "healthspan"],
    nutrition: ["nutrition", "diet", "food", "eating", "macro", "supplement"],
    ai: ["ai", "artificial intelligence", "machine learning", "llm", "gpt"],
    "open source": ["open source", "open-source", "community", "contributor"],
  };

  const matches: string[] = [];

  for (const interest of interests) {
    const keywords = domainKeywords[interest.toLowerCase()] ?? [interest.toLowerCase()];
    if (keywords.some((kw) => jobText.includes(kw))) {
      matches.push(interest);
    }
  }

  if (matches.length === 0) return null;

  return (
    `The candidate has personal experience/interest in ${matches.join(", ")}, ` +
    `which is directly relevant to this role. ` +
    `Use this authentically — show genuine domain knowledge, not just "I'm passionate about X".`
  );
}
