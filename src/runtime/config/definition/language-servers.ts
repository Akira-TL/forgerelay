import * as z from "zod/v4";
import { defineConfigDomain } from "./definition.js";

const LANGUAGE_SERVER_SCOPES = ["project-local", "project", "user", "built-in"] as const;
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export const languageServerDefinitionSchema = z.object({
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  languages: z.array(z.string().min(1)).min(1).optional(),
  extensions: z.array(z.string().regex(/^\./)).min(1).optional(),
  languageIdByExtension: z.record(z.string().regex(/^\./), z.string().min(1)).optional(),
  projectMarkers: z.array(z.string().min(1)).optional(),
  disabled: z.literal(false).optional(),
}).strict();

export const languageServerDisabledSchema = z.object({ disabled: z.literal(true) }).strict();

export const languageServerServersSchema = z.record(
  z.string().min(1),
  z.union([languageServerDisabledSchema, languageServerDefinitionSchema]),
);

export type LanguageServerDefinitionInput = z.infer<typeof languageServerDefinitionSchema>;
export type LanguageServerServersConfig = z.infer<typeof languageServerServersSchema>;

export const BUILTIN_LANGUAGE_SERVER_DEFINITIONS: Record<string, LanguageServerDefinitionInput> = {
  typescript: {
    args: ["--stdio"],
    languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    languageIdByExtension: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
    },
    projectMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
  },
  pyright: {
    args: ["--stdio"],
    languages: ["python"],
    extensions: [".py", ".pyi"],
    languageIdByExtension: { ".py": "python", ".pyi": "python" },
    projectMarkers: ["pyrightconfig.json", "pyproject.toml", "setup.cfg", "setup.py"],
  },
  "rust-analyzer": {
    languages: ["rust"],
    extensions: [".rs"],
    languageIdByExtension: { ".rs": "rust" },
    projectMarkers: ["Cargo.toml"],
  },
  gopls: {
    languages: ["go"],
    extensions: [".go"],
    languageIdByExtension: { ".go": "go" },
    projectMarkers: ["go.work", "go.mod"],
  },
  clangd: {
    languages: ["c", "cpp", "objective-c", "objective-cpp"],
    extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".m", ".mm"],
    languageIdByExtension: {
      ".c": "c",
      ".cc": "cpp",
      ".cpp": "cpp",
      ".cxx": "cpp",
      ".h": "cpp",
      ".hh": "cpp",
      ".hpp": "cpp",
      ".hxx": "cpp",
      ".m": "objective-c",
      ".mm": "objective-cpp",
    },
    projectMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd"],
  },
};

export const languageServersConfigDefinition = defineConfigDomain({
  domain: "language-servers",
  title: "ForgeRelay Language Server configuration",
  description: "Language Server definitions used by Code Intelligence.",
  fileShape: { kind: "keyed-root", field: "servers" },
  fields: {
    servers: {
      schema: languageServerServersSchema,
      description: "Language Server definitions keyed by stable server name.",
      required: true,
      legalScopes: LANGUAGE_SERVER_SCOPES,
      merge: "keyed",
      reload: "hot",
      sensitivity: "sensitive",
      interpolation: "env",
      interpolateValue: interpolateLanguageServerEnvironment,
      builtIn: { kind: "literal", value: BUILTIN_LANGUAGE_SERVER_DEFINITIONS },
      executionEffect: (value) => isRecord(value) && value.disabled === true ? "none" : "process",
    },
  },
});

function interpolateLanguageServerEnvironment(
  value: LanguageServerServersConfig,
  environment: NodeJS.ProcessEnv,
): LanguageServerServersConfig {
  return Object.fromEntries(Object.entries(value).map(([name, entry]) => {
    if (!("env" in entry) || !isRecord(entry.env)) return [name, entry];
    return [name, {
      ...entry,
      env: Object.fromEntries(Object.entries(entry.env).map(([key, raw]) => [
        key,
        typeof raw === "string" ? interpolateString(raw, environment) : raw,
      ])),
    }];
  })) as LanguageServerServersConfig;
}

function interpolateString(value: string, environment: NodeJS.ProcessEnv): string {
  return value.replace(ENV_REFERENCE, (_match, name: string) => {
    const resolved = environment[name];
    if (resolved !== undefined) return resolved;
    const error = new Error(`Required environment variable ${name} is not available.`) as Error & {
      code?: string;
      variable?: string;
    };
    error.code = "missing_environment";
    error.variable = name;
    throw error;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
