import { generalConfigDefinition } from "./general-config.js";
import type { ConfigDomainDefinition } from "./types.js";

export const CONFIG_DEFINITION_CATALOG = [
  generalConfigDefinition,
] as const satisfies readonly ConfigDomainDefinition[];
