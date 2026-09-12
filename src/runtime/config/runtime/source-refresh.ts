import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ConfigSourceRefreshIssue {
  code: "invalid_source" | "missing_environment";
  message: string;
}

export type ConfigSourceRefreshState = "missing" | "valid" | "invalid";

export interface ConfigSourceRefreshStatus {
  key: string;
  path: string;
  state: ConfigSourceRefreshState;
  observedFingerprint: string;
  effectiveFingerprint?: string;
  usingLastKnownGood: boolean;
  changed: boolean;
  diagnosticChanged: boolean;
}

export interface ConfigSourceRefreshResult<T> {
  value?: T;
  status: ConfigSourceRefreshStatus;
  issue?: ConfigSourceRefreshIssue;
}

export interface RefreshFileInput<T> {
  key: string;
  path: string;
  parse: (content: string) => T;
  validate?: (value: T) => ConfigSourceRefreshIssue | undefined;
  parseIssue?: ConfigSourceRefreshIssue | ((error: unknown) => ConfigSourceRefreshIssue);
  readIssue?: ConfigSourceRefreshIssue | ((error: unknown) => ConfigSourceRefreshIssue);
}

export interface RefreshDirectoryInput<T> {
  key: string;
  directory: string;
  include: (name: string) => boolean;
  parse: (name: string, content: string, path: string) => T;
  validate?: (value: T, name: string, path: string) => ConfigSourceRefreshIssue | undefined;
  parseIssue?: ConfigSourceRefreshIssue | ((error: unknown, name: string, path: string) => ConfigSourceRefreshIssue);
  readIssue?: ConfigSourceRefreshIssue | ((error: unknown, name: string, path: string) => ConfigSourceRefreshIssue);
}

export interface ConfigDirectoryRefreshUnit<T> extends ConfigSourceRefreshResult<T> {
  name: string;
}

export interface ConfigDirectoryRefreshResult<T> {
  directory: string;
  state: "missing" | "valid" | "invalid";
  observedFingerprint: string;
  effectiveFingerprint: string;
  units: ConfigDirectoryRefreshUnit<T>[];
  issue?: ConfigSourceRefreshIssue;
  diagnosticChanged: boolean;
}

interface StoredUnit<T> {
  observedFingerprint: string;
  effectiveFingerprint?: string;
  state: ConfigSourceRefreshState;
  value?: T;
  issue?: ConfigSourceRefreshIssue;
}

interface StoredDirectory {
  names: Set<string>;
  observedFingerprint: string;
  issueFingerprint?: string;
}

const MISSING_FINGERPRINT = "missing";

export class ConfigSourceRuntime {
  private readonly units = new Map<string, StoredUnit<unknown>>();
  private readonly directories = new Map<string, StoredDirectory>();

  refreshFile<T>(input: RefreshFileInput<T>): ConfigSourceRefreshResult<T> {
    return this.refreshUnit({
      ...input,
      path: resolve(input.path),
    });
  }

