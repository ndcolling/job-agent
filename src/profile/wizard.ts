import Anthropic from "@anthropic-ai/sdk";
import * as p from "@clack/prompts";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { config } from "../config";
import {
  Contact,
  Education,
  Preferences,
  Profile,
  Project,
  WorkAuth,
  WorkExperience,
} from "./types";
import { profileExists, loadProfile, saveProfile } from "./store";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// ── Resume Parsing ────────────────────────────────────────────────────────────

async function parseResumeWithClaude(resumeText: string): Promise<{
  contact: Partial<Contact>;
  summary: string;
  skills: string[];
  workExperience: WorkExperience[];
  education: Education[];
  projects: Project[];
}> {
  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `Extract structured information from this resume. Return ONLY valid JSON matching this exact structure:

{
  "contact": {
    "firstName": string,
    "lastName": string,
    "email": string,
    "phone": string | null,
    "linkedinUrl": string | null,
    "githubUrl": string | null,
    "portfolioUrl": string | null,
    "city": string | null,
    "state": string | null
  },
  "summary": string,
  "skills": string[],
  "workExperience": [{
    "company": string,
    "title": string,
    "startDate": "YYYY-MM",
    "endDate": "YYYY-MM" | null,
    "current": boolean,
    "location": string | null,
    "remote": boolean | null,
    "description": string,
    "highlights": string[],
    "technologies": string[]
  }],
  "education": [{
    "institution": string,
    "degree": string,
    "field": string | null,
    "graduationYear": number | null
  }],
  "projects": [{
    "name": string,
    "description": string,
    "url": string | null,
    "repoUrl": string | null,
    "technologies": string[],
    "highlights": string[]
  }]
}

Resume:
${resumeText}`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ??
    text.match(/(\{[\s\S]*\})/);

  if (!jsonMatch) {
    throw new Error("Failed to parse resume: Claude did not return JSON");
  }

  return JSON.parse(jsonMatch[1]);
}

// ── Wizard Steps ──────────────────────────────────────────────────────────────

async function stepResume(): Promise<{
  resumePath: string;
  resumeText: string;
  parsed: Awaited<ReturnType<typeof parseResumeWithClaude>>;
}> {
  // Determine the data directory so we can hint the right path to the user
  const dataDir = path.resolve(
    path.dirname(config.profilePath)
  );

  p.note(
    `Place your resume in the data directory and reference it by filename:\n` +
      `  ${dataDir}/resume.pdf\n\n` +
      `Or provide any absolute path if running outside Docker.`,
    "Step 1: Resume"
  );

  const resumePath = await p.text({
    message: "Path to your resume (PDF or .txt):",
    placeholder: `${dataDir}/resume.pdf`,
    validate: (val) => {
      if (!val) return "Required";
      const resolved = resolvePath(String(val), dataDir);
      if (!fs.existsSync(resolved)) {
        return (
          `File not found: ${resolved}\n` +
          `  → Copy your resume to ${dataDir}/ and try again`
        );
      }
    },
  });

  if (p.isCancel(resumePath)) process.exit(0);

  const resolved = resolvePath(String(resumePath), dataDir);

  // Copy resume into data/ if it isn't already there (keeps it alongside the profile)
  const destPath = path.join(dataDir, path.basename(resolved));
  if (resolved !== destPath && !fs.existsSync(destPath)) {
    fs.copyFileSync(resolved, destPath);
    p.note(`Copied to ${destPath}`, "Resume");
  }
  const storedPath = fs.existsSync(destPath) ? destPath : resolved;

  let resumeText = "";

  if (resolved.endsWith(".pdf")) {
    const spin = p.spinner();
    spin.start("Extracting text from PDF...");
    try {
      const { execSync } = require("child_process") as typeof import("child_process");
      resumeText = execSync(`pdftotext "${resolved}" -`, { encoding: "utf-8" });
      spin.stop("PDF extracted");
    } catch {
      spin.stop("pdftotext not available");
      p.note(
        "Could not extract PDF text automatically.\n" +
          "For best results: save your resume as a .txt file alongside the PDF.",
        "Tip"
      );
      resumeText = `[PDF file: ${resolved} — paste resume text below if parsing fails]`;
    }
  } else {
    resumeText = fs.readFileSync(resolved, "utf-8");
  }

  const spin = p.spinner();
  spin.start("Parsing resume with Claude...");
  const parsed = await parseResumeWithClaude(resumeText);
  spin.stop("Resume parsed");

  return { resumePath: storedPath, resumeText, parsed };
}

/** Resolve a path: bare filename → relative to dataDir, otherwise standard. */
function resolvePath(input: string, dataDir: string): string {
  const expanded = input.replace(/^~/, process.env.HOME ?? "");
  // If no directory separator, assume it's a filename in the data dir
  if (!expanded.includes("/")) {
    return path.join(dataDir, expanded);
  }
  return path.resolve(expanded);
}

