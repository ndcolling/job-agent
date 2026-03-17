import { JobListing, JobSource, SearchOptions } from "./types";

// Curated list of companies known to use Greenhouse.
// Add more as you discover them.
const GREENHOUSE_COMPANIES: string[] = [
  "airbnb",
  "stripe",
  "figma",
  "notion",
  "linear",
  "vercel",
  "netlify",
  "discord",
  "duolingo",
  "brex",
  "ramp",
  "rippling",
  "lattice",
  "gusto",
  "retool",
  "airtable",
  "webflow",
  "pitch",
  "loom",
  "miro",
];

interface GreenhouseJob {
  id: number;
  title: string;
  updated_at: string;
  location: { name: string };
  absolute_url: string;
  content?: string; // HTML job description, present when content=true
  metadata?: unknown[];
  departments: { name: string }[];
}

interface GreenhouseResponse {
  jobs: GreenhouseJob[];
}

export class GreenhouseSource implements JobSource {
  readonly name = "greenhouse";

  private async fetchCompanyJobs(companySlug: string): Promise<JobListing[]> {
    const url = `https://boards-api.greenhouse.io/v1/boards/${companySlug}/jobs?content=true`;

    let data: GreenhouseResponse;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "JobAgent/1.0" },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        if (res.status === 404) return []; // company not on greenhouse
        throw new Error(`Greenhouse API error: ${res.status}`);
      }

      data = (await res.json()) as GreenhouseResponse;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ABORT_ERR") {
        console.warn(`Timeout fetching ${companySlug} from Greenhouse`);
        return [];
      }
      throw err;
    }

    return data.jobs.map((job): JobListing => {
      const location = job.location?.name ?? "";
      const isRemote =
        location.toLowerCase().includes("remote") ? "remote" :
        location.toLowerCase().includes("hybrid") ? "hybrid" :
        "onsite";

      return {
        title: job.title,
        company: companySlug, // will be enriched by getJobDetail
        companySlug,
        url: job.absolute_url,
        applyUrl: job.absolute_url,
        source: "greenhouse",
        sourceId: String(job.id),
        location,
        remote: isRemote,
        description: job.content
          ? stripHtml(job.content).slice(0, 5000)
          : undefined,
        postedAt: job.updated_at,
        salaryCurrency: "USD",
      };
    });
  }

  async search(options: SearchOptions): Promise<JobListing[]> {
    const { keywords = [], remote, limit } = options;

    const results: JobListing[] = [];

    // Fetch in parallel with concurrency limit
    const BATCH = 5;
    for (let i = 0; i < GREENHOUSE_COMPANIES.length; i += BATCH) {
      const batch = GREENHOUSE_COMPANIES.slice(i, i + BATCH);
      const batchResults = await Promise.all(
        batch.map((slug) => this.fetchCompanyJobs(slug))
      );
      results.push(...batchResults.flat());
    }

    // Filter by keywords and remote preference
    let filtered = results;

    if (keywords.length > 0) {
      const kws = keywords.map((k) => k.toLowerCase());
      filtered = filtered.filter((job) => {
        const haystack = `${job.title} ${job.description ?? ""}`.toLowerCase();
        return kws.some((kw) => haystack.includes(kw));
      });
    }

    if (remote) {
      filtered = filtered.filter((job) => job.remote === "remote");
    }

    return limit ? filtered.slice(0, limit) : filtered;
  }

  async getJobDetail(listing: JobListing): Promise<JobListing> {
    // Greenhouse API includes content already — nothing more to fetch
    return listing;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
