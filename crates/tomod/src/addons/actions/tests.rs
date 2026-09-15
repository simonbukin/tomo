use crate::config::Paths;
use crate::daemon::Daemon;
use crate::{addons, dispatch};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tomo_proto::*;

const TOML: &str = r#"[[actions]]
id = "serve"
label = "Serve"
command = "touch marker-serve; sleep 30"
show = "topbar"

[[actions]]
id = "quick"
command = "true"

[[actions]]
id = "fail"
command = "exit 3"

[[actions]]
id = "mark"
command = "touch marker-ext"
mode = "external"
"#;

struct Fixture {
    daemon: Arc<Daemon>,
    dir: PathBuf,
    repo: PathBuf,
    worktree_id: Id,
}

fn git(dir: &Path, args: &[&str]) {
    let ok = std::process::Command::new("git").args(["-c", "user.email=t@t", "-c", "user.name=t"]).args(args).current_dir(dir).output().unwrap().status.success();
    assert!(ok, "git {args:?}");
}

fn hooks_toml(events: &Path) -> String {
    ["action.started", "action.exited", "action.crashed"]
        .iter()
        .map(|e| format!("[[hooks]]\nevent = \"{e}\"\ncommand = \"printf '%s\\\\n' \\\"$TOMO_EVENT_JSON\\\" >> {}\"\n", events.display()))
        .collect::<Vec<_>>()
        .join("\n")
}

async fn start(dir: &Path) -> Arc<Daemon> {
    let daemon = Daemon::new(Paths::new(dir.join("data")), addons::seams()).unwrap();
    addons::migrate(&daemon.lock().store).unwrap();
    daemon.lock().config.shell = "/bin/sh".into();
    daemon
}

