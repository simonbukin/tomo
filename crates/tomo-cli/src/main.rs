mod client;
mod print;

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use std::path::PathBuf;
use tomo_proto::*;

#[derive(Parser)]
#[command(name = "tomo", version, about = "Tomo: repositories, worktrees, terminals, and agents from the command line")]
struct Cli {
    #[arg(long, global = true, help = "Print structured JSON")]
    json: bool,
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    #[command(about = "Show daemon status and counts")]
    Status,
    #[command(subcommand, about = "Control the tomod daemon")]
    Daemon(DaemonCmd),
    #[command(subcommand, about = "Known repositories")]
    Repo(RepoCmd),
    #[command(subcommand, about = "Git worktrees and their metadata")]
    Worktree(WorktreeCmd),
    #[command(subcommand, about = "Terminal panes")]
    Pane(PaneCmd),
    #[command(subcommand, about = "Terminal tabs")]
    Tab(TabCmd),
    #[command(subcommand, about = "Coding agents")]
    Agent(AgentCmd),
    #[command(about = "Processes that belong to worktrees")]
    Ps {
        #[arg(long, help = "Worktree id, or a path inside it, or '.'")]
        worktree: Option<String>,
    },
    #[command(about = "Raise attention for the current pane or worktree")]
    Notify {
        message: String,
        #[arg(long, default_value = "attention", value_parser = ["attention", "info"])]
        level: String,
        #[arg(long)]
        worktree: Option<String>,
    },
    #[command(subcommand, about = "Attention items")]
    Attention(AttentionCmd),
    #[command(about = "Receive an agent hook payload on stdin (used by hook configs)")]
    Hook {
        #[arg(value_parser = ["claude", "codex", "pi"])]
        agent: String,
    },
    #[command(subcommand, about = "Agent hook and extension installation")]
    Integrations(IntegrationsCmd),
    #[command(subcommand, about = "Japanese towns that name new worktrees")]
    Towns(TownsCmd),
    #[command(about = "Claude and Codex sessions rooted at a worktree")]
    Sessions {
        worktree: Option<String>,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    #[command(about = "Kill an owned process tree by pid")]
    Kill { pid: u32 },
    #[command(about = "Show the GitHub pull request for a worktree's branch (needs gh)")]
    Pr { worktree: Option<String> },
    #[command(subcommand, about = "Configuration")]
    Config(ConfigCmd),
    #[command(subcommand, about = "Workflow hooks")]
    Hooks(HooksCmd),
    #[command(subcommand, about = "Workflow states")]
    States(StatesCmd),
    #[command(subcommand, about = "Repo-defined actions from .tomo.toml")]
    Action(ActionCmd),
}

#[derive(Subcommand)]
enum ConfigCmd {
    #[command(about = "Validate config.toml and report problems")]
    Check,
}

#[derive(Subcommand)]
enum HooksCmd {
    #[command(about = "Show recent hook runs")]
    Log {
        #[arg(short = 'n', long, default_value_t = 20)]
        limit: usize,
    },
}

#[derive(Subcommand)]
enum StatesCmd {
    List,
}

#[derive(Subcommand)]
enum ActionCmd {
    List { worktree: Option<String> },
    Run { action: String, worktree: Option<String> },
    Stop { action: String, worktree: Option<String> },
    Restart { action: String, worktree: Option<String> },
}

#[derive(Subcommand)]
enum DaemonCmd {
    Status,
    Start,
    Stop,
}

#[derive(Subcommand)]
enum RepoCmd {
    List,
    Add { path: PathBuf },
    Remove { repo: String },
    Clone { url: String, dest: PathBuf },
}

#[derive(Subcommand)]
enum WorktreeCmd {
    List,
    #[command(about = "Show the worktree that contains the current directory")]
    Current,
    Refresh,
    Create {
        #[arg(long, help = "Repo id or path")]
        repo: String,
        #[arg(long)]
        branch: String,
        #[arg(long, help = "Create the branch")]
        new: bool,
        #[arg(long, help = "Starting ref for a new branch")]
        from: Option<String>,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long, help = "Town slug to name the worktree directory (default: random)")]
        town: Option<String>,
    },
    #[command(about = "Open a worktree: make sure it has a terminal and focus it in the GUI")]
    Open { worktree: String },
    #[command(about = "Stop its processes, remove build dirs, and remove the worktree; the branch stays")]
    Archive {
        worktree: String,
        #[arg(long, help = "Refuse when the tree has uncommitted changes")]
        no_checkpoint: bool,
        #[arg(long, help = "Throw away uncommitted changes instead of committing a checkpoint")]
        discard: bool,
    },
    #[command(about = "Re-create an archived worktree from its branch")]
    Restore { worktree: String },
    #[command(subcommand)]
    Metadata(MetadataCmd),
}

