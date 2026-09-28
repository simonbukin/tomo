# Editor panes

An editor pane shows one text file of its worktree for a quick edit. It
sits in the layout tree like a terminal pane. It has no PTY, no shell, and
no pid. It is not a full editor: it has no language server, no file tree,
and no project search. Use `editor_command` for large work.

Agents often write the same file while it is open. The editor must never
lose an edit, and it must never write over a change that the user did not
see. The rules below make that true.

## Surface model

`Pane.kind` is `editor`. The pane carries `Pane.editor`:

```json
{ "path": "src/main.rs", "line": 12, "col": 4 }
```

`path` is relative to the worktree root. `line` and `col` start at 1 and
hold the last cursor position. The `panes` table keeps them in the
`editor` column as JSON, so the pane opens the same file at the same
place after a daemon restart or a GUI restart. The text is not kept:
unsaved edits are lost when the GUI stops.

The pane title is the file name. The daemon refuses `pane_send`,
`pane_resize`, and `pane_attach` on an editor pane with `bad_request`.
`pane_close`, `pane_move`, `pane_swap`, zoom, rename, and the layout calls
work as for any pane. `tab_reopen` brings back an editor pane with its file
and cursor (`ClosedPane::Editor`).

The code is Core, like Browser: `crates/tomod/src/features/editor_pane.rs`
(the calls, the file access, the watch) and `app/src/editor/` (the pane,
the model, and the CodeMirror setup). `features/editor.rs` is a different
thing: it starts the external `editor_command`.

## Calls

| Call | Params | Result |
|------|--------|--------|
| `editor_open` | `worktree_id`, `path`, `line?`, `col?`, `tab_id?` | `{ pane, tab }`. Without `tab_id`, a new tab named after the file. `path` is relative to the worktree, or absolute inside it. A file that does not exist yet is allowed when its folder exists. |
| `editor_cursor` | `pane_id`, `line`, `col` | `null`. Stores the cursor. The GUI sends it 800 ms after the cursor stops. |
| `fs_read` | `worktree_id`, `path` | `FileText { path, content, version, mtime_ms }` |
| `fs_write` | `worktree_id`, `path`, `content`, `expected_version` | `FileWritten { version, mtime_ms }` |

Event: `file_changed { worktree_id, path }`. The daemon sends it when a file
that an editor pane shows changes on disk, or goes away.

### Containment

Every call resolves the path with `resolve` in `editor_pane.rs`:

1. A path with a `..` component is refused.
2. The daemon joins a relative path to the worktree root, then makes it
   canonical. So a symlink resolves to its target.
3. For a file that does not exist, the daemon makes the folder canonical
   and adds the name.
4. The result must start with the canonical worktree root. If it does
   not, the call fails with `bad_request` and the text
   `<path> is outside the worktree`.

A symlink inside the worktree that points inside the worktree is allowed.
The editor then reads and writes the target, and the link stays.

### Limits

| Case | Error |
|------|-------|
| The file is larger than 2 MB (`MAX_BYTES`) | `unsupported`: `<path> is 3.1 MB; the editor opens files up to 2 MB` |
| The file has a NUL byte, or it is not UTF-8 | `unsupported`: `<path> is a binary file; the editor opens UTF-8 text only` |
| The file does not exist | `not_found`: `<path> does not exist` |
| The path is a folder | `bad_request`: `<path> is a folder` |
| The path leaves the worktree | `bad_request`: `<path> is outside the worktree` |

The pane shows a read error in its body with `Try again` and
`Open in external editor`.

## Versions and conflicts

The version is `<size in hex>-<64-bit hash of the bytes>`. It changes when
the bytes change, and only then. A `touch`, or an agent that writes the
same bytes again, does not change it. That is not a conflict, because no
text is lost.

`fs_write` is optimistic:

1. The daemon reads the file on disk and makes its version. A missing file
   has no version.
2. If that is not `expected_version`, the write fails with `conflict`. The
   message says `changed`, `was deleted`, or `already exists`. The file on
   disk does not change.
3. Else the daemon writes the text to `.<name>.tomo-<pid>-<nanos>.tmp` in
   the same folder, calls `fsync`, gives it the mode of the old file, and
   renames it over the file. A reader sees the old file or the new file,
   never a part of one. On an error the temporary file is removed.
4. Just before the rename, the daemon reads the version again. If it
   changed during the write and the `fsync`, the write fails with
   `conflict` and the temporary file is removed.
5. The reply carries the new version.

`expected_version: null` means "the file must not exist". The editor uses
it to create a new file, and to create again a file that was deleted.

A small window stays open between the second check and the rename: a
write by an agent in that window is lost. The window is the length of one
`rename` call.

## The watch

`editor_pane::watch` runs in the daemon. It watches the folder of each
file that an editor pane shows (`notify`, not recursive). It watches the
folder, not the file, because an agent often writes a new file and renames
it over the old one, and a watch on the old file stops at the rename. It
reads the set of open files again when an editor pane opens, and every 10
seconds. Events that come within 40 ms make one `file_changed` for each
file.

## Buffer rules

The GUI keeps a buffer for each editor pane in `app/src/editor/sessions.ts`.
The buffer outlives the pane view, so a tab switch or a pane move keeps the
edits, the undo history, the cursor, and the scroll. The buffer goes when
the pane leaves the store.

The rules are the pure functions in `app/src/editor/model.ts`, with tests in
`model.test.ts`. `cm.ts` applies them. Reads and saves of one pane run one
after the other, so the event of a save never looks like a change by
someone else.

