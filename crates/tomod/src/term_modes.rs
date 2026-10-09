//! The terminal modes that a program in a pane switched on, read from its output.
//!
//! A pane keeps only the tail of its raw output, so a long session loses the start, where a full-screen program
//! switches to the alternate screen and turns on mouse reporting. A client that replays only the tail would draw the
//! program's frames on the normal screen, and the mouse wheel would never reach the program. This tracker sees every
//! byte before the tail is cut, so it can give a new client the modes as they are now.

use std::collections::BTreeMap;

const ALT_SCREEN: [u16; 3] = [1049, 1047, 47];
/// Mouse reporting (9, 1000, 1002, 1003) and its encodings (1005, 1006, 1015, 1016).
const MOUSE: [u16; 8] = [9, 1000, 1002, 1003, 1005, 1006, 1015, 1016];
/// Other modes that change what the client sends or shows: cursor keys, autowrap, cursor visible, keypad, focus
/// reports, and bracketed paste.
const OTHER: [u16; 6] = [1, 7, 25, 66, 1004, 2004];
/// The longest unfinished sequence that is carried to the next chunk. A longer one is not a mode switch.
const CARRY_MAX: usize = 64;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Modes {
    set: BTreeMap<u16, bool>,
    carry: Vec<u8>,
}

fn tracked(mode: u16) -> bool {
    ALT_SCREEN.contains(&mode) || MOUSE.contains(&mode) || OTHER.contains(&mode)
}

impl Modes {
    pub fn from_bytes(bytes: &[u8]) -> Self {
        let mut modes = Modes::default();
        modes.feed(bytes);
        modes
    }

    /// Reads the mode switches in `chunk`. A sequence that a chunk cuts is completed by the next chunk.
    pub fn feed(&mut self, chunk: &[u8]) {
        let bytes: Vec<u8> = std::mem::take(&mut self.carry).into_iter().chain(chunk.iter().copied()).collect();
        let mut at = 0;
        while let Some(esc) = bytes[at..].iter().position(|&b| b == 0x1b).map(|i| at + i) {
            match self.sequence(&bytes[esc..]) {
                Some(len) => at = esc + len,
                None => {
                    if bytes.len() - esc <= CARRY_MAX {
                        self.carry = bytes[esc..].to_vec();
                    }
                    return;
                }
            }
        }
    }

    /// Applies the escape sequence at the start of `s`. Returns its length, or `None` when the bytes end inside it.
    fn sequence(&mut self, s: &[u8]) -> Option<usize> {
        match s.get(1)? {
            b'c' => {
                self.set.clear();
                Some(2)
            }
            b'[' => {
                let private = s.get(2)? == &b'?';
                let start = if private { 3 } else { 2 };
                let end = s[start..].iter().position(|b| !(b.is_ascii_digit() || *b == b';' || *b == b'!')).map(|i| start + i)?;
                let params = &s[start..end];
                match (private, s[end], params) {
                    (false, b'p', b"!") => self.set.retain(|mode, _| !OTHER.contains(mode)),
                    (true, b'h' | b'l', _) => {
                        let on = s[end] == b'h';
                        for mode in params.split(|b| *b == b';').filter_map(|p| std::str::from_utf8(p).ok()?.parse::<u16>().ok()) {
                            if tracked(mode) {
                                self.set.insert(mode, on);
                            }
                        }
                    }
                    _ => {}
                }
                Some(end + 1)
            }
            _ => Some(1),
        }
    }

    fn on(&self, mode: u16) -> bool {
        self.set.get(&mode).copied().unwrap_or(false)
    }

    pub fn alt_screen(&self) -> bool {
        ALT_SCREEN.iter().any(|m| self.on(*m))
    }

    pub fn mouse(&self) -> bool {
        MOUSE[..4].iter().any(|m| self.on(*m))
    }

    /// The sequence that puts a fresh terminal in these modes, apart from the screen buffer. Mouse modes are all
    /// switched off first and then on again, because terminals track the mouse bits in different ways. Nothing when
    /// the program never switched a mode.
    pub fn restore(&self) -> Vec<u8> {
        if self.set.is_empty() {
            return Vec::new();
        }
        let mouse_on = MOUSE.iter().filter(|m| self.on(**m)).map(|m| format!("\x1b[?{m}h"));
        let other = OTHER.iter().filter_map(|m| self.set.get(m).map(|on| format!("\x1b[?{m}{}", if *on { 'h' } else { 'l' })));
        [Self::release_mouse(), mouse_on.chain(other).collect::<String>().into_bytes()].concat()
    }