#[derive(Subcommand)]
enum MetadataCmd {
    Get { worktree: Option<String> },
    Set {
        worktree: Option<String>,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        project: Option<String>,
        #[arg(long, help = "Comma-separated tags; replaces the tag list")]
        tags: Option<String>,
        #[arg(long, help = "Workflow state id from config.toml")]
        state: Option<String>,
        #[arg(long)]
        clear_state: bool,
        #[arg(long)]
        clear_name: bool,
        #[arg(long)]
        clear_project: bool,
        #[arg(long)]
        clear_tags: bool,
    },
}

#[derive(Subcommand)]
enum PaneCmd {
    List {
        #[arg(long)]
        worktree: Option<String>,
    },
    Create {
        #[arg(long)]
        worktree: Option<String>,
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(long)]
        tab: Option<String>,
        #[arg(long)]
        title: Option<String>,
        #[arg(last = true, help = "Command to run instead of a shell")]
        command: Vec<String>,
    },
    Split {
        pane: Option<String>,
        #[arg(long, help = "Split downward (alias: --vertical)")]
        down: bool,
        #[arg(long, hide = true)]
        vertical: bool,
        #[arg(long, help = "Split to the right (default)")]
        right: bool,
        #[arg(last = true)]
        command: Vec<String>,
    },
    #[command(about = "Swap two panes in the same tab")]
    Swap { pane_a: String, pane_b: String },
    #[command(about = "Toggle zoom on a pane in the GUI")]
    Zoom { pane: Option<String> },
    Focus { pane: Option<String> },
    Send {
        text: String,
        #[arg(long)]
        pane: Option<String>,
        #[arg(long, help = "Do not append a newline")]
        no_newline: bool,
    },
    Close {
        pane: Option<String>,
        #[arg(long)]
        force: bool,
    },
    Rename {
        title: String,
        #[arg(long)]
        pane: Option<String>,
    },
    #[command(about = "Kill every process under the pane's shell")]
    KillTree { pane: Option<String> },
}

#[derive(Subcommand)]
enum TabCmd {
    List { worktree: Option<String> },
    Create {
        worktree: Option<String>,
        #[arg(long)]
        title: Option<String>,
    },
    Rename { tab: String, title: String },
    Close {
        tab: String,
        #[arg(long)]
        force: bool,
    },
    #[command(about = "Give every pane in the tab the same size")]
    Equalize { tab: Option<String> },
    #[command(about = "Flip the split around the active pane")]
    Rotate { tab: Option<String> },
}

#[derive(Subcommand)]
enum AgentCmd {
    List {
        #[arg(long)]
        worktree: Option<String>,
    },
    Spawn {
        #[arg(value_parser = ["claude", "codex", "pi"])]
        agent: String,
        #[arg(long)]
        worktree: Option<String>,
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(long, help = "Split the current pane instead of opening a new one")]
        split: bool,
        #[arg(long, help = "Native session reference to resume")]
        resume: Option<String>,
        #[arg(last = true)]
        args: Vec<String>,
    },
}

#[derive(Subcommand)]
enum AttentionCmd {
    List,
    Next,
    Clear,
}

#[derive(Subcommand)]
enum TownsCmd {
    List {
        #[arg(long)]
        unlocked: bool,
    },
    Pick,
}

