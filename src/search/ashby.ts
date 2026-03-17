import { JobListing, JobSource, SearchOptions } from "./types";

// Companies known to use Ashby — heavily skews YC/a16z portfolio
const ASHBY_COMPANIES: string[] = [
  "openai",
  "anthropic",
  "perplexity",
  "cursor",
  "replit",
  "supabase",
  "planetscale",
  "railway",
  "fly",
  "modal",
  "prefect",
  "dagster",
  "dbt-labs",
  "hex",
  "evidence",
  "posthog",
  "cal",
  "clerk",
  "resend",
  "loops",
];

interface AshbyJob {
  id: string;
  title: string;
  locationName: string;
  isRemote: boolean;
  publishedDate: string;
  jobUrl: string;
  descriptionHtml?: string;
  compensationTierSummary?: string;
}

interface AshbyApiResponse {
  jobs: AshbyJob[];
}

export class AshbySource implements JobSource {
  readonly name = "ashby";

  private async fetchCompanyJobs(companySlug: string): Promise<JobListing[]> {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${companySlug}`;

    let data: AshbyApiResponse;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "JobAgent/1.0" },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        if (res.status === 404) return [];
        throw new Error(`Ashby API error ${res.status} for ${companySlug}`);
      }

      data = (await res.json()) as AshbyApiResponse;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ABORT_ERR") {
        console.warn(`Timeout fetching ${companySlug} from Ashby`);
        return [];
      }
      return [];
    }

    return (data.jobs ?? []).map((job): JobListing => {
      const remote = job.isRemote
        ? "remote"
        : job.locationName?.toLowerCase().includes("hybrid")
          ? "hybrid"
          : "onsite";

      return {
        title: job.title,
        company: companySlug,
        companySlug,
        url: job.jobUrl,
        applyUrl: job.jobUrl,
        source: "ashby",
        sourceId: job.id,
        location: job.locationName,
        remote,
        description: job.descriptionHtml
          ? stripHtml(job.descriptionHtml).slice(0, 5000)
          : undefined,
        postedAt: job.publishedDate,
        salaryCurrency: "USD",
      };
    });
  }

  async search(options: SearchOptions): Promise<JobListing[]> {
    const { keywords = [], remote, limit } = options;

    const results: JobListing[] = [];

    const BATCH = 5;
    for (let i = 0; i < ASHBY_COMPANIES.length; i += BATCH) {
      const batch = ASHBY_COMPANIES.slice(i, i + BATCH);
      const batchResults = await Promise.all(
        batch.map((slug) => this.fetchCompanyJobs(slug))
      );
      results.push(...batchResults.flat());
    }

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
