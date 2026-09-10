import { isAbsolute, normalize } from "node:path";
import { z } from "zod";

const promptProfileIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, digits, '-' or '_'.");

export const projectProfileSchema = z
  .object({
    projectDirectory: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .refine((value) => isAbsolute(value), {
        message: "Project profile directory must be an absolute path.",
      }),
    promptProfileId: promptProfileIdSchema,
  })
  .strict();

export type ProjectProfile = z.infer<typeof projectProfileSchema>;
export type ProjectProfileInput = z.input<typeof projectProfileSchema>;

export function parseProjectProfile(input: unknown): ProjectProfile {
  const parsed = projectProfileSchema.parse(input);
  return {
    ...parsed,
    projectDirectory: normalize(parsed.projectDirectory),
  };
}

export function projectDirectoryKey(
  projectDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = normalize(projectDirectory);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
