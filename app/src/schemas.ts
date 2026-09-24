// GENERATED from the ts-rs types by scripts/gen-schemas.mjs. DO NOT EDIT.
// Run: pnpm gen:schemas
import { z } from "zod";
import { type LayoutNode } from "./generated";

export const actionActivitySchema = z.union([z.literal("action_started"), z.literal("action_stopped"), z.literal("action_completed"), z.literal("action_crashed")]);

export const actionModeSchema = z.union([z.literal("pane"), z.literal("external")]);

export const actionShowSchema = z.union([z.literal("topbar"), z.literal("menu")]);

export const actionDefSchema = z.object({
    id: z.string(),
    label: z.string(),
    command: z.string(),
    mode: actionModeSchema,
    show: actionShowSchema,
    shortcut: z.string().nullable()
});

export const actionSetSchema = z.object({
    worktree_id: z.string(),
    actions: z.array(actionDefSchema),
    error: z.string().nullable(),
    from_repo: z.boolean()
});

export const activityKindSchema = z.string();

export const agentKindSchema = z.union([z.literal("claude"), z.literal("codex"), z.literal("pi")]);

export const activityQuerySchema = z.object({
    limit: z.number().nullable(),
    before_ms: z.number().nullable(),
    worktree_id: z.string().nullable(),
    needs_me: z.boolean()
});

export const agentCommandSchema = z.object({
    command: z.string(),
    args: z.array(z.string())
});

export const agentStateSchema = z.union([z.literal("working"), z.literal("waiting"), z.literal("idle"), z.literal("exited"), z.literal("unknown")]);

export const authoritySchema = z.union([z.literal("lifecycle"), z.literal("report"), z.literal("screen"), z.literal("heuristic"), z.literal("unknown")]);

export const agentReportSchema = z.object({
    pane_id: z.string(),
    kind: agentKindSchema,
    state: agentStateSchema.nullable(),
    session_ref: z.string().nullable(),
    authority: authoritySchema,
    at_ms: z.number()
});

export const agentSessionSchema = z.object({
    kind: agentKindSchema,
    id: z.string(),
    title: z.string().nullable(),
    branch: z.string().nullable(),
    updated_at_ms: z.number(),
    turns: z.number(),
    path: z.string()
});

export const agentSpawnSchema = z.object({
    kind: agentKindSchema,
    worktree_id: z.string().nullable(),
    cwd: z.string().nullable(),
    tab_id: z.string().nullable(),
    split_from: z.string().nullable(),
    resume: z.string().nullable(),
    new_tab: z.boolean(),
    extra_args: z.array(z.string())
});

export const agentationActivitySchema = z.literal("annotations_sent");

export const annotationSchema = z.object({
    text: z.string(),
    url: z.string(),
    selector: z.string().nullable(),
    element_text: z.string().nullable(),
    rect: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable()
});

export const archiveResultSchema = z.object({
    worktree_id: z.string(),
    branch: z.string().nullable(),
    checkpoint_commit: z.string().nullable()
});

export const attentionLevelSchema = z.union([z.literal("attention"), z.literal("info")]);

export const attentionKindSchema = z.union([z.literal("waiting"), z.literal("checkpoint"), z.literal("crash")]);

export const branchSchema = z.object({
    name: z.string(),
    remote: z.string().nullable(),
    upstream: z.string().nullable(),
    committed_at_ms: z.number()
});

export const checkpointModeSchema = z.union([z.literal("checkpoint"), z.literal("require_clean"), z.literal("discard")]);

export const checkpointSpecSchema = z.object({
    message: z.string(),
    url: z.string().nullable(),
    title: z.string().nullable(),
    worktree_id: z.string().nullable(),
    pane_id: z.string().nullable()
});

export const themeConfigSchema = z.object({
    name: z.string(),
    light: z.string(),
    dark: z.string(),
    colors: z.any()
});

export const notificationSettingsSchema = z.object({
    desktop: z.boolean(),
    sounds: z.boolean()
});

export const issueLevelSchema = z.union([z.literal("warning"), z.literal("error")]);

export const coreActivitySchema = z.union([z.literal("agent_started"), z.literal("agent_waiting"), z.literal("agent_exited"), z.literal("checkpoint_created"), z.literal("checkpoint_resolved"), z.literal("state_changed"), z.literal("tags_changed"), z.literal("archived"), z.literal("restored"), z.literal("hook_failed")]);

export const diagnosticLevelSchema = z.union([z.literal("info"), z.literal("warning"), z.literal("error")]);

export const dropPlaceSchema = z.union([z.literal("center"), z.literal("left"), z.literal("right"), z.literal("top"), z.literal("bottom")]);