#[derive(Subcommand)]
enum IntegrationsCmd {
    Status,
    #[command(about = "Add Tomo hooks to Claude and Codex user settings and install the Pi extension")]
    Install,
}

fn worktree_ref(arg: Option<String>) -> Result<Value> {
    match arg.or_else(|| std::env::var("TOMO_WORKTREE_ID").ok()) {
        Some(a) if a == "." || a.contains('/') => Ok(json!({ "path": std::fs::canonicalize(&a).unwrap_or_else(|_| PathBuf::from(a)) })),
        Some(id) => Ok(json!({ "id": id })),
        None => Ok(json!({ "path": std::env::current_dir()? })),
    }
}

async fn resolve_worktree_id(c: &client::Client, arg: Option<String>) -> Result<String> {
    let r = worktree_ref(arg)?;
    if let Some(id) = r.get("id").and_then(Value::as_str) {
        return Ok(id.to_string());
    }
    let path: PathBuf = serde_json::from_value(r["path"].clone())?;
    let w: Worktree = c.call(Call::WorktreeResolve { path }).await?;
    Ok(w.id)
}

async fn tab_ref(c: &client::Client, arg: Option<String>) -> Result<String> {
    if let Some(t) = arg.or_else(|| std::env::var("TOMO_TAB_ID").ok()) {
        return Ok(t);
    }
    let pane = pane_ref(None)?;
    let panes: Vec<Pane> = c.call(Call::PaneList { worktree_id: None }).await?;
    panes.into_iter().find(|p| p.id == pane).map(|p| p.tab_id).ok_or_else(|| anyhow!("pane {pane} not found"))
}

fn pane_ref(arg: Option<String>) -> Result<String> {
    arg.or_else(|| std::env::var("TOMO_PANE_ID").ok()).ok_or_else(|| anyhow!("pane id required (or run inside a Tomo terminal)"))
}

