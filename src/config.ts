import * as dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const configSchema = z.object({
  anthropicApiKey: z.string().min(1, "ANTHROPIC_API_KEY is required"),

  browserMode: z.enum(["local", "browserbase"]).default("local"),
  browserbaseApiKey: z.string().optional(),
  browserbaseProjectId: z.string().optional(),

  googleSheetsSpreadsheetId: z.string().optional(),
  googleServiceAccountKeyPath: z.string().optional(),

  dbPath: z.string().default("./data/jobs.db"),
  profilePath: z.string().default("./data/profile.json"),

  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

function loadConfig() {
  const result = configSchema.safeParse({
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    browserMode: process.env.BROWSER_MODE,
    browserbaseApiKey: process.env.BROWSERBASE_API_KEY,
    browserbaseProjectId: process.env.BROWSERBASE_PROJECT_ID,
    googleSheetsSpreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
    googleServiceAccountKeyPath: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
    dbPath: process.env.DB_PATH,
    profilePath: process.env.PROFILE_PATH,
    logLevel: process.env.LOG_LEVEL,
  });

  if (!result.success) {
    console.error("Invalid configuration:");
    result.error.issues.forEach((issue) => {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    });
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
export type Config = typeof config;