export const errorCodeSchema = z.union([z.literal("bad_request"), z.literal("not_found"), z.literal("conflict"), z.literal("git"), z.literal("io"), z.literal("unsupported"), z.literal("internal"), z.literal("aborted")]);

export const activityEventSchema = z.object({
    id: z.string(),
    kind: activityKindSchema,
    occurred_at_ms: z.number(),
    worktree_id: z.string().nullable(),
    pane_id: z.string().nullable(),
    agent_kind: agentKindSchema.nullable(),
    title: z.string(),
    detail: z.string().nullable(),
    payload: z.unknown(),
    attention_id: z.string().nullable()
});

export const repoSchema = z.object({
    id: z.string(),
    path: z.string(),
    name: z.string(),
    exists: z.boolean(),
    remote_url: z.string().nullable(),
    worktree_parent: z.string().optional().nullable(),
    branch_prefix: z.string().optional().nullable()
});

export const worktreeMetadataSchema = z.object({
    display_name: z.string().nullable(),
    tags: z.array(z.string())
});

export const agentPresenceSchema = z.object({
    pane_id: z.string(),
    worktree_id: z.string(),
    kind: agentKindSchema,
    state: agentStateSchema,
    session_ref: z.string().nullable(),
    authority: authoritySchema,
    updated_at_ms: z.number(),
    pid: z.number().nullable()
});

export const attentionItemSchema = z.object({
    id: z.string(),
    worktree_id: z.string(),
    pane_id: z.string().nullable(),
    level: attentionLevelSchema,
    message: z.string(),
    created_at_ms: z.number(),
    viewed_at_ms: z.number().nullable(),
    kind: attentionKindSchema,
    url: z.string().nullable(),
    agent_kind: agentKindSchema.nullable(),
    resolved_at_ms: z.number().nullable()
});

export const worktreeResourcesSchema = z.object({
    worktree_id: z.string(),
    cpu_percent: z.number(),
    rss_bytes: z.number(),
    process_count: z.number()
});

export const noticeLevelSchema = z.union([z.literal("info"), z.literal("warning"), z.literal("error")]);

export const townUnlockSchema = z.object({
    slug: z.string(),
    worktree_id: z.string(),
    repo_id: z.string(),
    unlocked_at_ms: z.number()
});

export const pullRequestSchema = z.object({
    number: z.number(),
    title: z.string(),
    url: z.string(),
    state: z.string(),
    draft: z.boolean(),
    review_decision: z.string().nullable(),
    mergeable: z.string().nullable(),
    checks_passed: z.number(),
    checks_failed: z.number(),
    checks_pending: z.number(),
    fetched_at_ms: z.number()
});

export const hookRunSchema = z.object({
    event: z.string(),
    command: z.string(),
    worktree_id: z.string().nullable(),
    started_at_ms: z.number(),
    duration_ms: z.number(),
    exit_code: z.number().nullable(),
    ok: z.boolean(),
    output_tail: z.string()
});

export const diagnosticSchema = z.object({
    at_ms: z.number(),
    level: diagnosticLevelSchema,
    source: z.string(),
    message: z.string()
});

export const systemStatsSchema = z.object({
    at_ms: z.number(),
    cpu_percent: z.number(),
    memory_used_bytes: z.number(),
    memory_total_bytes: z.number(),
    gpu_percent: z.number().nullable(),
    vram_used_bytes: z.number().nullable(),
    vram_total_bytes: z.number().nullable(),
    daemon_rss_bytes: z.number(),
    top_worktree: worktreeResourcesSchema.nullable()
});

export const evidenceBundleSchema = z.object({
    source: z.string(),
    worktree_id: z.string(),
    url: z.string().nullable(),
    action_id: z.string().nullable(),
    annotations: z.array(annotationSchema),
    instruction: z.string(),
    markdown: z.string().optional(),
    note_count: z.number().optional()
});

export const fsEntrySchema = z.object({
    name: z.string(),
    rel_path: z.string(),
    is_dir: z.boolean(),
    size: z.number(),
    modified_ms: z.number()
});

export const gitHubActivitySchema = z.literal("pr_merged");

export const gitSummarySchema = z.object({
    branch: z.string().nullable(),
    head: z.string(),
    detached: z.boolean(),
    dirty: z.boolean(),
    files_changed: z.number(),
    untracked: z.number(),
    conflicts: z.number(),
    insertions: z.number(),
    deletions: z.number(),
    ahead: z.number().nullable(),
    behind: z.number().nullable(),
    upstream: z.string().nullable()
});

