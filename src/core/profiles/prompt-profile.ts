import { z } from "zod";
import { preferredClientSchema } from "../providers/provider-profile.js";

const promptProfileIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, digits, '-' or '_'.");

const referencedIdSchema = promptProfileIdSchema;

const clientFlagSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "Client flags cannot contain control characters.",
  );

export const promptFallbackPolicies = ["disabled", "logical-model"] as const;
export const promptFallbackPolicySchema = z.enum(promptFallbackPolicies);
export type PromptFallbackPolicy = z.infer<typeof promptFallbackPolicySchema>;

export const promptProfileSchema = z
  .object({
    id: promptProfileIdSchema,
    name: z.string().trim().min(1).max(128),
    description: z.string().trim().max(4_096).default(""),
    instructions: z.string().trim().min(1).max(256 * 1024),
    preferredProviderId: referencedIdSchema.optional(),
    preferredModelId: z.string().trim().min(1).max(256).optional(),
    preferredLogicalModelId: referencedIdSchema.optional(),
    preferredClient: preferredClientSchema.default("auto"),
    reasoningLevel: z.string().trim().min(1).max(64).optional(),
    fallbackPolicy: promptFallbackPolicySchema.default("disabled"),
    clientFlags: z
      .object({
        codex: z.array(clientFlagSchema).max(64).default([]),
        claudeCode: z.array(clientFlagSchema).max(64).default([]),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((profile, context) => {
    if (
      profile.preferredModelId !== undefined &&
      profile.preferredProviderId === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "preferredModelId requires preferredProviderId.",
        path: ["preferredModelId"],
      });
    }
    if (
      profile.fallbackPolicy === "logical-model" &&
      profile.preferredLogicalModelId === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "fallbackPolicy 'logical-model' requires preferredLogicalModelId.",
        path: ["fallbackPolicy"],
      });
    }
  });

export type PromptProfile = z.infer<typeof promptProfileSchema>;
export type PromptProfileInput = z.input<typeof promptProfileSchema>;

export function parsePromptProfile(input: unknown): PromptProfile {
  return promptProfileSchema.parse(input);
}
