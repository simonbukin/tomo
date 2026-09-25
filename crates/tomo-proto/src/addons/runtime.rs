//! Runtime endpoint discovery wire types: observed listening sockets owned by pane process trees.

use crate::{ActivityKinds, Id, PaneSource};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeProtocol {
    Http,
    Https,
    Tcp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RuntimeEndpoint {
    pub id: Id,
    pub worktree_id: Id,
    pub pane_id: Option<Id>,
    /// `PaneSource::action_id` of the pane source, for installed clients that read it.
    pub action_id: Option<String>,
    pub pid: u32,
    pub process: String,
    pub protocol: RuntimeProtocol,
    /// The status of `HEAD /` when the port speaks HTTP. Below 400 means the port serves a page.
    #[serde(default)]
    pub status: Option<u16>,
    /// True while the port is not HTTP yet and the probe will try again, for example while a dev server compiles.
    #[serde(default)]
    pub probing: bool,
    pub host: String,
    pub port: u16,
    pub label: Option<String>,
    pub discovered_at_ms: u64,
    /// The source of the pane when the endpoint was found. A client finds the endpoints of one source by it.
    #[serde(default)]
    pub source: Option<PaneSource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum RuntimeActivity {
    #[serde(rename = "endpoint_discovered")]
    EndpointDiscovered,
}

impl ActivityKinds for RuntimeActivity {}

impl RuntimeEndpoint {
    /// One word or two for people: `page 200`, `http 404`, `checking`, or `tcp`.
    pub fn summary(&self) -> String {
        match (self.protocol, self.status, self.probing) {
            (RuntimeProtocol::Tcp, _, true) => "checking".into(),
            (RuntimeProtocol::Tcp, _, false) => "tcp".into(),
            (_, Some(s), _) if s < 400 => format!("page {s}"),
            (_, Some(s), _) => format!("http {s}"),
            (_, None, _) => "http".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_names_what_a_port_serves() {
        let e = |protocol, status, probing| RuntimeEndpoint {
            id: "1:3000".into(),
            worktree_id: "w".into(),
            pane_id: None,
            action_id: None,
            pid: 1,
            process: "node".into(),
            protocol,
            status,
            probing,
            host: "localhost".into(),
            port: 3000,
            label: None,
            discovered_at_ms: 0,
            source: None,
        };
        let got: Vec<String> = [
            e(RuntimeProtocol::Tcp, None, true),
            e(RuntimeProtocol::Tcp, None, false),
            e(RuntimeProtocol::Http, Some(307), false),
            e(RuntimeProtocol::Http, Some(404), false),
            e(RuntimeProtocol::Http, None, false),
        ]
        .iter()
        .map(RuntimeEndpoint::summary)
        .collect();
        assert_eq!(got, ["checking", "tcp", "page 307", "http 404", "http"]);
    }
}