async fn resolve_repo_id(c: &client::Client, arg: &str) -> Result<String> {
    let repos: Vec<Repo> = c.call(Call::RepoList).await?;
    let canon = std::fs::canonicalize(arg).ok();
    repos
        .iter()
        .find(|r| r.id == arg || r.name == arg || Some(&r.path) == canon.as_ref())
        .map(|r| r.id.clone())
        .ok_or_else(|| anyhow!("repo {arg} not known; add it with `tomo repo add <path>`"))
}

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("tomo: {e:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();
    let json = cli.json;
    match cli.command {
        Cmd::Hook { agent } => return hook(&agent).await,
        Cmd::Daemon(DaemonCmd::Status) => {
            return match client::Client::connect().await {
                Ok(c) => {
                    let s: Status = c.call(Call::Status).await?;
                    print::status(&s, json);
                    Ok(())
                }
                Err(_) => {
                    if json {
                        println!("{}", json!({ "running": false, "socket": client::socket_path() }));
                    } else {
                        println!("tomod is not running ({})", client::socket_path().display());
                    }
                    std::process::exit(3);
                }
            }
        }
        Cmd::Daemon(DaemonCmd::Start) => {
            let c = client::Client::connect_or_start().await?;
            let s: Status = c.call(Call::Status).await?;
            print::status(&s, json);
            return Ok(());
        }
        Cmd::Daemon(DaemonCmd::Stop) => {
            return match client::Client::connect().await {
                Ok(c) => {
                    let _: Value = c.call(Call::DaemonStop).await?;
                    if !json {
                        println!("tomod stopping");
                    }
                    Ok(())
                }
                Err(_) => {
                    if !json {
                        println!("tomod is not running");
                    }
                    Ok(())
                }
            }
        }
        _ => {}
    }

    let c = client::Client::connect_or_start().await?;
    match cli.command {
        Cmd::Status => {
            let s: Status = c.call(Call::Status).await?;
            print::status(&s, json);
        }
        Cmd::Repo(RepoCmd::List) => {
            let repos: Vec<Repo> = c.call(Call::RepoList).await?;
            print::repos(&repos, json);
        }
        Cmd::Repo(RepoCmd::Add { path }) => {
            let r: Repo = c.call(Call::RepoAdd { path: std::fs::canonicalize(&path).unwrap_or(path) }).await?;
            print::repos(&[r], json);
        }
        Cmd::Repo(RepoCmd::Remove { repo }) => {
            let id = resolve_repo_id(&c, &repo).await?;
            let _: Value = c.call(Call::RepoRemove { repo_id: id }).await?;
        }
        Cmd::Repo(RepoCmd::Clone { url, dest }) => {
            let r: Repo = c.call(Call::RepoClone { url, dest }).await?;
            print::repos(&[r], json);
        }
        Cmd::Worktree(WorktreeCmd::List) => {
            let ws: Vec<Worktree> = c.call(Call::WorktreeList).await?;
            let repos: Vec<Repo> = c.call(Call::RepoList).await?;
            let agents: Vec<AgentPresence> = c.call(Call::AgentList { worktree_id: None }).await?;
            print::worktrees(&ws, &repos, &agents, json);
        }
        Cmd::Worktree(WorktreeCmd::Refresh) => {
            let ws: Vec<Worktree> = c.call(Call::WorktreeRefresh).await?;
            let repos: Vec<Repo> = c.call(Call::RepoList).await?;
            print::worktrees(&ws, &repos, &[], json);
        }
        Cmd::Worktree(WorktreeCmd::Current) => {
            let id = resolve_worktree_id(&c, None).await?;
            let ws: Vec<Worktree> = c.call(Call::WorktreeList).await?;
            let repos: Vec<Repo> = c.call(Call::RepoList).await?;
            let w = ws.into_iter().find(|w| w.id == id).ok_or_else(|| anyhow!("worktree vanished"))?;
            print::worktrees(&[w], &repos, &[], json);
        }
        Cmd::Worktree(WorktreeCmd::Create { repo, branch, new, from, path, town }) => {
            let repo_id = resolve_repo_id(&c, &repo).await?;
            let w: Worktree = c.call(Call::WorktreeCreate(WorktreeCreate { repo_id, branch, new_branch: new, start_ref: from, path, town_slug: town })).await?;
            let repos: Vec<Repo> = c.call(Call::RepoList).await?;
            print::worktrees(&[w], &repos, &[], json);
        }
        Cmd::Worktree(WorktreeCmd::Open { worktree }) => {
            let id = resolve_worktree_id(&c, Some(worktree)).await?;
            let v: Value = c.call(Call::WorktreeOpen { worktree_id: id }).await?;
            if let Some(pane) = v["tabs"].as_array().and_then(|t| t.iter().find(|t| t["is_active"] == true).or(t.first())).and_then(|t| t["active_pane_id"].as_str()) {
                let _: Value = c.call(Call::PaneFocus { pane_id: pane.to_string() }).await?;
            }
            print::value(&v, json);
        }
        Cmd::Worktree(WorktreeCmd::Archive { worktree, no_checkpoint, discard }) => {
            let id = resolve_worktree_id(&c, Some(worktree)).await?;
            let checkpoint = if discard { CheckpointMode::Discard } else if no_checkpoint { CheckpointMode::RequireClean } else { CheckpointMode::Checkpoint };
            let r: ArchiveResult = c.call(Call::WorktreeArchive { worktree_id: id, checkpoint }).await?;
            print::archive_result(&r, json);
        }
        Cmd::Action(ActionCmd::List { worktree }) => {
            let id = resolve_worktree_id(&c, worktree).await?;
            let set: ActionSet = c.call(Call::ActionList { worktree_id: id }).await?;
            print::actions(&set, json);
        }
        Cmd::Action(ActionCmd::Run { action, worktree }) => {
            let id = resolve_worktree_id(&c, worktree).await?;
            let r: ActionRunResult = c.call(Call::ActionRun { worktree_id: id, action_id: action }).await?;
            print::action_run(&r, json);
        }
        Cmd::Action(ActionCmd::Restart { action, worktree }) => {
            let id = resolve_worktree_id(&c, worktree).await?;
            let r: ActionRunResult = c.call(Call::ActionRestart { worktree_id: id, action_id: action }).await?;
            print::action_run(&r, json);
        }
        Cmd::Action(ActionCmd::Stop { action, worktree }) => {
            let id = resolve_worktree_id(&c, worktree).await?;
            let _: Value = c.call(Call::ActionStop { worktree_id: id, action_id: action }).await?;
        }
        Cmd::Worktree(WorktreeCmd::Restore { worktree }) => {
            let id = resolve_worktree_id(&c, Some(worktree)).await?;
            let w: Worktree = c.call(Call::WorktreeRestore { worktree_id: id }).await?;
            let repos: Vec<Repo> = c.call(Call::RepoList).await?;
            print::worktrees(&[w], &repos, &[], json);
        }
        Cmd::Sessions { worktree, limit } => {
            let id = resolve_worktree_id(&c, worktree).await?;
            let list: Vec<AgentSession> = c.call(Call::SessionList { worktree_id: id, limit: Some(limit) }).await?;
            print::sessions(&list, json);
        }
        Cmd::Towns(TownsCmd::List { unlocked }) => {
            let v: Value = c.call(Call::TownList).await?;
            let towns: Vec<Town> = serde_json::from_value(v["towns"].clone())?;
            let unlocks: Vec<TownUnlock> = serde_json::from_value(v["unlocks"].clone())?;
            print::towns(&towns, &unlocks, unlocked, json);
        }
        Cmd::Towns(TownsCmd::Pick) => {
            let t: Town = c.call(Call::TownPick).await?;
            print::towns(&[t], &[], false, json);
        }
        Cmd::Worktree(WorktreeCmd::Metadata(MetadataCmd::Get { worktree })) => {
            let id = resolve_worktree_id(&c, worktree).await?;
            let m: WorktreeMetadata = c.call(Call::MetadataGet { worktree_id: id }).await?;
            print::metadata(&m, json);
        }
        Cmd::Worktree(WorktreeCmd::Metadata(MetadataCmd::Set { worktree, name, project, tags, state, clear_state, clear_name, clear_project, clear_tags })) => {
            let id = resolve_worktree_id(&c, worktree).await?;
            let patch = MetadataPatch {
                display_name: if clear_name { Some(None) } else { name.map(Some) },
                project: if clear_project { Some(None) } else { project.map(Some) },
                state: if clear_state { Some(None) } else { state.map(Some) },
                tags: if clear_tags { Some(vec![]) } else { tags.map(|t| t.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()) },
            };
            let m: WorktreeMetadata = c.call(Call::MetadataSet { worktree_id: id, patch }).await?;
            print::metadata(&m, json);
        }
        Cmd::Pane(PaneCmd::List { worktree }) => {
            let worktree_id = match worktree {
                Some(w) => Some(resolve_worktree_id(&c, Some(w)).await?),
                None => None,
            };
            let panes: Vec<Pane> = c.call(Call::PaneList { worktree_id }).await?;
            print::panes(&panes, json);
        }
        Cmd::Pane(PaneCmd::Create { worktree, cwd, tab, title, command }) => {
            let worktree_id = match (&worktree, &cwd) {
                (None, None) => Some(resolve_worktree_id(&c, None).await?),
                (Some(w), _) => Some(resolve_worktree_id(&c, Some(w.clone())).await?),
                (None, Some(_)) => None,
            };
            let cwd = cwd.map(|p| std::fs::canonicalize(&p).unwrap_or(p));
            let v: Value = c.call(Call::PaneCreate(PaneCreate { worktree_id, tab_id: tab, cwd, command: (!command.is_empty()).then_some(command), title })).await?;
            print::pane_result(&v, json);
        }
        Cmd::Pane(PaneCmd::Split { pane, down, vertical, right: _, command }) => {
            let v: Value = c
                .call(Call::PaneSplit {
                    pane_id: pane_ref(pane)?,
                    direction: if down || vertical { SplitDirection::Vertical } else { SplitDirection::Horizontal },
                    command: (!command.is_empty()).then_some(command),
                })
                .await?;
            print::pane_result(&v, json);
        }
        Cmd::Pane(PaneCmd::Focus { pane }) => {
            let _: Value = c.call(Call::PaneFocus { pane_id: pane_ref(pane)? }).await?;
        }
        Cmd::Pane(PaneCmd::Send { text, pane, no_newline }) => {
            let data = if no_newline { text } else { format!("{text}\n") };
            let _: Value = c.call(Call::PaneSend { pane_id: pane_ref(pane)?, data_base64: base64::engine::general_purpose::STANDARD.encode(data) }).await?;
        }
        Cmd::Pane(PaneCmd::Close { pane, force }) => {
            let _: Value = c.call(Call::PaneClose { pane_id: pane_ref(pane)?, force }).await?;
        }
        Cmd::Pane(PaneCmd::Rename { title, pane }) => {
            let _: Value = c.call(Call::PaneRename { pane_id: pane_ref(pane)?, title: Some(title) }).await?;
        }
        Cmd::Pane(PaneCmd::Swap { pane_a, pane_b }) => {
            let _: Value = c.call(Call::PaneSwap { pane_a, pane_b }).await?;
        }
        Cmd::Pane(PaneCmd::Zoom { pane }) => {
            let _: Value = c.call(Call::PaneZoom { pane_id: Some(pane_ref(pane)?), tab_id: None }).await?;
        }
        Cmd::Pane(PaneCmd::KillTree { pane }) => {
            let _: Value = c.call(Call::PaneKillTree { pane_id: pane_ref(pane)? }).await?;
        }
        Cmd::Tab(TabCmd::List { worktree }) => {
            let id = resolve_worktree_id(&c, worktree).await?;
            let v: Value = c.call(Call::WorktreeOpen { worktree_id: id }).await?;
            print::value(&v["tabs"], json);
        }
        Cmd::Tab(TabCmd::Create { worktree, title }) => {
            let id = resolve_worktree_id(&c, worktree).await?;
            let t: Tab = c.call(Call::TabCreate { worktree_id: id, title }).await?;
            print::value(&serde_json::to_value(t)?, json);
        }
        Cmd::Tab(TabCmd::Rename { tab, title }) => {
            let _: Value = c.call(Call::TabRename { tab_id: tab, title }).await?;
        }
        Cmd::Tab(TabCmd::Close { tab, force }) => {
            let _: Value = c.call(Call::TabClose { tab_id: tab, force }).await?;
        }
        Cmd::Tab(TabCmd::Equalize { tab }) => {
            let tab_id = tab_ref(&c, tab).await?;
            let _: Value = c.call(Call::LayoutEqualize { tab_id }).await?;
        }
        Cmd::Tab(TabCmd::Rotate { tab }) => {
            let tab_id = tab_ref(&c, tab).await?;
            let _: Value = c.call(Call::LayoutRotate { tab_id, split_id: None }).await?;
        }
        Cmd::Agent(AgentCmd::List { worktree }) => {
            let worktree_id = match worktree {
                Some(w) => Some(resolve_worktree_id(&c, Some(w)).await?),
                None => None,
            };
            let agents: Vec<AgentPresence> = c.call(Call::AgentList { worktree_id }).await?;
            print::agents(&agents, json);
        }
        Cmd::Agent(AgentCmd::Spawn { agent, worktree, cwd, split, resume, args }) => {
            let kind: AgentKind = agent.parse().map_err(|e: String| anyhow!(e))?;
            let split_from = if split { Some(pane_ref(None)?) } else { None };
            let cwd = cwd.map(|p| std::fs::canonicalize(&p).unwrap_or(p));
            let worktree_id = match (&worktree, &cwd, &split_from) {
                (Some(w), _, _) => Some(resolve_worktree_id(&c, Some(w.clone())).await?),
                (None, None, None) => Some(resolve_worktree_id(&c, None).await?),
                _ => None,
            };
            let r: SpawnResult = c.call(Call::AgentSpawn(AgentSpawn { kind, worktree_id, cwd, tab_id: None, split_from, resume, new_tab: false, extra_args: args })).await?;
            print::spawn(&r, json);
        }
        Cmd::Ps { worktree } => {
            let worktree_id = match worktree {
                Some(w) => Some(resolve_worktree_id(&c, Some(w)).await?),
                None => None,
            };
            let procs: Vec<ProcessInfo> = c.call(Call::Ps { worktree_id }).await?;
            let ws: Vec<Worktree> = c.call(Call::WorktreeList).await?;
            print::ps(&procs, &ws, json);
        }
        Cmd::Notify { message, level, worktree } => {
            let pane_id = std::env::var("TOMO_PANE_ID").ok();
            let worktree_id = match (worktree, &pane_id) {
                (Some(w), _) => Some(resolve_worktree_id(&c, Some(w)).await?),
                (None, Some(_)) => None,
                (None, None) => Some(resolve_worktree_id(&c, None).await?),
            };
            let level = if level == "info" { AttentionLevel::Info } else { AttentionLevel::Attention };
            let _: Value = c.call(Call::Notify { pane_id, worktree_id, level, message }).await?;
        }
        Cmd::Attention(AttentionCmd::List) => {
            let items: Vec<AttentionItem> = c.call(Call::AttentionList).await?;
            print::attention(&items, json);
        }
        Cmd::Attention(AttentionCmd::Next) => {
            let item: Option<AttentionItem> = c.call(Call::AttentionNext).await?;
            match item {
                Some(item) => {
                    if let Some(p) = &item.pane_id {
                        let _: Value = c.call(Call::PaneFocus { pane_id: p.clone() }).await?;
                    }
                    let _: Value = c.call(Call::AttentionView { id: item.id.clone() }).await?;
                    print::attention(&[item], json);
                }
                None => {
                    if json {
                        println!("null");
                    } else {
                        println!("nothing needs attention");
                    }
                }
            }
        }
        Cmd::Attention(AttentionCmd::Clear) => {
            let _: Value = c.call(Call::AttentionClear).await?;
        }
        Cmd::Integrations(IntegrationsCmd::Status) => {
            let s: Vec<IntegrationStatus> = c.call(Call::IntegrationsStatus).await?;
            print::integration_status(&s, json);
        }
        Cmd::Config(ConfigCmd::Check) => {
            let issues: Vec<ConfigIssue> = c.call(Call::ConfigCheck).await?;
            print::config_issues(&issues, json);
            if issues.iter().any(|i| i.level == IssueLevel::Error) {
                std::process::exit(2);
            }
        }
        Cmd::Hooks(HooksCmd::Log { limit }) => {
            let runs: Vec<HookRun> = c.call(Call::HookLog { limit: Some(limit) }).await?;
            print::hook_runs(&runs, json);
        }
        Cmd::States(StatesCmd::List) => {
            let cfg: Config = c.call(Call::ConfigGet).await?;
            print::states(&cfg.states, json);
        }
        Cmd::Integrations(IntegrationsCmd::Install) => {
            let i: Integrations = c.call(Call::IntegrationsInstall).await?;
            print::integrations(&i, json);
        }
        Cmd::Pr { worktree } => {
            let id = resolve_worktree_id(&c, worktree).await?;
            let r: PrStatusResult = c.call(Call::PrStatus { worktree_id: id }).await?;
            print::pr(&r, json);
        }
        Cmd::Kill { pid } => {
            let _: Value = c.call(Call::ProcessKillTree { pid }).await?;
        }
        Cmd::Hook { .. } | Cmd::Daemon(_) => unreachable!(),
    }
    Ok(())
}

async fn hook(agent: &str) -> Result<()> {
    let Ok(pane_id) = std::env::var("TOMO_PANE_ID") else { return Ok(()) };
    let kind: AgentKind = agent.parse().map_err(|e: String| anyhow!(e))?;
    let mut input = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut input).context("read hook payload")?;
    let payload: Value = serde_json::from_str(input.trim()).unwrap_or(Value::Null);
    if payload.is_null() {
        return Ok(());
    }
    let Ok(c) = client::Client::connect().await else { return Ok(()) };
    let _: Value = c.call(Call::AgentHook { kind, pane_id, payload, at_ms: now_ms() }).await.unwrap_or(Value::Null);
    Ok(())
}