export const helloSchema = z.object({
    protocol: z.number(),
    version: z.string(),
    daemon_pid: z.number(),
    session_id: z.string()
});

export const hookActionSchema = z.object({
    id: z.string(),
    label: z.string()
});

export const hookAgentSchema = z.object({
    kind: agentKindSchema,
    state: agentStateSchema,
    session_ref: z.string().nullable()
});

export const hookModeSchema = z.union([z.literal("async"), z.literal("pane")]);

export const hookWorktreeSchema = z.object({
    id: z.string(),
    path: z.string(),
    repo_id: z.string(),
    repo_path: z.string(),
    branch: z.string().nullable(),
    name: z.string(),
    tags: z.array(z.string())
});

export const hookPaneSchema = z.object({
    id: z.string(),
    tab_id: z.string(),
    cwd: z.string()
});

export const integrationLevelSchema = z.union([z.literal("full"), z.literal("partial"), z.literal("process_only"), z.literal("unavailable")]);

export const integrationStatusSchema = z.object({
    kind: agentKindSchema,
    level: integrationLevelSchema,
    binary: z.string().nullable(),
    lifecycle: z.boolean(),
    resume: z.boolean(),
    reason: z.string().nullable()
});

export const integrationsSchema = z.object({
    claude_hooks: z.boolean(),
    codex_hooks: z.boolean(),
    pi_extension: z.boolean()
});

export const splitDirectionSchema = z.union([z.literal("horizontal"), z.literal("vertical")]);

export const layoutNodeSchema: z.ZodSchema<LayoutNode> = z.lazy(() => z.union([z.object({
        "type": z.literal("leaf"),
        pane_id: z.string()
    }), z.object({
        "type": z.literal("split"),
        id: z.string(),
        direction: splitDirectionSchema,
        ratio: z.number(),
        first: layoutNodeSchema,
        second: layoutNodeSchema
    })]));

export const metadataPatchSchema = z.object({
    display_name: z.string().optional().nullable(),
    tags: z.array(z.string()).optional()
});

export const ownershipSchema = z.union([z.literal("owned"), z.literal("observed"), z.literal("unknown")]);

export const paneOriginSchema = z.union([z.literal("live"), z.literal("restored"), z.literal("resumed")]);

export const paneSourceSchema = z.object({
    kind: z.string(),
    id: z.string(),
    label: z.string()
});

export const paneKindSchema = z.union([z.literal("terminal"), z.literal("browser")]);

export const paneCreateSchema = z.object({
    worktree_id: z.string().nullable(),
    tab_id: z.string().nullable(),
    cwd: z.string().nullable(),
    command: z.array(z.string()).nullable(),
    title: z.string().nullable()
});

export const paneSchema = z.object({
    id: z.string(),
    tab_id: z.string(),
    worktree_id: z.string(),
    title: z.string(),
    user_title: z.string().nullable(),
    cwd: z.string(),
    cols: z.number(),
    rows: z.number(),
    pid: z.number().nullable(),
    live: z.boolean(),
    origin: paneOriginSchema,
    exit_code: z.number().nullable(),
    agent: agentPresenceSchema.nullable(),
    created_at_ms: z.number(),
    action_id: z.string().nullable(),
    source: paneSourceSchema.nullable(),
    process_cmd: z.string().nullable(),
    kind: paneKindSchema,
    url: z.string().nullable()
});

export const tabSchema = z.object({
    id: z.string(),
    worktree_id: z.string(),
    title: z.string(),
    position: z.number(),
    layout: layoutNodeSchema,
    active_pane_id: z.string().nullable(),
    is_active: z.boolean()
});

export const prStatusResultSchema = z.object({
    available: z.boolean(),
    reason: z.string().nullable(),
    pr: pullRequestSchema.nullable()
});

export const processInfoSchema = z.object({
    pid: z.number(),
    ppid: z.number().nullable(),
    name: z.string(),
    cmd: z.string(),
    cwd: z.string().nullable(),
    cpu_percent: z.number(),
    rss_bytes: z.number(),
    start_time_s: z.number(),
    worktree_id: z.string().nullable(),
    pane_id: z.string().nullable(),
    ownership: ownershipSchema,
    depth: z.number()
});

export const rpcErrorSchema = z.object({
    code: errorCodeSchema,
    message: z.string()
});

export const runtimeActivitySchema = z.literal("endpoint_discovered");

export const runtimeProtocolSchema = z.union([z.literal("http"), z.literal("https"), z.literal("tcp")]);

