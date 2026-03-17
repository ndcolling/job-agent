import { z } from "zod";

export const JobListingSchema = z.object({
  title: z.string(),
  company: z.string(),
  companySlug: z.string().optional(),
  url: z.string().url(),
  applyUrl: z.string().url().optional(),
  source: z.enum(["greenhouse", "ashby", "wellfound", "yc", "builtin", "remotive"]),
  sourceId: z.string().optional(),
  location: z.string().optional(),
  remote: z.enum(["remote", "hybrid", "onsite"]).optional(),
  salaryMin: z.number().optional(),
  salaryMax: z.number().optional(),
  salaryCurrency: z.string().default("USD"),
  employmentType: z.string().optional(),
  description: z.string().optional(),
  postedAt: z.string().optional(), // ISO date string
});

export type JobListing = z.infer<typeof JobListingSchema>;

export interface SearchOptions {
  keywords?: string[];
  location?: string;
  remote?: boolean;
  limit?: number;
}

export interface JobSource {
  name: string;
  search(options: SearchOptions): Promise<JobListing[]>;
  getJobDetail(listing: JobListing): Promise<JobListing>;
}