async function stepContact(prefill: Partial<Contact>): Promise<Contact> {
  p.note("Review and complete your contact information.", "Step 2: Contact");

  const firstName = await p.text({
    message: "First name:",
    initialValue: prefill.firstName ?? "",
    validate: (v) => (!v ? "Required" : undefined),
  });
  if (p.isCancel(firstName)) process.exit(0);

  const lastName = await p.text({
    message: "Last name:",
    initialValue: prefill.lastName ?? "",
    validate: (v) => (!v ? "Required" : undefined),
  });
  if (p.isCancel(lastName)) process.exit(0);

  const email = await p.text({
    message: "Email (used for applications):",
    initialValue: prefill.email ?? "",
    validate: (v) => (!v ? "Required" : undefined),
  });
  if (p.isCancel(email)) process.exit(0);

  const phone = await p.text({
    message: "Phone (optional):",
    initialValue: prefill.phone ?? "",
  });
  if (p.isCancel(phone)) process.exit(0);

  const linkedinUrl = await p.text({
    message: "LinkedIn URL (optional):",
    initialValue: prefill.linkedinUrl ?? "",
  });
  if (p.isCancel(linkedinUrl)) process.exit(0);

  const githubUrl = await p.text({
    message: "GitHub URL (optional):",
    initialValue: prefill.githubUrl ?? "",
  });
  if (p.isCancel(githubUrl)) process.exit(0);

  return {
    firstName: String(firstName),
    lastName: String(lastName),
    email: String(email),
    phone: phone ? String(phone) : undefined,
    linkedinUrl: linkedinUrl ? String(linkedinUrl) : undefined,
    githubUrl: githubUrl ? String(githubUrl) : undefined,
    country: "US",
  };
}

async function stepPreferences(): Promise<Preferences> {
  p.note("Tell us what you're looking for.", "Step 3: Job Preferences");

  const rolesRaw = await p.text({
    message: "Target roles (comma-separated):",
    placeholder: "Software Engineer, Full Stack Engineer, Backend Engineer",
    validate: (v) => (!v ? "Required" : undefined),
  });
  if (p.isCancel(rolesRaw)) process.exit(0);

  const seniority = await p.multiselect({
    message: "Seniority levels you'd consider:",
    options: [
      { value: "mid", label: "Mid-level" },
      { value: "senior", label: "Senior" },
      { value: "staff", label: "Staff" },
      { value: "principal", label: "Principal" },
      { value: "entry", label: "Entry-level" },
    ],
    required: true,
  });
  if (p.isCancel(seniority)) process.exit(0);

  const remote = await p.select({
    message: "Remote preference:",
    options: [
      { value: "remote-only", label: "Remote only" },
      { value: "hybrid-ok", label: "Hybrid is fine" },
      { value: "onsite-ok", label: "Onsite is fine" },
    ],
  });
  if (p.isCancel(remote)) process.exit(0);

  const salaryMinRaw = await p.text({
    message: "Minimum salary (USD/year, optional):",
    placeholder: "150000",
  });
  if (p.isCancel(salaryMinRaw)) process.exit(0);

  const industriesToAvoidRaw = await p.text({
    message: "Industries to avoid (comma-separated, optional):",
    placeholder: "gambling, defense, tobacco",
  });
  if (p.isCancel(industriesToAvoidRaw)) process.exit(0);

  return {
    roles: String(rolesRaw)
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean),
    seniorityLevels: seniority as Preferences["seniorityLevels"],
    remote: remote as Preferences["remote"],
    locations: [],
    salaryMin: salaryMinRaw
      ? parseInt(String(salaryMinRaw).replace(/\D/g, ""), 10)
      : undefined,
    companySizes: ["any"],
    industries: [],
    industriesToAvoid: industriesToAvoidRaw
      ? String(industriesToAvoidRaw)
          .split(",")
          .map((i) => i.trim())
          .filter(Boolean)
      : [],
    companiesBlacklist: [],
    employmentTypes: ["full-time"],
  };
}

async function stepWorkAuth(): Promise<WorkAuth> {
  p.note("Work authorization details.", "Step 4: Work Authorization");

  const authorized = await p.confirm({
    message: "Are you authorized to work in the US?",
    initialValue: true,
  });
  if (p.isCancel(authorized)) process.exit(0);

  const requiresSponsorship = await p.confirm({
    message: "Do you require visa sponsorship?",
    initialValue: false,
  });
  if (p.isCancel(requiresSponsorship)) process.exit(0);

  return {
    country: "US",
    authorized: Boolean(authorized),
    requiresSponsorship: Boolean(requiresSponsorship),
  };
}

