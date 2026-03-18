import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as fs from "fs";
import * as path from "path";
import { config } from "../config";
import * as schema from "./schema";

function createDb() {
  const dbPath = path.resolve(config.dbPath);
  const dir = path.dirname(dbPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const client = createClient({ url: `file:${dbPath}` });
  const db = drizzle(client, { schema });
  return { db, client };
}

const { db, client } = createDb();
export { db, client };

export async function runMigrations(): Promise<void> {
  // Create tables if they don't exist (dev-mode schema sync)
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_id TEXT,
      discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      company_slug TEXT,
      url TEXT NOT NULL UNIQUE,
      apply_url TEXT,
      ats_platform TEXT,
      requires_account INTEGER DEFAULT 0,
      location TEXT,
      remote TEXT,
      salary_min INTEGER,
      salary_max INTEGER,
      salary_currency TEXT DEFAULT 'USD',
      employment_type TEXT,
      seniority_level TEXT,
      description TEXT,
      required_skills TEXT,
      preferred_skills TEXT,
      match_score REAL,
      match_reasoning TEXT,
      scored_at TEXT,
      status TEXT NOT NULL DEFAULT 'discovered',
      applied_at TEXT,
      notes TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      email TEXT NOT NULL,
      username TEXT,
      password_b64 TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      verified INTEGER DEFAULT 0,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      account_id TEXT REFERENCES accounts(id),
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT,
      submitted_at TEXT,
      confirmation_text TEXT,
      error_message TEXT,
      screenshot_path TEXT,
      notes TEXT
    );
  `);
}

export { schema };
