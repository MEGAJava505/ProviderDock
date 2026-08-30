import { z } from "zod";

const routeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, digits, '-' or '_'.");

export const logicalModelRouteSchema = z
  .object({
    providerId: routeIdSchema,
    modelId: z.string().trim().min(1).max(256),
    priority: z.number().int().min(-10_000).max(10_000).default(0),
    enabled: z.boolean().default(true),
  })
  .strict();

export const logicalModelGroupSchema = z
  .object({
    id: routeIdSchema,
    routes: z.array(logicalModelRouteSchema).min(1).max(128),
  })
  .strict()
  .superRefine((group, context) => {
    const seen = new Set<string>();
    for (const [index, route] of group.routes.entries()) {
      const key = logicalRouteKey(route);
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate logical-model route '${route.providerId}/${route.modelId}'.`,
          path: ["routes", index],
        });
      }
      seen.add(key);
    }
    if (!group.routes.some((route) => route.enabled)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A logical model must have at least one enabled route.",
        path: ["routes"],
      });
    }
  });

export type LogicalModelRoute = z.infer<typeof logicalModelRouteSchema>;
export type LogicalModelGroup = z.infer<typeof logicalModelGroupSchema>;
export type LogicalModelGroupInput = z.input<typeof logicalModelGroupSchema>;

export function parseLogicalModelGroup(input: unknown): LogicalModelGroup {
  return logicalModelGroupSchema.parse(input);
}

export function logicalRouteKey(
  route: Pick<LogicalModelRoute, "providerId" | "modelId">,
): string {
  return `${route.providerId}:${route.modelId}`;
}

export function orderedLogicalRoutes(
  group: LogicalModelGroup,
): readonly LogicalModelRoute[] {
  return [...group.routes]
    .filter((route) => route.enabled)
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.providerId.localeCompare(right.providerId) ||
        left.modelId.localeCompare(right.modelId),
    );
}