async function stepProjects(prefill: Project[]): Promise<Project[]> {
  p.note(
    "Walk us through your key projects. These will be used to answer application questions.",
    "Step 5: Projects"
  );

  if (prefill.length > 0) {
    const keep = await p.confirm({
      message: `We found ${prefill.length} project(s) from your resume. Use them as a starting point?`,
      initialValue: true,
    });
    if (p.isCancel(keep)) process.exit(0);
    if (keep) {
      const addMore = await p.confirm({
        message: "Add more projects?",
        initialValue: false,
      });
      if (p.isCancel(addMore)) process.exit(0);
      if (!addMore) return prefill;
    }
  }

  const projects: Project[] = [...prefill];
  let addingProjects = true;

  while (addingProjects) {
    const name = await p.text({
      message: "Project name:",
      validate: (v) => (!v ? "Required" : undefined),
    });
    if (p.isCancel(name)) break;

    const description = await p.text({
      message: "Describe this project (what it does, your role, impact):",
      validate: (v) => (!v ? "Required" : undefined),
    });
    if (p.isCancel(description)) break;

    const techRaw = await p.text({
      message: "Technologies used (comma-separated):",
    });
    if (p.isCancel(techRaw)) break;

    const url = await p.text({ message: "Project URL (optional):" });
    if (p.isCancel(url)) break;

    const repoUrl = await p.text({ message: "Repo URL (optional):" });
    if (p.isCancel(repoUrl)) break;

    projects.push({
      name: String(name),
      description: String(description),
      technologies: techRaw
        ? String(techRaw)
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
      url: url ? String(url) : undefined,
      repoUrl: repoUrl ? String(repoUrl) : undefined,
      highlights: [],
    });

    const another = await p.confirm({
      message: "Add another project?",
      initialValue: false,
    });
    if (p.isCancel(another) || !another) addingProjects = false;
  }

  return projects;
}

async function stepInterests(prefill?: {
  areas: string[];
  narrative?: string;
}): Promise<{ areas: string[]; narrative?: string }> {
  p.note(
    "Personal interests help us craft authentic applications for domain-fit roles\n" +
      "(e.g. your passion for fitness is directly relevant to a sports-tech startup).",
    "Step 6: Personal Interests"
  );

  const areasRaw = await p.text({
    message: "Areas you're personally passionate about (comma-separated):",
    placeholder: "health, longevity, fitness, AI, open source",
    initialValue: prefill?.areas.join(", ") ?? "",
  });
  if (p.isCancel(areasRaw)) process.exit(0);

  const narrative = await p.text({
    message:
      "In 2-3 sentences, describe yourself beyond your resume — hobbies, lifestyle, what drives you:",
    placeholder:
      "I train 5 days a week and have competed in obstacle races. I'm obsessed with performance data and longevity science...",
    initialValue: prefill?.narrative ?? "",
  });
  if (p.isCancel(narrative)) process.exit(0);

  return {
    areas: String(areasRaw)
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean),
    narrative: narrative ? String(narrative) : undefined,
  };
}

// ── Main Wizard Entry ─────────────────────────────────────────────────────────

export async function runWizard(): Promise<void> {
  console.log();
  p.intro(chalk.bold("Job Agent — Profile Setup"));

  const isUpdate = profileExists();
  if (isUpdate) {
    const proceed = await p.confirm({
      message:
        "A profile already exists. Update it? (existing data will be preserved where not overwritten)",
      initialValue: true,
    });
    if (p.isCancel(proceed) || !proceed) {
      p.outro("No changes made.");
      return;
    }
  }

  const existing = isUpdate ? loadProfile() : null;

  // Step 1: Resume
  const { resumePath, resumeText, parsed } = await stepResume();

  // Step 2: Contact
  const contact = await stepContact(
    existing?.contact ?? parsed.contact
  );

  // Step 3: Preferences
  const preferences = await stepPreferences();

  // Step 4: Work auth
  const workAuth = await stepWorkAuth();

  // Step 5: Projects
  const projects = await stepProjects(
    existing?.projects?.length ? existing.projects : parsed.projects
  );

  // Step 6: Interests
  const interests = await stepInterests(existing?.interests);

  // Assemble profile
  const now = new Date().toISOString();
  const profile: Profile = {
    version: 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    contact,
    summary: parsed.summary || existing?.summary || "",
    skills: parsed.skills.length ? parsed.skills : existing?.skills ?? [],
    workExperience: parsed.workExperience.length
      ? parsed.workExperience
      : existing?.workExperience ?? [],
    projects,
    education: parsed.education.length
      ? parsed.education
      : existing?.education ?? [],
    preferences,
    workAuth,
    resumePath,
    resumeText,
    qaBank: existing?.qaBank ?? {},
    interests,
  };

  saveProfile(profile);

  p.note(
    `Profile saved to ${config.profilePath}\n\n` +
      `  ${chalk.green("✓")} ${profile.workExperience.length} work experiences\n` +
      `  ${chalk.green("✓")} ${profile.projects.length} projects\n` +
      `  ${chalk.green("✓")} ${profile.skills.length} skills extracted\n` +
      `  ${chalk.green("✓")} ${profile.education.length} education entries`,
    "Profile saved"
  );

  p.outro(
    chalk.bold("All done! Run ") +
      chalk.cyan("npm run dev search") +
      chalk.bold(" to start finding jobs.")
  );
}
