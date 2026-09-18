//! What a pane has on its screen.
//!
//! The daemon owns the pty, so it can also own the terminal state. An engine takes the bytes
//! that came back and answers what the screen looks like, which lets `tomo` and a hook read a
//! pane without a window, and lets a client render from a grid instead of a byte stream.

use rio_vt::ansi::CursorShape;
use rio_vt::crosswords::{Crosswords, CrosswordsSize};
use rio_vt::event::{VoidListener, WindowId};
use rio_vt::performer::handler::Processor;
use serde::{Deserialize, Serialize};

/// Which engine reads the pty. `Xterm` leaves the reading to the client, as it always was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VtEngine {
    #[default]
    Rio,
    Ghostty,
    Xterm,
}

impl VtEngine {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "rio" => Some(VtEngine::Rio),
            "ghostty" => Some(VtEngine::Ghostty),
            "xterm" => Some(VtEngine::Xterm),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            VtEngine::Rio => "rio",
            VtEngine::Ghostty => "ghostty",
            VtEngine::Xterm => "xterm",
        }
    }

    /// Whether this build can run the engine. `ghostty` needs the `ghostty` feature.
    pub fn available(self) -> bool {
        !matches!(self, VtEngine::Ghostty) || cfg!(feature = "ghostty")
    }
}

#[allow(dead_code, reason = "resize and rows land with pane_resize and the pane_text call")]
pub trait Screen: Send {
    fn write(&mut self, bytes: &[u8]);
    fn resize(&mut self, cols: u16, rows: u16);
    /// The visible screen, one string per row, trailing blanks trimmed.
    fn rows(&self) -> Vec<String>;
}

pub struct RioScreen {
    grid: Crosswords<VoidListener>,
    processor: Processor,
}

impl RioScreen {
    pub fn new(cols: u16, rows: u16, scrollback: usize) -> Self {
        RioScreen {
            grid: Crosswords::new(CrosswordsSize::new(cols as usize, rows as usize), CursorShape::Block, VoidListener {}, WindowId::from(0u64), 0, scrollback),
            processor: Processor::default(),
        }
    }
}

impl Screen for RioScreen {
    fn write(&mut self, bytes: &[u8]) {
        self.processor.advance(&mut self.grid, bytes);
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        self.grid.resize(CrosswordsSize::new(cols as usize, rows as usize));
    }

    fn rows(&self) -> Vec<String> {
        self.grid
            .visible_rows()
            .iter()
            .map(|row| {
                // An untouched cell reads as NUL, which is a blank on screen.
                let line: String = (0..row.len())
                    .map(|c| match row[rio_vt::crosswords::pos::Column(c)].c() {
                        '\0' => ' ',
                        ch => ch,
                    })
                    .collect();
                line.trim_end().to_string()
            })
            .collect()
    }
}

#[cfg(feature = "ghostty")]
pub struct GhosttyScreen {
    term: libghostty_vt::Terminal<'static, 'static>,
}

#[cfg(feature = "ghostty")]
impl GhosttyScreen {
    pub fn new(cols: u16, rows: u16, scrollback: usize) -> Option<Self> {
        libghostty_vt::Terminal::new(libghostty_vt::TerminalOptions { cols, rows, max_scrollback: scrollback }).ok().map(|term| GhosttyScreen { term })
    }
}

// SAFETY: the wrapper holds a `*mut` into libghostty, which is a state machine with no
// threads of its own. A pane's screen lives behind the daemon's one mutex, so only one thread
// touches it at a time, and it is never shared. `Send` holds; `Sync` would not.
#[cfg(feature = "ghostty")]
unsafe impl Send for GhosttyScreen {}

#[cfg(feature = "ghostty")]
impl Screen for GhosttyScreen {
    fn write(&mut self, bytes: &[u8]) {
        let _ = self.term.vt_write(bytes);
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        let _ = self.term.resize(cols, rows, 0, 0);
    }

    fn rows(&self) -> Vec<String> {
        Vec::new()
    }
}

/// The screen for a pane, or none when the client does the reading.
pub fn screen_for(engine: VtEngine, cols: u16, rows: u16, scrollback: usize) -> Option<Box<dyn Screen>> {
    match engine {
        VtEngine::Rio => Some(Box::new(RioScreen::new(cols, rows, scrollback))),
        #[cfg(feature = "ghostty")]
        VtEngine::Ghostty => GhosttyScreen::new(cols, rows, scrollback).map(|s| Box::new(s) as Box<dyn Screen>),
        #[cfg(not(feature = "ghostty"))]
        VtEngine::Ghostty => None,
        VtEngine::Xterm => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_engine_is_named_by_the_name_a_person_writes_in_the_config() {
        assert_eq!(VtEngine::parse("rio"), Some(VtEngine::Rio));
        assert_eq!(VtEngine::parse("ghostty"), Some(VtEngine::Ghostty));
        assert_eq!(VtEngine::parse("xterm"), Some(VtEngine::Xterm));
        assert_eq!(VtEngine::parse("nope"), None);
        for e in [VtEngine::Rio, VtEngine::Ghostty, VtEngine::Xterm] {
            assert_eq!(VtEngine::parse(e.name()), Some(e));
        }
        assert_eq!(VtEngine::default(), VtEngine::Rio);
    }

    #[test]
    fn rio_reads_a_screen_the_way_a_terminal_does() {
        let mut s = RioScreen::new(20, 4, 100);
        s.write(b"hello");
        assert_eq!(s.rows()[0], "hello");

        s.write(b"\r\nsecond");
        assert_eq!(s.rows()[1], "second");

        // colour is state, not text
        s.write(b"\x1b[2J\x1b[H\x1b[31mred\x1b[0m");
        assert_eq!(s.rows()[0], "red");

        // cursor addressing puts a word where it was asked to
        s.write(b"\x1b[3;5Hthere");
        assert_eq!(s.rows()[2], "    there");
    }

    #[test]
    fn the_client_engine_keeps_no_screen_in_the_daemon() {
        assert!(screen_for(VtEngine::Xterm, 80, 24, 100).is_none());
        assert!(screen_for(VtEngine::Rio, 80, 24, 100).is_some());
        assert!(VtEngine::Xterm.available());
        assert_eq!(VtEngine::Ghostty.available(), cfg!(feature = "ghostty"));
    }
}
