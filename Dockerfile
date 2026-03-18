# ── Base ──────────────────────────────────────────────────────────────────────
# Playwright image includes Chromium + all browser system deps out of the box.
# Pinned to match the playwright package version in package.json.
FROM mcr.microsoft.com/playwright:v1.50.0-noble AS base

RUN npm install -g pnpm@10.14.0 && \
    apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Dependencies ──────────────────────────────────────────────────────────────
FROM base AS deps

COPY package.json .npmrc ./
# @libsql/client is pure JS — no native compilation needed
RUN pnpm install

# ── Development (default for local use) ───────────────────────────────────────
FROM deps AS dev

COPY tsconfig.json drizzle.config.ts ./
COPY src/ ./src/

# data/ is mounted at runtime — profile.json, jobs.db, and resume live here
VOLUME ["/app/data"]

ENTRYPOINT ["pnpm", "dev"]
CMD ["--help"]
