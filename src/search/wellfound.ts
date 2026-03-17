import { Page } from "playwright";
import { createBrowserSession, humanDelay } from "../apply/browser";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ApplicationMethod = "wellfound-form" | "email" | "external" | "unknown";

export interface WellfoundFormQuestion {
  label: string;
  type: "text" | "textarea" | "select" | "checkbox";
  required: boolean;
  options?: string[]; // for select
  selector: string; // playwright selector to target the field
}

export interface WellfoundJob {
  title: string;
  company: string;
  companyUrl: string | null;
  location: string | null;
  remote: boolean;
  compensation: string | null;
  jobType: string | null; // full-time, contract, etc.
  description: string;
  url: string;

  applicationMethod: ApplicationMethod;

  // wellfound-form
  hasIntroField: boolean; // the "introduce yourself" textarea
  formQuestions: WellfoundFormQuestion[];

  // email
  emailAddress: string | null;
  emailInstructions: string | null;

  // external
  externalUrl: string | null;
}

// ── Scraper ───────────────────────────────────────────────────────────────────

export async function scrapeWellfoundJob(url: string): Promise<WellfoundJob> {
  const session = await createBrowserSession({ headless: true });

  try {
    return await _scrape(session.page, url);
  } finally {
    await session.close();
  }
}

async function _scrape(page: Page, url: string): Promise<WellfoundJob> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await humanDelay(1500, 2500);

  // Wellfound is a React SPA — wait for meaningful content
  await page
    .waitForSelector('h1, [data-test="JobListingTitle"], .job-listing-title', {
      timeout: 15_000,
    })
    .catch(() => null);

  await humanDelay(800, 1200);

  // ── Core job info ──────────────────────────────────────────────────────────

  const title = await firstText(page, [
    '[data-test="JobListingTitle"]',
    ".job-listing-title",
    "h1",
  ]);

  const company = await firstText(page, [
    '[data-test="StartupName"]',
    ".startup-name",
    'a[href*="/company/"] span',
    'a[href*="/jobs/"] ~ * span',
  ]);

  const companyUrl = await firstHref(page, [
    '[data-test="StartupLink"]',
    'a[href*="/company/"]',
  ]);

  const location = await firstText(page, [
    '[data-test="JobListingLocation"]',
    ".job-listing-location",
    '[class*="location"]',
  ]);

  const remote =
    (location?.toLowerCase().includes("remote") ||
      (await page
        .locator('text=/remote/i')
        .first()
        .isVisible()
        .catch(() => false))) ??
    false;

  const compensation = await firstText(page, [
    '[data-test="JobListingCompensation"]',
    '[class*="compensation"]',
    '[class*="salary"]',
  ]);

  const jobType = await firstText(page, [
    '[data-test="JobListingType"]',
    '[class*="job-type"]',
    '[class*="employment-type"]',
  ]);

  // ── Description ───────────────────────────────────────────────────────────

  const description = await extractDescription(page);

  // ── Application method detection ──────────────────────────────────────────

  const { method, emailAddress, emailInstructions, externalUrl } =
    await detectApplicationMethod(page);

  // ── Form questions (if wellfound-form) ────────────────────────────────────

  let formQuestions: WellfoundFormQuestion[] = [];
  let hasIntroField = false;

  if (method === "wellfound-form") {
    ({ questions: formQuestions, hasIntroField } =
      await extractFormQuestions(page));
  }

  return {
    title: title ?? "Unknown Role",
    company: company ?? "Unknown Company",
    companyUrl: companyUrl ?? null,
    location: location ?? null,
    remote,
    compensation: compensation ?? null,
    jobType: jobType ?? null,
    description,
    url,
    applicationMethod: method,
    hasIntroField,
    formQuestions,
    emailAddress: emailAddress ?? null,
    emailInstructions: emailInstructions ?? null,
    externalUrl: externalUrl ?? null,
  };
}

// ── Application Method Detection ──────────────────────────────────────────────

