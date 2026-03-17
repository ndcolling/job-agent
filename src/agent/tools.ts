import Anthropic from "@anthropic-ai/sdk";

// All tool definitions used by the orchestrator agent.
// Keeping them in one place makes it easy to version and extend.

export const tools: Anthropic.Tool[] = [
  {
    name: "search_greenhouse",
    description:
      "Search for open jobs at companies that use Greenhouse as their ATS. " +
      "Returns a list of job listings matching the given keywords.",
    input_schema: {
      type: "object" as const,
      properties: {
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "Search keywords derived from the user profile (role titles, skills, etc.)",
        },
        remoteOnly: {
          type: "boolean",
          description: "If true, only return remote-eligible positions",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default 50)",
        },
      },
      required: ["keywords"],
    },
  },
  {
    name: "search_ashby",
    description:
      "Search for open jobs at companies that use Ashby as their ATS. " +
      "Ashby is popular with YC and a16z portfolio companies.",
    input_schema: {
      type: "object" as const,
      properties: {
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "Search keywords",
        },
        remoteOnly: {
          type: "boolean",
          description: "If true, only return remote-eligible positions",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default 50)",
        },
      },
      required: ["keywords"],
    },
  },
  {
    name: "score_and_save_jobs",
    description:
      "Score a batch of job listings against the user profile and save them to the database. " +
      "Only saves jobs above the minimum score threshold.",
    input_schema: {
      type: "object" as const,
      properties: {
        jobUrls: {
          type: "array",
          items: { type: "string" },
          description: "URLs of the job listings to score and save",
        },
        minScore: {
          type: "number",
          description: "Minimum match score (0-100) to save. Default is 60.",
        },
      },
      required: ["jobUrls"],
    },
  },
  {
    name: "list_approved_jobs",
    description:
      "List all jobs in the database that have been approved for application by the user.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Max results to return",
        },
      },
    },
  },
  {
    name: "get_job_details",
    description: "Get full details for a specific job by its ID or URL.",
    input_schema: {
      type: "object" as const,
      properties: {
        jobId: {
          type: "string",
          description: "The job ID from the database",
        },
      },
      required: ["jobId"],
    },
  },
  {
    name: "draft_cover_letter",
    description:
      "Draft a tailored cover letter for a specific job using the user's profile and the job description. " +
      "Returns the draft text for user review before use.",
    input_schema: {
      type: "object" as const,
      properties: {
        jobId: {
          type: "string",
          description: "The job ID to draft a cover letter for",
        },
        tone: {
          type: "string",
          enum: ["professional", "conversational", "technical"],
          description: "Tone of the cover letter",
        },
      },
      required: ["jobId"],
    },
  },
  {
    name: "draft_answer",
    description:
      "Draft an answer to a specific application question for a job. " +
      "Used when an application form has custom questions.",
    input_schema: {
      type: "object" as const,
      properties: {
        jobId: {
          type: "string",
          description: "The job ID this question belongs to",
        },
        question: {
          type: "string",
          description: "The exact question text from the application form",
        },
        maxLength: {
          type: "number",
          description: "Maximum character/word limit for the answer, if specified",
        },
      },
      required: ["jobId", "question"],
    },
  },
  {
    name: "update_job_status",
    description: "Update the status of a job in the database.",
    input_schema: {
      type: "object" as const,
      properties: {
        jobId: {
          type: "string",
          description: "The job ID to update",
        },
        status: {
          type: "string",
          enum: [
            "discovered",
            "scored",
            "approved",
            "skipped",
            "applying",
            "applied",
            "interviewing",
            "rejected",
            "ghosted",
            "offer",
          ],
          description: "New status",
        },
        notes: {
          type: "string",
          description: "Optional notes about the status change",
        },
      },
      required: ["jobId", "status"],
    },
  },
  {
    name: "get_profile_summary",
    description:
      "Get a summary of the current user profile including skills, experience, and preferences.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
];

export type ToolName = (typeof tools)[number]["name"];