The model holds the base (the version that the buffer was read from or
saved to), `dirty`, a notice, and `overwrite`.

| Event | Buffer without edits | Buffer with edits |
|-------|----------------------|-------------------|
| The disk has the base version | nothing | nothing; a notice goes away |
| The disk has a new version | reload the text in silence | keep the edits; show `Changed on disk` |
| The file is deleted | keep the text; show `Not on disk` | keep the edits; show `Not on disk` |
| The file comes back | reload the text | show `Changed on disk` |

A reload applies the smallest change (`minimalChange`), so the cursor and
the scroll stay. Undo can take the reload back.

The `Changed on disk` bar has three actions:

- **Reload** replaces the buffer with the disk text. Undo brings the edits
  back.
- **Compare** shows the buffer and the disk text side by side
  (`@codemirror/merge`, read-only). The bar stays, so the user can choose.
- **Keep mine** hides the bar. The next save asks `Replace the file on
  disk?` and then writes over that disk version. If the disk changes again,
  the bar comes back.

A save (Cmd+S) with the bar open also asks first. A plain save writes
against the base version. A save that gets `conflict` keeps the edits,
reads the disk, and shows the bar. Any other save error shows a toast and
a red line in the bar.

The legend and the tab show `●` before the file name while the buffer has
edits. Undo back to the saved text removes the dot. Closing a pane or a tab
with edits asks `Discard and close`. The archive dialog names the files with
unsaved edits, because an archive closes the panes. `close others` asks for each tab, and
the last question wins; a tab that the user did not confirm stays open.

## Editing

CodeMirror 6 with line numbers, folding, bracket match, search, undo, and
multiple selections. Soft wrap is off. A file with CRLF line ends keeps them: the buffer uses
`\r\n` as its line separator, so a save does not rewrite every line. The language comes from the file
name (`@codemirror/language-data`) and loads after the first paint. The
theme reads the slab tokens, so it follows dark and light with no second
theme. The code font is the terminal font (`[terminal] font_family` and
`font_size`).

| Key | Action |
|-----|--------|
| Cmd+S | Save (`editor_save`, a registry command) |
| Cmd+P | Open a file of the worktree (`open_file`) |
| Cmd+F | Search and replace |
| Cmd+G, Shift+Cmd+G | Next and previous match |
| Cmd+L | Go to line (`12`, `12:4`, `+5`, `50%`) |
| Cmd+Z, Shift+Cmd+Z | Undo and redo |
| Tab, Shift+Tab | Indent and outdent. Press Esc first to move the focus with Tab. |

A Tomo key wins over a CodeMirror key: Cmd+D splits the pane, Cmd+W closes
it, Cmd+K opens the palette. The one exception: Shift with an arrow key
stays in the editor, because it extends a selection. So in an editor
pane, Shift+Cmd+Left and Shift+Cmd+Right select to the line ends and do
not change the tab. See [keyboard.md](keyboard.md).

## Entry points

- Terminal Cmd-click on `path`, `path:line`, or `path:line:col` inside the
  worktree opens it in an editor pane at that place. A path outside the
  worktree opens in `editor_command`. The right-click menu has
  `Open in pane` and `Open in editor`.
- The Files section of the inspector: a click on a file opens it in a pane.
  The file menu has `open in pane` and `open in editor`.
- The palette: `Open file...` (Cmd+P) lists the files of `fs_recent`,
  newest change first, and matches the path.
- A second open of a file that a pane already shows focuses that pane and
  moves the cursor.

## Speed

The editor code is its own chunk (`cm-*.js`, 106 kB, and the CodeMirror
core in a shared chunk of 267 kB). The main bundle does not load it. The
app starts to download it 1.5 s after the start, so the first open does not
wait for it. Languages load on demand, one chunk each.

Measured on an M-series Mac with debug binaries:

| Step | 28 kB file | 146 kB file | 1.8 MB file |
|------|------------|-------------|-------------|
| `fs_read` over the socket, median of 20 | 0.8 ms | 3.7 ms | 50 ms |
| `fs_write` | 5.8 ms | 5.7 ms | 25 ms |
| mount to first paint, in the dev page | 9 to 24 ms | 12 to 25 ms | 11 to 18 ms |

`editor_open` takes about 1 ms. The pane records each first paint as a
`performance.measure` named `editor paint <path>`.

## Dev page

`#editor-lab` in the dev server shows editor panes on a fake disk, with no
daemon. `window.editorLab` writes and deletes files as an agent does, so the
reload, notice, compare, and conflict paths show in a browser.

## Tests

- `editor_pane.rs`: containment (`..`, absolute paths, symlinks out),
  binary and size refusal, conflict, an identical write, and an atomic
  write that keeps the mode.
- `store.rs`: the `editor` column round trip. `reopen.rs`: an editor pane
  comes back from a closed tab.
- `app/src/editor/model.test.ts`: the table above. `editor.test.ts`: the
  close confirms and the path rules.
- `scripts/torture/editor.sh`: the calls over the socket with the real
  daemon: containment, conflict, atomic write under a reader, binary
  refusal, the watch, and restore.

## Not done

- Unsaved edits do not survive a GUI restart or a quit, and a quit does not
  ask.
- No autosave, no soft-wrap toggle, no editable merge.
- A file that is open in two worktrees has two panes with no link.
- The GUI finds an open pane for a path with a plain prefix test on the
  worktree path. A path with another spelling of the same folder (for
  example `/tmp` and `/private/tmp`) opens a second pane, or goes to the
  external editor. The two buffers cannot overwrite each other: the second
  save gets `conflict`.
