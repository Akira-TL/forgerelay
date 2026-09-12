import { externalMcpConfigDefinition } from "./external-mcp.js";
import { generalConfigDefinition } from "./general-config.js";
import { languageServersConfigDefinition } from "./language-servers.js";
import { hooksConfigDefinition } from "../../../mcp/hooks/config.js";
import type { ConfigDomainDefinition } from "./types.js";

export const CONFIG_DEFINITION_CATALOG = [
  generalConfigDefinition,
  externalMcpConfigDefinition,
  languageServersConfigDefinition,
  hooksConfigDefinition,
] as const satisfies readonly ConfigDomainDefinition[];