async fn fixture(name: &str) -> Fixture {
    let dir = PathBuf::from(format!("/tmp/tomo-addons-actions-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(dir.join("data")).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    std::fs::write(repo.join(".tomo.toml"), TOML).unwrap();
    std::fs::write(dir.join("data/config.toml"), hooks_toml(&dir.join("events.log"))).unwrap();
    let daemon = start(&dir).await;
    call(&daemon, Call::RepoAdd { path: repo.clone() }).await.unwrap();
    let worktrees: Vec<Worktree> = serde_json::from_value(call(&daemon, Call::WorktreeList).await.unwrap()).unwrap();
    let worktree_id = worktrees.iter().find(|w| w.is_main).unwrap().id.clone();
    Fixture { daemon, dir, repo, worktree_id }
}

async fn call(daemon: &Arc<Daemon>, call: Call) -> Result<Value, RpcError> {
    dispatch::handle(daemon, 0, call).await
}

async fn eventually(what: &str, check: impl Fn() -> bool) {
    for _ in 0..200 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

impl Fixture {
    async fn run(&self, action_id: &str) -> Result<ActionRunResult, RpcError> {
        call(&self.daemon, Call::ActionRun { worktree_id: self.worktree_id.clone(), action_id: action_id.into() }).await.map(|v| serde_json::from_value(v).unwrap())
    }

    async fn restart(&self, action_id: &str) -> ActionRunResult {
        serde_json::from_value(call(&self.daemon, Call::ActionRestart { worktree_id: self.worktree_id.clone(), action_id: action_id.into() }).await.unwrap()).unwrap()
    }

    async fn stop(&self, action_id: &str) {
        call(&self.daemon, Call::ActionStop { worktree_id: self.worktree_id.clone(), action_id: action_id.into() }).await.unwrap();
    }

    fn pane(&self, pane_id: &str) -> Option<Pane> {
        Daemon::pane_view(&self.daemon.lock(), pane_id)
    }

    fn activity(&self) -> Vec<ActivityEvent> {
        self.daemon.lock().store.activity_list(&ActivityQuery { worktree_id: Some(self.worktree_id.clone()), ..Default::default() }, &[]).unwrap()
    }

    fn kinds(&self, action_id: &str) -> Vec<String> {
        let mut kinds: Vec<String> = self.activity().into_iter().filter(|e| e.payload["action_id"] == action_id).map(|e| e.kind.as_str().to_string()).collect();
        kinds.reverse();
        kinds
    }

    fn attention(&self) -> Vec<AttentionItem> {
        self.daemon.lock().store.attention_list().unwrap()
    }

    fn hook_events(&self) -> Vec<(String, String, bool)> {
        std::fs::read_to_string(self.dir.join("events.log"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<HookEvent>(l).ok())
            .map(|e| (e.event, e.action.map(|a| format!("{}:{}", a.id, a.label)).unwrap_or_default(), e.pane.is_some()))
            .collect()
    }

    fn finish(self) {
        self.daemon.shutdown();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn actions_list_run_reuse_stop_restart_and_exit_outcomes() {
    let f = fixture("run").await;
    let set: ActionSet = serde_json::from_value(call(&f.daemon, Call::ActionList { worktree_id: f.worktree_id.clone() }).await.unwrap()).unwrap();
    assert_eq!(set.actions.iter().map(|a| (a.id.as_str(), a.label.as_str(), a.mode, a.show)).collect::<Vec<_>>(), [
        ("serve", "Serve", ActionMode::Pane, ActionShow::Topbar),
        ("quick", "quick", ActionMode::Pane, ActionShow::Menu),
        ("fail", "fail", ActionMode::Pane, ActionShow::Menu),
        ("mark", "mark", ActionMode::External, ActionShow::Menu),
    ]);
    let snapshot: Snapshot = serde_json::from_value(call(&f.daemon, Call::Subscribe).await.unwrap()).unwrap();
    assert_eq!(snapshot.actions.iter().map(|s| (s.worktree_id.as_str(), s.actions.len())).collect::<Vec<_>>(), [(f.worktree_id.as_str(), 4)]);

    let first = f.run("serve").await.unwrap();
    let pane = first.pane.clone().unwrap();
    assert_eq!((pane.action_id.as_deref(), pane.user_title.as_deref(), first.reused), (Some("serve"), Some("Serve"), false));
    let again = f.run("serve").await.unwrap();
    assert_eq!((again.pane.unwrap().id, again.reused), (pane.id.clone(), true), "a second run reuses the live pane");

    f.stop("serve").await;
    assert!(f.pane(&pane.id).is_none(), "stop removes the pane");
    f.stop("serve").await;
    let restarted = f.restart("serve").await;
    let restarted_again = f.restart("serve").await;
    let (p1, p2) = (restarted.pane.unwrap().id, restarted_again.pane.unwrap().id);
    assert!(p1 != p2 && f.pane(&p1).is_none() && f.pane(&p2).is_some(), "restart stops the pane and starts a new one");
    f.stop("serve").await;
    assert_eq!(f.kinds("serve"), ["action_started", "action_stopped", "action_started", "action_stopped", "action_started", "action_stopped"]);

    let failed = f.run("fail").await.unwrap().pane.unwrap();
    eventually("fail to exit", || f.pane(&failed.id).and_then(|p| p.exit_code) == Some(3)).await;
    eventually("the crash activity", || f.kinds("fail").len() == 2).await;
    let crash = f.attention().into_iter().find(|a| a.kind == AttentionKind::Crash).expect("crash attention");
    assert_eq!((crash.message.as_str(), crash.pane_id.as_deref(), crash.level), ("fail exited with code 3", Some(failed.id.as_str()), AttentionLevel::Attention));
    let crashed = f.activity().into_iter().find(|e| e.kind.as_str() == "action_crashed").unwrap();
    assert_eq!((crashed.title.as_str(), crashed.detail.as_deref(), crashed.attention_id.as_deref()), ("fail crashed", Some("exit code 3"), Some(crash.id.as_str())));
    assert_eq!(crashed.payload, serde_json::json!({ "action_id": "fail", "exit_code": 3, "pane_id": failed.id }));
    assert_eq!(f.pane(&failed.id).map(|p| p.live), Some(false), "a non-zero exit keeps the pane");

    let quick = f.run("quick").await.unwrap().pane.unwrap();
    eventually("quick to finish", || f.pane(&quick.id).is_none()).await;
    assert_eq!(f.kinds("quick"), ["action_started", "action_completed"]);

    let external = f.run("mark").await.unwrap();
    assert!(external.pane.is_none() && !external.reused);
    eventually("the external marker", || f.repo.join("marker-ext").exists()).await;
    assert_eq!(f.kinds("mark"), ["action_started"]);
    assert_eq!(f.activity().iter().find(|e| e.payload["action_id"] == "mark").unwrap().pane_id, None);

    assert_eq!(f.run("nope").await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(f.attention().iter().filter(|a| a.kind == AttentionKind::Crash).count(), 1, "stop and exit 0 raise no crash");

    eventually("the hook events", || f.hook_events().iter().any(|(e, _, _)| e == "action.crashed") && f.hook_events().iter().filter(|(e, a, _)| e == "action.exited" && a == "quick:quick").count() == 1).await;
    let events = f.hook_events();
    for expected in [("action.started", "serve:Serve", true), ("action.exited", "serve:Serve", true), ("action.exited", "fail:fail", true), ("action.crashed", "fail:fail", true), ("action.started", "mark:mark", false)] {
        assert!(events.contains(&(expected.0.to_string(), expected.1.to_string(), expected.2)), "missing {expected:?} in {events:?}");
    }
    assert!(!events.iter().any(|(e, a, _)| e == "action.exited" && a == "mark:mark"), "an external action has no exit event");
    f.finish();
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_an_action_pane_records_nothing_and_a_shell_exit_is_no_crash() {
    let f = fixture("close").await;
    let pane = f.run("serve").await.unwrap().pane.unwrap();
    call(&f.daemon, Call::PaneClose { pane_id: pane.id.clone(), force: true }).await.unwrap();
    let shell: Value = call(&f.daemon, Call::PaneCreate(PaneCreate { worktree_id: Some(f.worktree_id.clone()), command: Some(vec!["/bin/sh".into(), "-c".into(), "exit 1".into()]), ..Default::default() })).await.unwrap();
    let shell_id = shell["pane"]["id"].as_str().unwrap().to_string();
    eventually("the shell to exit", || f.pane(&shell_id).and_then(|p| p.exit_code) == Some(1)).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(f.pane(&pane.id).is_none());
    assert_eq!(f.kinds("serve"), ["action_started"], "a pane close records no action_stopped");
    assert!(f.attention().is_empty(), "only an Action exit raises a crash");
    assert!(!f.hook_events().iter().any(|(e, _, _)| e == "action.exited"));
    f.finish();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restored_action_pane_is_a_shell_that_does_not_rerun() {
    let f = fixture("restore").await;
    let pane = f.run("serve").await.unwrap().pane.unwrap();
    eventually("the serve marker", || f.repo.join("marker-serve").exists()).await;
    f.daemon.shutdown();
    std::fs::remove_file(f.repo.join("marker-serve")).unwrap();
    let daemon = start(&f.dir).await;
    daemon.restore().unwrap();
    call(&daemon, Call::WorktreeRefresh).await.unwrap();
    let restored = Daemon::pane_view(&daemon.lock(), &pane.id).expect("restored pane");
    assert_eq!((restored.origin, restored.action_id.as_deref(), restored.user_title.as_deref()), (PaneOrigin::Restored, None, Some("Serve")));
    let rerun: ActionRunResult = serde_json::from_value(call(&daemon, Call::ActionRun { worktree_id: f.worktree_id.clone(), action_id: "serve".into() }).await.unwrap()).unwrap();
    assert!(!rerun.reused && rerun.pane.unwrap().id != pane.id, "the restored shell is not the running action");
    let stored = daemon.lock().store.panes().unwrap();
    assert!(stored.iter().any(|p| p.id == pane.id), "the restored pane row stays");
    daemon.shutdown();
    let _ = std::fs::remove_dir_all(&f.dir);
}