export const runtimeEndpointSchema = z.object({
    id: z.string(),
    worktree_id: z.string(),
    pane_id: z.string().nullable(),
    action_id: z.string().nullable(),
    pid: z.number(),
    process: z.string(),
    protocol: runtimeProtocolSchema,
    host: z.string(),
    port: z.number(),
    label: z.string().nullable(),
    discovered_at_ms: z.number(),
    source: paneSourceSchema.nullable()
});

export const statusSchema = z.object({
    protocol: z.number(),
    version: z.string(),
    daemon_pid: z.number(),
    session_id: z.string(),
    started_at_ms: z.number(),
    socket_path: z.string(),
    data_dir: z.string(),
    repos: z.number(),
    worktrees: z.number(),
    panes: z.number(),
    live_panes: z.number(),
    agents: z.number(),
    clients: z.number(),
    integrations: integrationsSchema
});

export const worktreeSchema = z.object({
    id: z.string(),
    repo_id: z.string(),
    path: z.string(),
    name: z.string(),
    branch: z.string().nullable(),
    head: z.string(),
    detached: z.boolean(),
    is_main: z.boolean(),
    exists: z.boolean(),
    git: gitSummarySchema.nullable(),
    metadata: worktreeMetadataSchema,
    last_active_ms: z.number().nullable(),
    first_seen_ms: z.number().nullable(),
    archived_at_ms: z.number().nullable(),
    archiving: z.boolean(),
    tab_count: z.number(),
    pane_count: z.number()
});

export const spawnResultSchema = z.object({
    pane: paneSchema,
    tab: tabSchema,
    agent: agentPresenceSchema.nullable()
});

export const townSchema = z.object({
    slug: z.string(),
    name: z.string(),
    ja: z.string(),
    pref: z.string(),
    kind: z.string(),
    population: z.number().nullable(),
    lat: z.number(),
    lon: z.number(),
    wiki: z.string(),
    rarity: z.string()
});

export const townWorktreeStatusSchema = z.union([z.literal("active"), z.literal("archived"), z.literal("missing"), z.literal("gone")]);

export const townPrSchema = z.object({
    number: z.number(),
    url: z.string(),
    state: z.string()
});

export const usageBucketSchema = z.object({
    label: z.string(),
    fraction_used: z.number().nullable(),
    resets_at_ms: z.number().nullable(),
    detail: z.string().nullable(),
    scope: z.string().optional()
});

export const usageSnapshotSchema = z.object({
    provider: agentKindSchema,
    available: z.boolean(),
    reason: z.string().nullable(),
    buckets: z.array(usageBucketSchema),
    fetched_at_ms: z.number()
});

export const worktreeCreateSchema = z.object({
    repo_id: z.string(),
    branch: z.string(),
    new_branch: z.boolean(),
    start_ref: z.string().nullable(),
    path: z.string().nullable(),
    name_hint: z.string().nullable(),
    metadata: metadataPatchSchema.optional()
});

export const worktreeOpenedSchema = z.object({
    worktree: worktreeSchema,
    tabs: z.array(tabSchema)
});

export const actionRunResultSchema = z.object({
    action: actionDefSchema,
    pane: paneSchema.nullable(),
    reused: z.boolean()
});

export const hookDefSchema = z.object({
    event: z.string(),
    command: z.string(),
    tag: z.string().nullable(),
    mode: hookModeSchema,
    timeout_s: z.number()
});

export const configIssueSchema = z.object({
    level: issueLevelSchema,
    key: z.string(),
    message: z.string()
});

export const configSchema = z.object({
    shell: z.string(),
    editor_command: z.array(z.string()),
    worktree_parent_dir: z.string().nullable(),
    branch_prefix: z.string(),
    resource_warning_bytes: z.number(),
    scrollback_lines: z.number(),
    vt_engine: z.string(),
    font_family: z.string(),
    font_size: z.number(),
    theme: themeConfigSchema,
    max_panes_per_tab: z.number(),
    keybindings: z.any(),
    agents: z.any(),
    hooks: z.array(hookDefSchema),
    notifications: notificationSettingsSchema
});

export const hookEventSchema = z.object({
    event: z.string(),
    at_ms: z.number(),
    worktree: hookWorktreeSchema.nullable(),
    previous_tags: z.array(z.string()).optional(),
    pane: hookPaneSchema.nullable(),
    agent: hookAgentSchema.nullable(),
    attention: attentionItemSchema.nullable(),
    action: hookActionSchema.nullable()
});

export const paneResultSchema = z.object({
    pane: paneSchema,
    tab: tabSchema
});

