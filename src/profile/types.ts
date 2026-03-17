import { z } from "zod";

export const WorkExperienceSchema = z.object({
  company: z.string(),
  title: z.string(),
  startDate: z.string(), // YYYY-MM
  endDate: z.string().optional(), // YYYY-MM or undefined = current
  current: z.boolean().default(false),
  location: z.string().optional(),
  remote: z.boolean().optional(),
  description: z.string(), // raw text from resume
  highlights: z.array(z.string()).default([]), // bullet points
  technologies: z.array(z.string()).default([]),
});

export const ProjectSchema = z.object({
  name: z.string(),
  description: z.string(),
  url: z.string().optional(),
  repoUrl: z.string().optional(),
  technologies: z.array(z.string()).default([]),
  highlights: z.array(z.string()).default([]),
});

export const EducationSchema = z.object({
  institution: z.string(),
  degree: z.string(),
  field: z.string().optional(),
  graduationYear: z.number().optional(),
  gpa: z.number().optional(),
});

export const PreferencesSchema = z.object({
  roles: z.array(z.string()), // e.g. ["Software Engineer", "Full Stack Engineer"]
  seniorityLevels: z.array(
    z.enum(["entry", "mid", "senior", "staff", "principal", "any"])
  ),
  remote: z.enum(["remote-only", "hybrid-ok", "onsite-ok"]),
  locations: z.array(z.string()), // city names, ignored if remote-only
  salaryMin: z.number().optional(), // USD annual
  companySizes: z
    .array(z.enum(["startup", "mid-size", "enterprise", "any"]))
    .default(["any"]),
  industries: z.array(z.string()).default([]), // preferred industries
  industriesToAvoid: z.array(z.string()).default([]),
  companiesBlacklist: z.array(z.string()).default([]),
  employmentTypes: z
    .array(z.enum(["full-time", "contract", "part-time"]))
    .default(["full-time"]),
});

export const WorkAuthSchema = z.object({
  country: z.string().default("US"),
  authorized: z.boolean(),
  requiresSponsorship: z.boolean(),
  citizenshipStatus: z.string().optional(), // citizen | permanent-resident | visa-holder | etc.
});

export const ContactSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().email(),
  phone: z.string().optional(),
  linkedinUrl: z.string().optional(),
  githubUrl: z.string().optional(),
  portfolioUrl: z.string().optional(),
  websiteUrl: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().default("US"),
});

// Bank of pre-written answers to common application questions.
// Keyed by a question pattern, value is the answer.
export const QABankSchema = z.record(z.string(), z.string());

export const ProfileSchema = z.object({
  version: z.number().default(1),
  createdAt: z.string(),
  updatedAt: z.string(),

  contact: ContactSchema,
  summary: z.string(), // professional summary / elevator pitch
  skills: z.array(z.string()), // flat list of all skills
  workExperience: z.array(WorkExperienceSchema),
  projects: z.array(ProjectSchema).default([]),
  education: z.array(EducationSchema).default([]),
  preferences: PreferencesSchema,
  workAuth: WorkAuthSchema,

  resumePath: z.string().optional(), // path to PDF on disk
  resumeText: z.string().optional(), // extracted plain text (used for scoring)

  qaBank: QABankSchema.default({}),

  // Personal interests and passion areas — used to surface domain fit
  // in applications (e.g. health/fitness for a sports-tech role)
  interests: z
    .object({
      areas: z.array(z.string()).default([]), // e.g. ["health", "longevity", "fitness", "AI"]
      narrative: z.string().optional(), // 2-3 sentences the user wrote about themselves personally
    })
    .default({ areas: [] }),

  // Demographic fields (optional, user sets defaults for voluntary disclosures)
  demographics: z
    .object({
      gender: z.string().optional(),
      ethnicity: z.string().optional(),
      veteran: z.boolean().optional(),
      disability: z.boolean().optional(),
    })
    .optional(),
});

export type WorkExperience = z.infer<typeof WorkExperienceSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type Education = z.infer<typeof EducationSchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;
export type WorkAuth = z.infer<typeof WorkAuthSchema>;
export type Contact = z.infer<typeof ContactSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type QABank = z.infer<typeof QABankSchema>;
