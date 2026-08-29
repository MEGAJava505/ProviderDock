import { z } from "zod";

export const providerApiTypes = [
  "auto",
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
  "custom",
] as const;

export const providerApiTypeSchema = z.enum(providerApiTypes);

export type ProviderApiType = z.infer<typeof providerApiTypeSchema>;

export const preferredClients = ["auto", "codex", "claude-code"] as const;
export const preferredClientSchema = z.enum(preferredClients);

export const secretReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "Use letters, digits, '.', ':', '-' or '_'.");

export const providerAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("bearer"),
      secretRef: secretReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("header"),
      headerName: z.string().trim().min(1).max(256),
      secretRef: secretReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("query"),
      parameterName: z.string().trim().min(1).max(256),
      secretRef: secretReferenceSchema,
    })
    .strict(),
]);

export type ProviderAuth = z.infer<typeof providerAuthSchema>;

const stringRecordSchema = z.record(
  z.string().trim().min(1).max(256),
  z.string().max(8_192),
);

const sensitiveStaticHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "cookie",
]);

const sensitiveQueryParameters = new Set([
  "access_token",
  "api_key",
  "apikey",
  "key",
  "token",
]);

const staticHeaderRecordSchema = stringRecordSchema.superRefine((headers, context) => {
  for (const headerName of Object.keys(headers)) {
    if (sensitiveStaticHeaders.has(headerName.toLowerCase())) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Header '${headerName}' must use auth or secretHeaders instead of a plaintext value.`,
        path: [headerName],
      });
    }
  }
});

const queryParameterRecordSchema = stringRecordSchema.superRefine((parameters, context) => {
  for (const parameterName of Object.keys(parameters)) {
    if (sensitiveQueryParameters.has(parameterName.toLowerCase())) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Query parameter '${parameterName}' must use query auth instead of a plaintext value.`,
        path: [parameterName],
      });
    }
  }
});

const secretHeaderRecordSchema = z.record(
  z.string().trim().min(1).max(256),
  secretReferenceSchema,
);

export const healthCheckPolicySchema = z
  .object({
    enabled: z.boolean().default(true),
    metadataTtlMs: z.number().int().min(1_000).max(86_400_000).default(60_000),
    minimalInference: z.enum(["never", "on-demand", "after-metadata"]).default("on-demand"),
  })
  .strict();

export const providerProfileSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, digits, '-' or '_'."),
    displayName: z.string().trim().min(1).max(128),
    enabled: z.boolean().default(true),
    baseUrl: z
      .string()
      .trim()
      .url()
      .refine((value) => value.startsWith("https://") || value.startsWith("http://"), {
        message: "Only HTTP(S) provider URLs are supported.",
      })
      .transform((value) => value.replace(/\/+$/, "")),
    apiType: providerApiTypeSchema.default("auto"),
    auth: providerAuthSchema.default({ kind: "none" }),
    staticHeaders: staticHeaderRecordSchema.default({}),
    secretHeaders: secretHeaderRecordSchema.default({}),
    queryParameters: queryParameterRecordSchema.default({}),
    modelsEndpoint: z.string().trim().min(1).max(2_048).default("models"),
    manualModelIds: z.array(z.string().trim().min(1).max(256)).max(1_000).default([]),
    preferredClient: preferredClientSchema.default("auto"),
    timeoutMs: z.number().int().min(250).max(300_000).default(10_000),
    healthCheck: healthCheckPolicySchema.default({}),
  })
  .strict()
  .superRefine((profile, context) => {
    const staticHeaderNames = new Set(
      Object.keys(profile.staticHeaders).map((name) => name.toLowerCase()),
    );
    const secretHeaderNames = new Set(
      Object.keys(profile.secretHeaders).map((name) => name.toLowerCase()),
    );

    for (const duplicate of [...staticHeaderNames].filter((name) => secretHeaderNames.has(name))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Header '${duplicate}' cannot be both static and secret-backed.`,
        path: ["secretHeaders", duplicate],
      });
    }

    if (profile.auth.kind === "bearer" && secretHeaderNames.has("authorization")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Bearer auth cannot be combined with a secret-backed Authorization header.",
        path: ["secretHeaders", "authorization"],
      });
    }
    if (profile.auth.kind === "header") {
      const authHeader = profile.auth.headerName.toLowerCase();
      if (staticHeaderNames.has(authHeader) || secretHeaderNames.has(authHeader)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Auth header '${profile.auth.headerName}' cannot also be configured as a custom header.`,
          path: ["auth", "headerName"],
        });
      }
    }
    if (profile.auth.kind === "query") {
      const parameterName = profile.auth.parameterName;
      if (
        Object.keys(profile.queryParameters).some(
          (name) => name.toLowerCase() === parameterName.toLowerCase(),
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Auth query parameter '${parameterName}' cannot also be static.`,
          path: ["auth", "parameterName"],
        });
      }
    }
  });

export type ProviderProfile = z.infer<typeof providerProfileSchema>;
export type ProviderProfileInput = z.input<typeof providerProfileSchema>;

export function parseProviderProfile(input: unknown): ProviderProfile {
  return providerProfileSchema.parse(input);
}