export const snapshotSchema = z.object({
    usage: z.array(usageSnapshotSchema),
    actions: z.array(actionSetSchema),
    endpoints: z.array(runtimeEndpointSchema),
    status: statusSchema,
    config: configSchema,
    repos: z.array(repoSchema),
    worktrees: z.array(worktreeSchema),
    tabs: z.array(tabSchema),
    panes: z.array(paneSchema),
    agents: z.array(agentPresenceSchema),
    attention: z.array(attentionItemSchema),
    resources: z.array(worktreeResourcesSchema),
    ui_state: z.unknown()
});

export const townHistorySchema = z.object({
    unlock: townUnlockSchema,
    repo_name: z.string().nullable(),
    worktree_name: z.string().nullable(),
    branch: z.string().nullable(),
    status: townWorktreeStatusSchema,
    final_commit: z.string().nullable(),
    archived_at_ms: z.number().nullable(),
    pr: townPrSchema.nullable()
});

export const eventSchema = z.union([z.object({
        "event": z.literal("endpoints_changed"),
        "data": z.object({
            worktree_id: z.string(),
            endpoints: z.array(runtimeEndpointSchema)
        })
    }), z.object({
        "event": z.literal("activity_added"),
        "data": z.object({
            event: activityEventSchema
        })
    }), z.object({
        "event": z.literal("attention_resolved"),
        "data": z.object({
            id: z.string()
        })
    }), z.object({
        "event": z.literal("usage_changed"),
        "data": z.object({
            snapshots: z.array(usageSnapshotSchema)
        })
    }), z.object({
        "event": z.literal("repos_changed"),
        "data": z.object({
            repos: z.array(repoSchema)
        })
    }), z.object({
        "event": z.literal("worktrees_changed"),
        "data": z.object({
            worktrees: z.array(worktreeSchema)
        })
    }), z.object({
        "event": z.literal("metadata_changed"),
        "data": z.object({
            worktree_id: z.string(),
            metadata: worktreeMetadataSchema
        })
    }), z.object({
        "event": z.literal("worktree_archiving"),
        "data": z.object({
            worktree_id: z.string()
        })
    }), z.object({
        "event": z.literal("tabs_changed"),
        "data": z.object({
            worktree_id: z.string(),
            tabs: z.array(tabSchema)
        })
    }), z.object({
        "event": z.literal("pane_output"),
        "data": z.object({
            pane_id: z.string(),
            data_base64: z.string()
        })
    }), z.object({
        "event": z.literal("pane_changed"),
        "data": z.object({
            pane: paneSchema
        })
    }), z.object({
        "event": z.literal("pane_exited"),
        "data": z.object({
            pane_id: z.string(),
            exit_code: z.number().nullable()
        })
    }), z.object({
        "event": z.literal("agent_changed"),
        "data": z.object({
            agent: agentPresenceSchema
        })
    }), z.object({
        "event": z.literal("agent_removed"),
        "data": z.object({
            pane_id: z.string()
        })
    }), z.object({
        "event": z.literal("attention_added"),
        "data": z.object({
            item: attentionItemSchema
        })
    }), z.object({
        "event": z.literal("attention_viewed"),
        "data": z.object({
            id: z.string()
        })
    }), z.object({
        "event": z.literal("attention_cleared")
    }), z.object({
        "event": z.literal("resources"),
        "data": z.object({
            worktrees: z.array(worktreeResourcesSchema)
        })
    }), z.object({
        "event": z.literal("focus_request"),
        "data": z.object({
            worktree_id: z.string(),
            tab_id: z.string(),
            pane_id: z.string()
        })
    }), z.object({
        "event": z.literal("zoom_request"),
        "data": z.object({
            tab_id: z.string(),
            pane_id: z.string().nullable()
        })
    }), z.object({
        "event": z.literal("notice"),
        "data": z.object({
            level: noticeLevelSchema,
            message: z.string()
        })
    }), z.object({
        "event": z.literal("town_unlocked"),
        "data": z.object({
            unlock: townUnlockSchema
        })
    }), z.object({
        "event": z.literal("pr_changed"),
        "data": z.object({
            worktree_id: z.string(),
            pr: pullRequestSchema.nullable()
        })
    }), z.object({
        "event": z.literal("hook_ran"),
        "data": z.object({
            run: hookRunSchema
        })
    }), z.object({
        "event": z.literal("actions_changed"),
        "data": z.object({
            set: actionSetSchema
        })
    }), z.object({
        "event": z.literal("config_changed"),
        "data": z.object({
            config: configSchema
        })
    }), z.object({
        "event": z.literal("diagnostic"),
        "data": z.object({
            diagnostic: diagnosticSchema
        })
    }), z.object({
        "event": z.literal("system_stats"),
        "data": z.object({
            stats: systemStatsSchema
        })
    })]);