  refreshDirectory<T>(input: RefreshDirectoryInput<T>): ConfigDirectoryRefreshResult<T> {
    const directory = resolve(input.directory);
    const previousDirectory = this.directories.get(input.key);
    let names: string[];
    try {
      names = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && input.include(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if (isMissingDirectory(error)) {
        this.clearDeletedDirectoryUnits(input.key, previousDirectory, directory, new Set());
        this.directories.set(input.key, {
          names: new Set(),
          observedFingerprint: MISSING_FINGERPRINT,
        });
        return {
          directory,
          state: "missing",
          observedFingerprint: MISSING_FINGERPRINT,
          effectiveFingerprint: fingerprintSourceUnits([]),
          units: [],
          diagnosticChanged: false,
        };
      }
      const issue: ConfigSourceRefreshIssue = {
        code: "invalid_source",
        message: "Configuration directory could not be read.",
      };
      const issueFingerprint = `directory-read-error:${errorCode(error)}`;
      const diagnosticChanged = previousDirectory?.issueFingerprint !== issueFingerprint;
      const units = this.previousDirectoryUnits<T>(input.key, previousDirectory, directory, issue, issueFingerprint);
      const observedFingerprint = fingerprintSourceUnits(
        units.map((unit) => ({ name: unit.name, fingerprint: unit.status.observedFingerprint })),
      );
      const effectiveFingerprint = fingerprintSourceUnits(
        units.flatMap((unit) => unit.status.effectiveFingerprint
          ? [{ name: unit.name, fingerprint: unit.status.effectiveFingerprint }]
          : []),
      );
      this.directories.set(input.key, {
        names: new Set(units.map((unit) => unit.name)),
        observedFingerprint,
        issueFingerprint,
      });
      return {
        directory,
        state: "invalid",
        observedFingerprint,
        effectiveFingerprint,
        units,
        issue,
        diagnosticChanged,
      };
    }

    const currentNames = new Set(names);
    this.clearDeletedDirectoryUnits(input.key, previousDirectory, directory, currentNames);
    const units = names.map((name): ConfigDirectoryRefreshUnit<T> => {
      const path = join(directory, name);
      const result = this.refreshUnit({
        key: directoryUnitKey(input.key, name),
        path,
        parse: (content) => input.parse(name, content, path),
        validate: input.validate ? (value) => input.validate!(value, name, path) : undefined,
        parseIssue: input.parseIssue
          ? (error) => resolveDirectoryIssue(input.parseIssue, error, name, path, "Configuration source is invalid.")
          : undefined,
        readIssue: input.readIssue
          ? (error) => resolveDirectoryIssue(input.readIssue, error, name, path, "Configuration source could not be read.")
          : undefined,
      });
      return { name, ...result };
    });
    const observedFingerprint = fingerprintSourceUnits(
      units.map((unit) => ({ name: unit.name, fingerprint: unit.status.observedFingerprint })),
    );
    const effectiveFingerprint = fingerprintSourceUnits(
      units.flatMap((unit) => unit.status.effectiveFingerprint
        ? [{ name: unit.name, fingerprint: unit.status.effectiveFingerprint }]
        : []),
    );
    this.directories.set(input.key, {
      names: currentNames,
      observedFingerprint,
    });
    return {
      directory,
      state: units.some((unit) => unit.status.state === "invalid") ? "invalid" : "valid",
      observedFingerprint,
      effectiveFingerprint,
      units,
      diagnosticChanged: units.some((unit) => unit.status.diagnosticChanged),
    };
  }

  private refreshUnit<T>(input: RefreshFileInput<T>): ConfigSourceRefreshResult<T> {
    const path = resolve(input.path);
    const previous = this.units.get(input.key) as StoredUnit<T> | undefined;
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        const changed = previous?.observedFingerprint !== MISSING_FINGERPRINT || previous?.state !== "missing";
        const missing: StoredUnit<T> = {
          observedFingerprint: MISSING_FINGERPRINT,
          state: "missing",
        };
        this.units.set(input.key, missing);
        return {
          status: {
            key: input.key,
            path,
            state: "missing",
            observedFingerprint: MISSING_FINGERPRINT,
            usingLastKnownGood: false,
            changed,
            diagnosticChanged: false,
          },
        };
      }
      const fingerprint = `read-error:${errorCode(error)}`;
      const issue = resolveIssue(input.readIssue, error, "Configuration source could not be read.");
      return this.invalidUnit(input.key, path, fingerprint, previous, issue);
    }

    const fingerprint = contentFingerprint(content);
    if (previous?.observedFingerprint === fingerprint) {
      return storedResult(input.key, path, previous, false, false);
    }

    let value: T;
    try {
      value = input.parse(content);
    } catch (error) {
      const issue = resolveIssue(input.parseIssue, error, "Configuration source is invalid.");
      return this.invalidUnit(input.key, path, fingerprint, previous, issue);
    }
    const validationIssue = input.validate?.(value);
    if (validationIssue) {
      return this.invalidUnit(input.key, path, fingerprint, previous, validationIssue);
    }

