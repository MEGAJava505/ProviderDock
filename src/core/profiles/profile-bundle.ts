import { z } from "zod";
import {
  logicalModelGroupSchema,
  type LogicalModelGroup,
} from "../fallback/logical-model.js";
import {
  providerProfileSchema,
  type ProviderProfile,
} from "../providers/provider-profile.js";
import {
  projectDirectoryKey,
  projectProfileSchema,
  parseProjectProfile,
  type ProjectProfile,
} from "./project-profile.js";
import {
  promptProfileSchema,
  type PromptProfile,
} from "./prompt-profile.js";

const bundleFormat = "providerdock-profile-bundle" as const;
const bundleVersion = 1 as const;

const profileBundleSchema = z
  .object({
    format: z.literal(bundleFormat),
    version: z.literal(bundleVersion),
    exportedAt: z.string().datetime(),
    providers: z.array(providerProfileSchema).max(512),
    logicalModels: z.array(logicalModelGroupSchema).max(512),
    promptProfiles: z.array(promptProfileSchema).max(512),
    projectProfiles: z.array(projectProfileSchema).max(2_048),
  })
  .strict()
  .superRefine((bundle, context) => {
    checkUniqueIds(bundle.providers, "providers", context);
    checkUniqueIds(bundle.logicalModels, "logicalModels", context);
    checkUniqueIds(bundle.promptProfiles, "promptProfiles", context);

    const projectKeys = new Set<string>();
    for (const [index, profile] of bundle.projectProfiles.entries()) {
      const key = projectDirectoryKey(profile.projectDirectory);
      if (projectKeys.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate project profile '${profile.projectDirectory}'.`,
          path: ["projectProfiles", index, "projectDirectory"],
        });
      }
      projectKeys.add(key);
    }
  });

export interface ProfileBundle {
  readonly format: typeof bundleFormat;
  readonly version: typeof bundleVersion;
  readonly exportedAt: string;
  readonly providers: readonly ProviderProfile[];
  readonly logicalModels: readonly LogicalModelGroup[];
  readonly promptProfiles: readonly PromptProfile[];
  readonly projectProfiles: readonly ProjectProfile[];
}

export interface CreateProfileBundleInput {
  readonly providers: readonly ProviderProfile[];
  readonly logicalModels: readonly LogicalModelGroup[];
  readonly promptProfiles: readonly PromptProfile[];
  readonly projectProfiles: readonly ProjectProfile[];
}

/** Creates a deterministic, secret-reference-only portable configuration bundle. */
export function createProfileBundle(
  input: CreateProfileBundleInput,
  now: Date = new Date(),
): ProfileBundle {
  return parseProfileBundle({
    format: bundleFormat,
    version: bundleVersion,
    exportedAt: now.toISOString(),
    providers: input.providers,
    logicalModels: input.logicalModels,
    promptProfiles: input.promptProfiles,
    projectProfiles: input.projectProfiles,
  });
}

export function parseProfileBundle(input: unknown): ProfileBundle {
  const bundle = profileBundleSchema.parse(input);
  return {
    ...bundle,
    providers: [...bundle.providers].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    logicalModels: [...bundle.logicalModels].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    promptProfiles: [...bundle.promptProfiles].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    projectProfiles: bundle.projectProfiles
      .map(parseProjectProfile)
      .sort((left, right) =>
        projectDirectoryKey(left.projectDirectory).localeCompare(
          projectDirectoryKey(right.projectDirectory),
        ),
      ),
  };
}

function checkUniqueIds(
  entries: readonly { readonly id: string }[],
  field: "providers" | "logicalModels" | "promptProfiles",
  context: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (ids.has(entry.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate ${field} entry '${entry.id}'.`,
        path: [field, index, "id"],
      });
    }
    ids.add(entry.id);
  }
}
