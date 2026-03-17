import * as fs from "fs";
import * as path from "path";
import { config } from "../config";
import { Profile, ProfileSchema } from "./types";

const profilePath = path.resolve(config.profilePath);

export function profileExists(): boolean {
  return fs.existsSync(profilePath);
}

export function loadProfile(): Profile {
  if (!profileExists()) {
    throw new Error(
      `No profile found at ${profilePath}. Run 'npm run dev wizard' to create one.`
    );
  }

  const raw = fs.readFileSync(profilePath, "utf-8");
  const parsed = ProfileSchema.safeParse(JSON.parse(raw));

  if (!parsed.success) {
    throw new Error(
      `Profile file is invalid:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`
    );
  }

  return parsed.data;
}

export function saveProfile(profile: Profile): void {
  const dir = path.dirname(profilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const updated: Profile = {
    ...profile,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(profilePath, JSON.stringify(updated, null, 2), "utf-8");
}

export function updateProfile(updates: Partial<Profile>): Profile {
  const current = loadProfile();
  const merged = { ...current, ...updates };
  saveProfile(merged);
  return merged;
}