async function detectApplicationMethod(page: Page): Promise<{
  method: ApplicationMethod;
  emailAddress: string | null;
  emailInstructions: string | null;
  externalUrl: string | null;
}> {
  // 1. Check for Wellfound native form — look for the intro textarea or apply form
  const hasForm = await page
    .locator(
      'form[class*="apply"], [data-test*="apply"] form, textarea[placeholder*="introduc"], textarea[placeholder*="yourself"]'
    )
    .first()
    .isVisible()
    .catch(() => false);

  if (hasForm) {
    return { method: "wellfound-form", emailAddress: null, emailInstructions: null, externalUrl: null };
  }

  // 2. Check for "Apply on company website" or similar external link
  const externalApplyBtn = await page
    .locator(
      'a[href*="http"]:has-text("Apply"), a:has-text("Apply on company website"), a:has-text("Apply on their website")'
    )
    .first();

  const externalHref = await externalApplyBtn
    .getAttribute("href")
    .catch(() => null);

  if (externalHref && !externalHref.includes("wellfound.com")) {
    return { method: "external", emailAddress: null, emailInstructions: null, externalUrl: externalHref };
  }

  // 3. Check for email address in the page content
  const pageText = await page.locator("body").innerText().catch(() => "");
  const emailMatch = pageText.match(/[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}/);

  if (emailMatch) {
    // Extract surrounding context as "instructions"
    const emailIdx = pageText.indexOf(emailMatch[0]);
    const instructions = pageText
      .slice(Math.max(0, emailIdx - 300), emailIdx + 300)
      .trim();

    return {
      method: "email",
      emailAddress: emailMatch[0],
      emailInstructions: instructions,
      externalUrl: null,
    };
  }

  // 4. Check for an Apply button that reveals a form on click
  const applyBtn = await page
    .locator('button:has-text("Apply"), [data-test="ApplyButton"]')
    .first();

  const btnVisible = await applyBtn.isVisible().catch(() => false);
  if (btnVisible) {
    await applyBtn.click().catch(() => null);
    await humanDelay(800, 1200);

    // Re-check for form after click
    const formAfterClick = await page
      .locator('textarea[placeholder*="introduc"], textarea[placeholder*="yourself"], form[class*="apply"]')
      .first()
      .isVisible()
      .catch(() => false);

    if (formAfterClick) {
      return { method: "wellfound-form", emailAddress: null, emailInstructions: null, externalUrl: null };
    }
  }

  return { method: "unknown", emailAddress: null, emailInstructions: null, externalUrl: null };
}

// ── Form Question Extraction ───────────────────────────────────────────────────

async function extractFormQuestions(page: Page): Promise<{
  questions: WellfoundFormQuestion[];
  hasIntroField: boolean;
}> {
  const questions: WellfoundFormQuestion[] = [];
  let hasIntroField = false;

  // Check for intro/cover note textarea
  const introSelectors = [
    'textarea[placeholder*="introduc"]',
    'textarea[placeholder*="yourself"]',
    'textarea[placeholder*="cover"]',
    'textarea[name*="intro"]',
    'textarea[name*="note"]',
  ];

  for (const sel of introSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      hasIntroField = true;
      break;
    }
  }

  // Extract labeled form fields (custom questions from the company)
  const formGroups = await page.locator('[class*="question"], [class*="form-group"], fieldset').all();

  for (const group of formGroups) {
    const label = await group
      .locator('label, [class*="label"], p, legend')
      .first()
      .innerText()
      .catch(() => null);

    if (!label || label.trim().length < 3) continue;

    // Detect field type
    const hasTextarea = await group.locator("textarea").count();
    const hasInput = await group.locator('input[type="text"], input[type="email"]').count();
    const hasSelect = await group.locator("select").count();
    const hasCheckbox = await group.locator('input[type="checkbox"]').count();

    let type: WellfoundFormQuestion["type"] = "text";
    let selector = "";

    if (hasTextarea > 0) {
      type = "textarea";
      selector = await group
        .locator("textarea")
        .first()
        .getAttribute("id")
        .then((id) => (id ? `#${id}` : "textarea"))
        .catch(() => "textarea");
    } else if (hasSelect > 0) {
      type = "select";
      selector = "select";
      const options = await group
        .locator("option")
        .allInnerTexts()
        .catch(() => []);
      questions.push({ label: label.trim(), type, required: true, options, selector });
      continue;
    } else if (hasCheckbox > 0) {
      type = "checkbox";
      selector = 'input[type="checkbox"]';
    } else if (hasInput > 0) {
      type = "text";
      selector = 'input[type="text"]';
    } else {
      continue;
    }

    questions.push({ label: label.trim(), type, required: true, selector });
  }

  return { questions, hasIntroField };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function extractDescription(page: Page): Promise<string> {
  const descSelectors = [
    '[data-test="JobListingDescription"]',
    '[class*="job-description"]',
    '[class*="description"]',
    'article',
    '[class*="content"]',
  ];

  for (const sel of descSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      const text = await el.innerText().catch(() => null);
      if (text && text.length > 100) return text.slice(0, 8000);
    }
  }

  // Fallback: grab the largest text block
  const body = await page.locator("main, body").first().innerText().catch(() => "");
  return body.slice(0, 8000);
}

async function firstText(page: Page, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        const text = await el.innerText();
        if (text?.trim()) return text.trim();
      }
    } catch {
      // try next
    }
  }
  return null;
}

async function firstHref(page: Page, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        const href = await el.getAttribute("href");
        if (href) return href;
      }
    } catch {
      // try next
    }
  }
  return null;
}
