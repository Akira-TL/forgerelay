import * as z from "zod/v4";
import { defineConfigDomain } from "../../runtime/config/definition/definition.js";

export const HOOK_EVENTS = [
  "WorkspaceOpen",
  "BeforeTool",
  "AfterTool",
  "AfterToolFailure",
  "ExternalMcpBeforeForward",
  "ExternalMcpAfterForward",
  "AfterFileChange",
  "BeforeWorktreeClose",
  "AfterWorktreeClose",
  "SubagentStart",
  "SubagentStop",
] as const;

const schemaMetadata = {
  $schema: z.string().optional().describe("Editor-only JSON Schema URL. Ignored by ForgeRelay resolution."),
};
const nonEmptyString = z.string().trim().min(1);
const regexString = z.string().min(1).refine((value) => {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}, "Must be a valid regular expression.");

export const hookMatcherSchema = z.object({
  tool: nonEmptyString.optional(),
  commandRegex: regexString.optional(),
  pathRegex: regexString.optional(),
  provider: nonEmptyString.optional(),
  workspaceMode: z.enum(["checkout", "worktree"]).optional(),
  capability: nonEmptyString.optional(),
  externalServer: nonEmptyString.optional(),
  externalTool: nonEmptyString.optional(),
}).strict();

export const hookEntrySchema = z.object({
  event: z.enum(HOOK_EVENTS),
  matcher: hookMatcherSchema.optional(),
  command: nonEmptyString,
  timeoutSeconds: z.number().int().min(1).max(300).optional(),
  report: z.boolean().optional(),
}).strict();

const resolvedHookEntrySchema = hookEntrySchema.extend({
  name: nonEmptyString.optional(),
  order: z.number().int().nonnegative().optional(),
});

export const hookDisabledEntrySchema = z.object({ disabled: z.literal(true) }).strict();

export const hookCanonicalFileSchema = z.union([
  hookEntrySchema.extend(schemaMetadata),
  hookDisabledEntrySchema.extend(schemaMetadata),
]);

export const hookEntriesSchema = z.record(
  z.string().min(1),
  z.union([
    hookDisabledEntrySchema,
    z.array(resolvedHookEntrySchema).min(1),
  ]),
);

export type HookEntryInput = z.infer<typeof hookEntrySchema>;
export type ResolvedHookEntryInput = z.infer<typeof resolvedHookEntrySchema>;
export type HookEntriesConfig = z.infer<typeof hookEntriesSchema>;

const legacyHookHandlerSchema = z.object({
  name: nonEmptyString.optional(),
  command: nonEmptyString,
  timeoutSeconds: z.number().int().min(1).max(300).optional(),
  report: z.boolean().optional(),
}).strict();
const legacyDirectHookRuleSchema = legacyHookHandlerSchema.extend({
  matcher: hookMatcherSchema.optional(),
});
const legacyHookRuleSchema = z.union([
  legacyDirectHookRuleSchema,
  z.object({
    matcher: hookMatcherSchema.optional(),
    handlers: z.array(legacyHookHandlerSchema).min(1),
  }).strict(),
]);
const legacyHookConfigSchema = z.object(Object.fromEntries(
  HOOK_EVENTS.map((event) => [event, z.array(legacyHookRuleSchema).optional()]),
) as Record<(typeof HOOK_EVENTS)[number], z.ZodOptional<z.ZodArray<typeof legacyHookRuleSchema>>>).strict();

export function normalizeLegacyHookEntries(value: unknown): HookEntriesConfig {
  const parsed = legacyHookConfigSchema.parse(value ?? {});
  const hooks: HookEntriesConfig = {};
  let order = 0;
  for (const event of HOOK_EVENTS) {
    for (const [ruleIndex, rule] of (parsed[event] ?? []).entries()) {
      const matcher = rule.matcher;
      const handlers = "handlers" in rule ? rule.handlers : [rule];
      for (const [handlerIndex, handler] of handlers.entries()) {
        const key = handler.name ?? legacyHookKey(event, ruleIndex, handlerIndex);
        const entry: ResolvedHookEntryInput = {
          event,
          ...(matcher ? { matcher } : {}),
          command: handler.command,
          ...(handler.name ? { name: handler.name } : {}),
          order,
          ...(handler.timeoutSeconds === undefined ? {} : { timeoutSeconds: handler.timeoutSeconds }),
          ...(handler.report === undefined ? {} : { report: handler.report }),
        };
        order += 1;
        const current = hooks[key];
        if (current && !Array.isArray(current)) {
          throw new Error(`Legacy Hook ${key} conflicts with a disabled Hook entry.`);
        }
        hooks[key] = [...(current ?? []), entry];
      }
    }
  }
  return hooks;
}

function legacyHookKey(event: (typeof HOOK_EVENTS)[number], ruleIndex: number, handlerIndex: number): string {
  return `@legacy/${event}/${String(ruleIndex + 1).padStart(4, "0")}/${String(handlerIndex + 1).padStart(4, "0")}`;
}

const HOOK_SCOPES = ["project-local", "project", "user"] as const;

export const hooksConfigDefinition = defineConfigDomain({
  domain: "hooks",
  title: "ForgeRelay Lifecycle Hook configuration",
  description: "Lifecycle Hook files composed by stable file name across user, project, and Project Local scopes.",
  fileShape: {
    kind: "keyed-entry",
    field: "hooks",
    fileSchema: hookCanonicalFileSchema,
    normalizeEntry: (value) => {
      if (isRecord(value) && value.disabled === true) return { disabled: true };
      return [value];
    },
  },
  fields: {
    hooks: {
      schema: hookEntriesSchema,
      description: "Lifecycle Hooks keyed by stable Hook name.",
      required: true,
      legalScopes: HOOK_SCOPES,
      merge: "keyed",
      reload: "hot",
      sensitivity: "sensitive",
      interpolation: "none",
      builtIn: { kind: "none" },
      executionEffect: (value) => isRecord(value) && value.disabled === true ? "none" : "process",
    },
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
