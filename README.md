# Job Agent

An AI-powered job search and application agent built with TypeScript, Playwright, and Claude. It searches targeted job boards, scores listings against your profile, and helps draft application materials — all from the command line.

## Features

- **Profile wizard** — conversational onboarding that parses your resume and builds a structured profile
- **Multi-source search** — queries Greenhouse and Ashby public APIs (covers hundreds of startups and VC-backed companies)
- **AI scoring** — Claude scores each job against your skills, preferences, and experience
- **Pipeline management** — SQLite-backed job queue with status tracking (discovered → scored → approved → applied)
- **Cover letter drafting** — tailored cover letters and application question answers generated from your profile
- **Cloud-ready** — swap local Playwright for [BrowserBase](https://browserbase.com) with a single env var for serverless deployment

## Stack

- **Runtime**: Node 22 (via nvm)
- **Package manager**: pnpm
- **Language**: TypeScript (strict)
- **AI**: Claude via `@anthropic-ai/sdk`
- **Browser automation**: Playwright
- **Database**: SQLite via Drizzle ORM
- **CLI**: Commander

## Getting Started

### Prerequisites

- [nvm](https://github.com/nvm-sh/nvm)
- [pnpm](https://pnpm.io/installation)
- An [Anthropic API key](https://console.anthropic.com/)

### Setup

```bash
# Use the correct Node version
nvm use

# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
```

### Install Playwright browser

```bash
pnpm exec playwright install chromium
```

### Build your profile

Run the wizard — it parses your resume and asks about your preferences:

```bash
pnpm dev wizard
```

## Usage

```bash
# Search for matching jobs and score them
pnpm dev search

# Search with options
pnpm dev search --min-score 70 --sources greenhouse,ashby --remote-only

# Review scored jobs
pnpm dev list --status scored

# Approve or skip a job
pnpm dev approve <jobId>
pnpm dev skip <jobId>

# Draft a cover letter
pnpm dev draft <jobId>
pnpm dev draft <jobId> --tone conversational

# Ask the agent anything
pnpm dev ask "find me senior backend roles at YC companies"
```

## Pipeline Status Flow

```
discovered → scored → approved | skipped → applying → applied
                                                     → interviewing | rejected | ghosted | offer
```

## Configuration

All configuration is via environment variables. See `.env.example` for the full list.

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Required. Your Anthropic API key. |
| `BROWSER_MODE` | `local` (default) or `browserbase` |
| `BROWSERBASE_API_KEY` | Required if `BROWSER_MODE=browserbase` |
| `BROWSERBASE_PROJECT_ID` | Required if `BROWSER_MODE=browserbase` |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | Optional. Sync job pipeline to a Google Sheet. |
| `DB_PATH` | Path to SQLite database. Default: `./data/jobs.db` |
| `PROFILE_PATH` | Path to profile JSON. Default: `./data/profile.json` |

## Adding More Companies

Edit the company slug lists in `src/search/greenhouse.ts` and `src/search/ashby.ts`:

```ts
// src/search/greenhouse.ts
const GREENHOUSE_COMPANIES: string[] = [
  "stripe",
  "your-company-slug", // add here
];
```

Company slugs match their job board URLs:
- `https://boards.greenhouse.io/{slug}/jobs`
- `https://jobs.ashby.com/{slug}`

## Cloud Deployment

The agent is designed to run locally on demand. To deploy to AWS Lambda:

1. Set `BROWSER_MODE=browserbase` and configure BrowserBase credentials
2. Non-browser tasks (search, scoring, sheet sync) run natively in Lambda
3. Browser tasks connect to BrowserBase's remote browser infrastructure

## Project Structure

```
src/
├── cli.ts              # CLI entry point (Commander)
├── config.ts           # Environment config (Zod)
├── db/
│   ├── schema.ts       # Drizzle schema (jobs, accounts, applications)
│   └── client.ts       # SQLite client
├── profile/
│   ├── types.ts        # Profile Zod schema
│   ├── store.ts        # Profile read/write
│   └── wizard.ts       # Onboarding wizard
├── search/
│   ├── greenhouse.ts   # Greenhouse public API
│   ├── ashby.ts        # Ashby public API
│   └── scorer.ts       # Claude-based job scoring
├── apply/
│   └── browser.ts      # Playwright session factory
└── agent/
    ├── tools.ts        # Claude tool definitions
    └── orchestrator.ts # Agent loop
```

## License

MIT