    const valid: StoredUnit<T> = {
      observedFingerprint: fingerprint,
      effectiveFingerprint: fingerprint,
      state: "valid",
      value,
    };
    this.units.set(input.key, valid);
    return storedResult(input.key, path, valid, true, false);
  }

  private invalidUnit<T>(
    key: string,
    path: string,
    observedFingerprint: string,
    previous: StoredUnit<T> | undefined,
    issue: ConfigSourceRefreshIssue,
  ): ConfigSourceRefreshResult<T> {
    if (previous?.observedFingerprint === observedFingerprint && previous.state === "invalid") {
      return storedResult(key, path, previous, false, false);
    }
    const keepLastKnownGood = previous?.effectiveFingerprint !== undefined && previous.value !== undefined;
    const invalid: StoredUnit<T> = {
      observedFingerprint,
      ...(keepLastKnownGood ? {
        effectiveFingerprint: previous.effectiveFingerprint,
        value: previous.value,
      } : {}),
      state: "invalid",
      issue,
    };
    this.units.set(key, invalid);
    return storedResult(key, path, invalid, true, true);
  }

  private clearDeletedDirectoryUnits(
    directoryKey: string,
    previous: StoredDirectory | undefined,
    directory: string,
    currentNames: Set<string>,
  ): void {
    if (!previous) return;
    for (const name of previous.names) {
      if (currentNames.has(name)) continue;
      const key = directoryUnitKey(directoryKey, name);
      this.units.set(key, {
        observedFingerprint: MISSING_FINGERPRINT,
        state: "missing",
      });
    }
  }

  private previousDirectoryUnits<T>(
    directoryKey: string,
    previous: StoredDirectory | undefined,
    directory: string,
    issue: ConfigSourceRefreshIssue,
    observedFingerprint: string,
  ): ConfigDirectoryRefreshUnit<T>[] {
    if (!previous) return [];
    return [...previous.names].sort((left, right) => left.localeCompare(right)).map((name) => {
      const key = directoryUnitKey(directoryKey, name);
      const prior = this.units.get(key) as StoredUnit<T> | undefined;
      const invalid: StoredUnit<T> = {
        observedFingerprint,
        ...(prior?.effectiveFingerprint && prior.value !== undefined ? {
          effectiveFingerprint: prior.effectiveFingerprint,
          value: prior.value,
        } : {}),
        state: "invalid",
        issue,
      };
      const diagnosticChanged = prior?.observedFingerprint !== observedFingerprint || prior.state !== "invalid";
      this.units.set(key, invalid);
      return {
        name,
        ...storedResult(key, join(directory, name), invalid, diagnosticChanged, diagnosticChanged),
      };
    });
  }
}

export function fingerprintSourceUnits(units: Array<{ name: string; fingerprint: string }>): string {
  const sorted = [...units]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, fingerprint }) => [name, fingerprint] as const);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("base64url");
}

function contentFingerprint(content: string): string {
  return createHash("sha256").update(content).digest("base64url");
}

function directoryUnitKey(directoryKey: string, name: string): string {
  return `${directoryKey}\0${name}`;
}

function storedResult<T>(
  key: string,
  path: string,
  stored: StoredUnit<T>,
  changed: boolean,
  diagnosticChanged: boolean,
): ConfigSourceRefreshResult<T> {
  return {
    ...(stored.value !== undefined ? { value: stored.value } : {}),
    status: {
      key,
      path,
      state: stored.state,
      observedFingerprint: stored.observedFingerprint,
      ...(stored.effectiveFingerprint ? { effectiveFingerprint: stored.effectiveFingerprint } : {}),
      usingLastKnownGood: stored.state === "invalid" && stored.effectiveFingerprint !== undefined && stored.value !== undefined,
      changed,
      diagnosticChanged,
    },
    ...(stored.issue ? { issue: stored.issue } : {}),
  };
}

function resolveIssue(
  configured: RefreshFileInput<unknown>["parseIssue"] | RefreshFileInput<unknown>["readIssue"],
  error: unknown,
  fallbackMessage: string,
): ConfigSourceRefreshIssue {
  if (typeof configured === "function") return configured(error);
  return configured ?? { code: "invalid_source", message: fallbackMessage };
}

function resolveDirectoryIssue(
  configured: RefreshDirectoryInput<unknown>["parseIssue"] | RefreshDirectoryInput<unknown>["readIssue"],
  error: unknown,
  name: string,
  path: string,
  fallbackMessage: string,
): ConfigSourceRefreshIssue {
  if (typeof configured === "function") return configured(error, name, path);
  return configured ?? { code: "invalid_source", message: fallbackMessage };
}

function isMissingFile(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isMissingDirectory(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return "UNKNOWN";
}