    /// Ends a synchronized update and turns every mouse mode off, so the wheel scrolls the client again.
    pub fn release_mouse() -> Vec<u8> {
        std::iter::once("\x1b[?2026l".to_string()).chain(MOUSE.iter().map(|m| format!("\x1b[?{m}l"))).collect::<String>().into_bytes()
    }

    /// What a new client gets for a full-screen program in place of its old frames: the alternate screen, empty, in
    /// the program's modes. The program draws itself again when its size changes.
    pub fn alt_frame(&self) -> Vec<u8> {
        [b"\x1b[?2026l\x1b[0m\x1b[?1049h\x1b[2J\x1b[H".as_slice(), &self.restore()].concat()
    }

    /// The sequence that takes back what a program left on when it ended without cleaning up: the alternate screen
    /// and mouse reporting. Bracketed paste stays, because a shell turns it on for each prompt.
    pub fn disarm() -> &'static [u8] {
        b"\x1b[?2026l\x1b[?1049l\x1b[?1047l\x1b[?47l\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[?1004l\x1b[?25h"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODEX_START: &[u8] = b"\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?25l";

    #[test]
    fn a_full_screen_program_turns_on_the_alt_screen_and_the_mouse() {
        let m = Modes::from_bytes(CODEX_START);
        assert!(m.alt_screen() && m.mouse());
        let quit = Modes::from_bytes(&[CODEX_START, b"text\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l"].concat());
        assert!(!quit.alt_screen() && !quit.mouse());
    }

    #[test]
    fn a_sequence_that_two_chunks_cut_still_counts() {
        let mut m = Modes::default();
        for chunk in [&b"hello \x1b[?10"[..], b"49", b"h world \x1b", b"[?1003", b"h"] {
            m.feed(chunk);
        }
        assert!(m.alt_screen() && m.mouse());
    }

    #[test]
    fn several_modes_in_one_sequence_and_a_reset() {
        let m = Modes::from_bytes(b"\x1b[?1049;1000h");
        assert!(m.alt_screen() && m.mouse());
        assert_eq!(Modes::from_bytes(b"\x1b[?1049;1000h\x1bc"), Modes::default());
        let soft = Modes::from_bytes(b"\x1b[?1049;1003;25h\x1b[!p");
        assert!(soft.alt_screen() && soft.mouse(), "a soft reset keeps the screen buffer and the mouse");
        assert!(!String::from_utf8(soft.restore()).unwrap().contains("?25"));
    }

    #[test]
    fn disarm_turns_off_every_alt_screen_and_mouse_mode_that_the_tracker_knows() {
        let mut m = Modes::from_bytes(b"\x1b[?47h\x1b[?1047h\x1b[?1049h\x1b[?9h\x1b[?1003h");
        m.feed(Modes::disarm());
        assert!(!m.alt_screen() && !m.mouse());
    }

    #[test]
    fn other_sequences_and_text_change_nothing() {
        let m = Modes::from_bytes(b"\x1b[31mred\x1b[0m \x1b[2J\x1b[10;5H\x1b]0;title\x07 \x1b[?2026h\x1b[?2026l\x1b[1;20r");
        assert_eq!(m, Modes::default());
        assert!(m.restore().is_empty(), "a fresh terminal needs no restore");
    }

    #[test]
    fn restore_switches_the_mouse_off_then_on_and_keeps_explicit_modes() {
        let r = String::from_utf8(Modes::from_bytes(CODEX_START).restore()).unwrap();
        assert!(r.starts_with("\x1b[?2026l\x1b[?9l\x1b[?1000l"));
        let on = r.find("\x1b[?1000h").unwrap();
        assert!(r.find("\x1b[?1016l").unwrap() < on, "every mode goes off before one goes on: {r:?}");
        assert!(r.contains("\x1b[?1006h") && r.contains("\x1b[?2004h") && r.contains("\x1b[?25l"));
        assert!(!r.contains("1049"), "restore leaves the screen buffer to the caller");
    }

    #[test]
    fn the_alt_frame_is_an_empty_alt_screen_in_the_program_modes() {
        let f = String::from_utf8(Modes::from_bytes(CODEX_START).alt_frame()).unwrap();
        assert!(f.starts_with("\x1b[?2026l\x1b[0m\x1b[?1049h\x1b[2J\x1b[H"));
        assert!(f.contains("\x1b[?1003h"));
    }

    #[test]
    fn the_tracker_keeps_what_a_cut_tail_lost() {
        let session: Vec<u8> = [CODEX_START.to_vec(), b"\x1b[3;1Hframe ".repeat(5000)].concat();
        let tail = &session[session.len() - 1000..];
        assert!(!Modes::from_bytes(tail).alt_screen(), "the tail alone has no setup");
        assert!(Modes::from_bytes(&session).alt_screen());
    }
}
