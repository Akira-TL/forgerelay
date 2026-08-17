import type Database from "better-sqlite3";

interface Migration {
  version: number;
  name: string;
  up(sqlite: Database.Database): void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "workspace-state",
    up: migrateWorkspaceState,
  },
  {
    version: 2,
    name: "oauth-state",
    up: migrateOAuthState,
  },
  {
    version: 3,
    name: "local-agent-sessions",
    up: migrateLocalAgentSessions,
  },
  {
    version: 4,
    name: "workspace-conversation-bindings",
    up: migrateWorkspaceConversationBindings,
  },
  {
    version: 5,
    name: "workspace-worktree-branches",
    up: migrateWorkspaceWorktreeBranches,
  },
  {
    version: 6,
    name: "local-agent-hook-reports",
    up: migrateLocalAgentHookReports,
  },
  {
    version: 7,
    name: "workspace-context-deliveries",
    up: migrateWorkspaceContextDeliveries,
  },
  {
    version: 8,
    name: "activity-audit",
    up: migrateActivityAudit,
  },
  {
    version: 9,
    name: "bash-output-audit",
    up: migrateBashOutputAudit,
  },
  {
    version: 10,
    name: "activity-host-turns",
    up: migrateActivityHostTurns,
  },
  {
    version: 11,
    name: "activity-parent-child",
    up: migrateActivityParentChild,
  },
  {
    version: 12,
    name: "bash-output-audit-columns",
    up: migrateBashOutputAuditColumns,
  },
];

export function migrateDatabase(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.exec(`
      create table if not exists devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
    `);

    const applied = new Set(
      (
        sqlite.prepare("select version from devspace_schema_migrations").all() as Array<{
          version: number;
        }>
      ).map((row) => row.version),
    );
    const recordMigration = sqlite.prepare(
      "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      migration.up(sqlite);
      recordMigration.run(migration.version, migration.name, new Date().toISOString());
    }
  });

  migrate.immediate();
}

function migrateWorkspaceState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );

    create index if not exists workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

    create index if not exists workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

    create table if not exists loaded_agent_files (
      workspace_session_id text not null,
      path text not null,
      content_hash text not null,
      content text not null,
      loaded_at text not null,
      last_seen_at text not null,
      primary key (workspace_session_id, path),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists loaded_agent_files_path_idx
      on loaded_agent_files(path);
  `);

  addColumnIfMissing(sqlite, "workspace_sessions", "mode", "text not null default 'checkout'");
  addColumnIfMissing(sqlite, "workspace_sessions", "source_root", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_ref", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_sha", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "managed", "text not null default 'false'");
}

function migrateOAuthState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);
  `);
}

function migrateLocalAgentSessions(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      thinking text,
      provider_session_id text,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists local_agent_sessions_workspace_id_idx
      on local_agent_sessions(workspace_id, updated_at desc);

    create index if not exists local_agent_sessions_workspace_root_idx
      on local_agent_sessions(workspace_root, updated_at desc);

    create index if not exists local_agent_sessions_provider_session_id_idx
      on local_agent_sessions(provider_session_id);
  `);

  addColumnIfMissing(sqlite, "local_agent_sessions", "thinking", "text");
}

function migrateWorkspaceConversationBindings(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_conversation_bindings (
      conversation_scope_id text not null,
      target_key text not null,
      workspace_session_id text not null,
      created_at text not null,
      last_used_at text not null,
      primary key (conversation_scope_id, target_key),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists workspace_conversation_bindings_workspace_idx
      on workspace_conversation_bindings(workspace_session_id);
  `);
}

function migrateWorkspaceWorktreeBranches(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "workspace_sessions", "branch", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "target_branch", "text");
}

function migrateLocalAgentHookReports(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "local_agent_sessions", "hook_reports_json", "text");
}

function migrateWorkspaceContextDeliveries(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_context_deliveries (
      conversation_scope_id text not null,
      target_key text not null,
      context_fingerprint text not null,
      delivered_at text not null,
      primary key (conversation_scope_id, target_key)
    );

    create index if not exists workspace_context_deliveries_delivered_idx
      on workspace_context_deliveries(delivered_at desc);
  `);
}

function migrateActivityAudit(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists activity_audit_events (
      id text primary key,
      activity_id text not null,
      sequence integer not null,
      event_type text not null,
      turn_id text,
      conversation_scope_id text,
      tool text,
      workspace_id text,
      workspace_root text,
      workspace_mode text,
      workspace_source_root text,
      workspace_branch text,
      workspace_target_branch text,
      request_json text,
      result_json text,
      error text,
      created_at text not null
    );

    create unique index if not exists activity_audit_events_activity_sequence_unique_idx
      on activity_audit_events(activity_id, sequence);

    create index if not exists activity_audit_events_activity_idx
      on activity_audit_events(activity_id, sequence);

    create index if not exists activity_audit_events_turn_idx
      on activity_audit_events(turn_id, created_at);

    create index if not exists activity_audit_events_created_idx
      on activity_audit_events(created_at);
  `);
}

function migrateBashOutputAudit(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists bash_output_streams (
      id text primary key,
      activity_id text not null,
      turn_id text not null,
      conversation_scope_id text,
      process_id integer not null,
      workspace_id text not null,
      workspace_root text not null,
      command text not null,
      tty integer not null default 0,
      status text not null default 'running',
      exit_code integer,
      signal text,
      timed_out integer not null default 0,
      error text,
      returned integer not null default 0,
      completion_claimed_at text,
      started_at text not null,
      finished_at text
    );

    create index if not exists bash_output_streams_activity_idx
      on bash_output_streams(activity_id);

    create index if not exists bash_output_streams_workspace_idx
      on bash_output_streams(workspace_id, started_at);

    create table if not exists bash_output_chunks (
      output_id text not null,
      sequence integer not null,
      channel text not null,
      data blob not null,
      created_at text not null,
      primary key (output_id, sequence),
      foreign key (output_id) references bash_output_streams(id) on delete cascade
    );

    create index if not exists bash_output_chunks_output_idx
      on bash_output_chunks(output_id, sequence);
  `);
}

function migrateActivityHostTurns(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists activity_host_turns (
      turn_id text primary key,
      conversation_scope_id text,
      created_at text not null
    );

    create index if not exists activity_host_turns_conversation_idx
      on activity_host_turns(conversation_scope_id, created_at desc);

    create index if not exists activity_host_turns_created_idx
      on activity_host_turns(created_at desc);
  `);
}

function migrateActivityParentChild(sqlite: Database.Database): void {
  sqlite.exec(`
    alter table activity_audit_events add column parent_activity_id text;

    create index if not exists activity_audit_events_parent_idx
      on activity_audit_events(parent_activity_id, created_at);
  `);
}

function migrateBashOutputAuditColumns(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "bash_output_streams", "error", "text");
  addColumnIfMissing(sqlite, "bash_output_streams", "returned", "integer not null default 0");
  addColumnIfMissing(sqlite, "bash_output_streams", "completion_claimed_at", "text");
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: "workspace_sessions" | "local_agent_sessions" | "bash_output_streams",
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existingColumn) => existingColumn.name === column)) return;

  sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}
