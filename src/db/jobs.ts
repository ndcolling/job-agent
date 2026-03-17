import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db, schema } from "./client";
import { Job, JobStatus, NewJob } from "./schema";

// ── Lookups ───────────────────────────────────────────────────────────────────

export async function findJobByUrl(url: string): Promise<Job | null> {
  const rows = await db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.url, url))
    .limit(1);
  return rows[0] ?? null;
}

export async function findJobById(id: string): Promise<Job | null> {
  const rows = await db
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.id, id))
    .limit(1);
  return rows[0] ?? null;
}

// ── Writes ────────────────────────────────────────────────────────────────────

/**
 * Insert a new job or update an existing one (matched by URL).
 * Always returns the final stored record.
 */
export async function upsertJob(data: Omit<NewJob, "id">): Promise<Job> {
  const existing = await findJobByUrl(data.url);

  if (existing) {
    await db
      .update(schema.jobs)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(eq(schema.jobs.id, existing.id));
    return (await findJobById(existing.id))!;
  }

  const id = randomUUID();
  await db.insert(schema.jobs).values({ id, ...data });
  return (await findJobById(id))!;
}

/** Transition a job to a new status, with an optional timestamp or notes. */
export async function updateJobStatus(
  id: string,
  status: JobStatus,
  extras?: { notes?: string; appliedAt?: string }
): Promise<void> {
  await db
    .update(schema.jobs)
    .set({
      status,
      updatedAt: new Date().toISOString(),
      ...(extras?.notes ? { notes: extras.notes } : {}),
      ...(extras?.appliedAt ? { appliedAt: extras.appliedAt } : {}),
    })
    .where(eq(schema.jobs.id, id));
}

// ── Application run tracking ──────────────────────────────────────────────────

export type ApplicationRunStatus =
  | "submitted"
  | "email_ready"
  | "cancelled"
  | "failed"
  | "external";

export async function recordApplicationRun(
  jobId: string,
  result: {
    status: ApplicationRunStatus;
    errorMessage?: string;
    confirmationText?: string;
    notes?: string;
  }
): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(schema.applications).values({
    id: randomUUID(),
    jobId,
    status: result.status,
    startedAt: now,
    submittedAt:
      result.status === "submitted" || result.status === "email_ready"
        ? now
        : undefined,
    confirmationText: result.confirmationText,
    errorMessage: result.errorMessage,
    notes: result.notes,
  });
}

/** All application attempts for a given job, newest first. */
export async function getApplicationHistory(jobId: string) {
  return db
    .select()
    .from(schema.applications)
    .where(eq(schema.applications.jobId, jobId))
    .orderBy(schema.applications.startedAt);
}
