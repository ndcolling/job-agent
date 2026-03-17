import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ── Jobs ────────────────────────────────────────────────────────────────────

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(), // nanoid
  // Discovery
  source: text("source").notNull(), // greenhouse | ashby | wellfound | yc | builtin
  sourceId: text("source_id"), // platform-native job id
  discoveredAt: text("discovered_at")
    .notNull()
    .default(sql`(datetime('now'))`),

  // Core info
  title: text("title").notNull(),
  company: text("company").notNull(),
  companySlug: text("company_slug"), // for API-based sources
  url: text("url").notNull().unique(), // canonical URL to job posting
  applyUrl: text("apply_url"), // direct application URL (may differ)

  // ATS / application system
  atsPlatform: text("ats_platform"), // greenhouse | ashby | lever | workday | wellfound | native | unknown
  requiresAccount: integer("requires_account", { mode: "boolean" }).default(false),

  // Role details
  location: text("location"),
  remote: text("remote"), // remote | hybrid | onsite
  salaryMin: integer("salary_min"),
  salaryMax: integer("salary_max"),
  salaryCurrency: text("salary_currency").default("USD"),
  employmentType: text("employment_type"), // full-time | contract | part-time
  seniorityLevel: text("seniority_level"), // entry | mid | senior | staff | principal

  // Content
  description: text("description"), // raw JD text
  requiredSkills: text("required_skills"), // JSON array
  preferredSkills: text("preferred_skills"), // JSON array

  // Scoring
  matchScore: real("match_score"), // 0-100, set by scorer
  matchReasoning: text("match_reasoning"), // Claude's explanation
  scoredAt: text("scored_at"),

  // Pipeline status
  status: text("status").notNull().default("discovered"),
  // discovered → scored → approved | skipped → applying → applied
  // → interviewing | rejected | ghosted | offer

  appliedAt: text("applied_at"),
  notes: text("notes"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ── Platform Accounts ────────────────────────────────────────────────────────

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  platform: text("platform").notNull(), // greenhouse | wellfound | yc | etc.
  email: text("email").notNull(),
  username: text("username"),
  // Store as base64 — not truly encrypted, use a secrets manager in prod
  passwordB64: text("password_b64"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  verified: integer("verified", { mode: "boolean" }).default(false),
  notes: text("notes"),
});

// ── Application Runs ─────────────────────────────────────────────────────────

export const applications = sqliteTable("applications", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .references(() => jobs.id),
  accountId: text("account_id").references(() => accounts.id),
  status: text("status").notNull().default("pending"),
  // pending | in_progress | submitted | failed | skipped

  startedAt: text("started_at"),
  submittedAt: text("submitted_at"),
  confirmationText: text("confirmation_text"),
  errorMessage: text("error_message"),
  screenshotPath: text("screenshot_path"),
  notes: text("notes"),
});

// ── Types ─────────────────────────────────────────────────────────────────────

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Application = typeof applications.$inferSelect;
export type NewApplication = typeof applications.$inferInsert;

export type JobStatus =
  | "discovered"
  | "scored"
  | "approved"
  | "skipped"
  | "applying"
  | "applied"
  | "interviewing"
  | "rejected"
  | "ghosted"
  | "offer";
