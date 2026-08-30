import { blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const workspaceSessions = sqliteTable(
  "workspace_sessions",
  {
    id: text("id").primaryKey(),
    root: text("root").notNull(),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("checkout"),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    branch: text("branch"),
    targetBranch: text("target_branch"),
    managed: text("managed").notNull().default("false"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("workspace_sessions_root_idx").on(table.root, table.lastUsedAt),
    index("workspace_sessions_status_idx").on(table.status, table.lastUsedAt),
  ],
);

export const loadedAgentFiles = sqliteTable(
  "loaded_agent_files",
  {
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    loadedAt: text("loaded_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceSessionId, table.path] }),
    index("loaded_agent_files_path_idx").on(table.path),
  ],
);

export const workspaceConversationBindings = sqliteTable(
  "workspace_conversation_bindings",
  {
    conversationScopeId: text("conversation_scope_id").notNull(),
    targetKey: text("target_key").notNull(),
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationScopeId, table.targetKey] }),
    index("workspace_conversation_bindings_workspace_idx").on(table.workspaceSessionId),
  ],
);

export const workspaceContextDeliveries = sqliteTable(
  "workspace_context_deliveries",
  {
    conversationScopeId: text("conversation_scope_id").notNull(),
    targetKey: text("target_key").notNull(),
    contextFingerprint: text("context_fingerprint").notNull(),
    deliveredAt: text("delivered_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationScopeId, table.targetKey] }),
    index("workspace_context_deliveries_delivered_idx").on(table.deliveredAt),
  ],
);

export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientJson: text("client_json").notNull(),
    issuedAt: integer("issued_at").notNull(),
  },
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const activityAuditEvents = sqliteTable(
  "activity_audit_events",
  {
    id: text("id").primaryKey(),
    activityId: text("activity_id").notNull(),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    turnId: text("turn_id"),
    conversationScopeId: text("conversation_scope_id"),
    tool: text("tool"),
    workspaceId: text("workspace_id"),
    workspaceRoot: text("workspace_root"),
    workspaceMode: text("workspace_mode"),
    workspaceSourceRoot: text("workspace_source_root"),
    workspaceBranch: text("workspace_branch"),
    workspaceTargetBranch: text("workspace_target_branch"),
    requestJson: text("request_json"),
    resultJson: text("result_json"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("activity_audit_events_activity_sequence_unique_idx").on(table.activityId, table.sequence),
    index("activity_audit_events_activity_idx").on(table.activityId, table.sequence),
    index("activity_audit_events_turn_idx").on(table.turnId, table.createdAt),
    index("activity_audit_events_created_idx").on(table.createdAt),
  ],
);

export const activityHostTurns = sqliteTable(
  "activity_host_turns",
  {
    turnId: text("turn_id").primaryKey(),
    conversationScopeId: text("conversation_scope_id"),
    workspaceId: text("workspace_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("activity_host_turns_conversation_idx").on(table.conversationScopeId, table.createdAt),
    index("activity_host_turns_conversation_workspace_idx").on(
      table.conversationScopeId,
      table.workspaceId,
      table.createdAt,
    ),
    index("activity_host_turns_created_idx").on(table.createdAt),
  ],
);

export const bashOutputStreams = sqliteTable(
  "bash_output_streams",
  {
    id: text("id").primaryKey(),
    activityId: text("activity_id").notNull(),
    turnId: text("turn_id").notNull(),
    conversationScopeId: text("conversation_scope_id"),
    processId: integer("process_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    workspaceRoot: text("workspace_root").notNull(),
    command: text("command").notNull(),
    tty: integer("tty", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull().default("running"),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    timedOut: integer("timed_out", { mode: "boolean" }).notNull().default(false),
    error: text("error"),
    returned: integer("returned", { mode: "boolean" }).notNull().default(false),
    completionClaimedAt: text("completion_claimed_at"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => [
    index("bash_output_streams_activity_idx").on(table.activityId),
    index("bash_output_streams_workspace_idx").on(table.workspaceId, table.startedAt),
  ],
);

export const bashOutputChunks = sqliteTable(
  "bash_output_chunks",
  {
    outputId: text("output_id")
      .notNull()
      .references(() => bashOutputStreams.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    channel: text("channel").notNull(),
    data: blob("data", { mode: "buffer" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.outputId, table.sequence] }),
    index("bash_output_chunks_output_idx").on(table.outputId, table.sequence),
  ],
);

export const localAgentSessions = sqliteTable(
  "local_agent_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    workspaceRoot: text("workspace_root").notNull(),
    profileName: text("profile_name").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    thinking: text("thinking"),
    providerSessionId: text("provider_session_id"),
    status: text("status").notNull(),
    activeRunId: text("active_run_id"),
    activeActivityId: text("active_activity_id"),
    activeRunStartedAt: text("active_run_started_at"),
    latestRunId: text("latest_run_id"),
    latestRunOutcome: text("latest_run_outcome"),
    latestRunFinishedAt: text("latest_run_finished_at"),
    latestResponse: text("latest_response"),
    error: text("error"),
    hookReportsJson: text("hook_reports_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("local_agent_sessions_workspace_id_idx").on(table.workspaceId, table.updatedAt),
    index("local_agent_sessions_workspace_root_idx").on(table.workspaceRoot, table.updatedAt),
    index("local_agent_sessions_provider_session_id_idx").on(table.providerSessionId),
  ],
);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
export type WorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferSelect;
export type NewWorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferInsert;
export type WorkspaceContextDeliveryRow = typeof workspaceContextDeliveries.$inferSelect;
export type NewWorkspaceContextDeliveryRow = typeof workspaceContextDeliveries.$inferInsert;
export type ActivityAuditEventRow = typeof activityAuditEvents.$inferSelect;
export type NewActivityAuditEventRow = typeof activityAuditEvents.$inferInsert;
export type ActivityHostTurnRow = typeof activityHostTurns.$inferSelect;
export type NewActivityHostTurnRow = typeof activityHostTurns.$inferInsert;
export type BashOutputStreamRow = typeof bashOutputStreams.$inferSelect;
export type NewBashOutputStreamRow = typeof bashOutputStreams.$inferInsert;
export type BashOutputChunkRow = typeof bashOutputChunks.$inferSelect;
export type NewBashOutputChunkRow = typeof bashOutputChunks.$inferInsert;
export type LocalAgentSessionRow = typeof localAgentSessions.$inferSelect;
export type NewLocalAgentSessionRow = typeof localAgentSessions.$inferInsert;
