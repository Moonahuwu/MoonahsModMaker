//! Surgical KV3 (`.vsndevts`) reader/merger for the Deadlock match-intro music tool.
//!
//! # Why surgical instead of a full parse/serialize round-trip
//!
//! The game's `music.vsndevts` is **shared by many mods**. The core design
//! principle (see the spec) is MERGE, NEVER REPLACE: we may only touch the
//! `vsnd_files` array entries we own and must leave every other byte of the file
//! intact. So instead of parsing the whole document to an AST and re-emitting it
//! (which would risk reformatting unrelated events and producing noisy diffs),
//! this module locates *only* the target event's array span and `vsnd_duration`
//! value by byte offset and splices replacements in place. Everything outside
//! those spans is preserved byte-for-byte.
//!
//! The functions here are deliberately decoupled from path derivation and
//! `project.json`: callers pass full reference strings (e.g.
//! `"sounds/music/match_intro/mysong.vsnd"`). Set membership is plain string
//! comparison.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// The KV3 text header that every `.vsndevts` source file must start with.
pub const KV3_TEXT_HEADER_PREFIX: &str = "<!-- kv3 encoding:text";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kv3Error {
    /// The file does not begin with the expected KV3 text header.
    MissingHeader,
    /// The named event key was not found as a top-level key.
    EventNotFound(String),
    /// The event was found but it has no `vsnd_files` array.
    ArrayNotFound(String),
    /// A brace/bracket/string was opened but never closed.
    Unterminated(&'static str),
}

impl std::fmt::Display for Kv3Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Kv3Error::MissingHeader => write!(f, "file is not KV3 text (missing header)"),
            Kv3Error::EventNotFound(e) => write!(f, "event not found: {e}"),
            Kv3Error::ArrayNotFound(e) => write!(f, "vsnd_files array not found in event: {e}"),
            Kv3Error::Unterminated(what) => write!(f, "unterminated {what}"),
        }
    }
}

impl std::error::Error for Kv3Error {}

type Result<T> = std::result::Result<T, Kv3Error>;

/// A request to merge our owned entries into one event's `vsnd_files` array.
///
/// All entry strings are full content-relative references ending in `.vsnd`,
/// exactly as they appear in the array.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventMerge {
    /// Top-level event key, e.g. `"Music.MatchIntro.MatchStart.King"`.
    pub event_name: String,
    /// Which array to edit (e.g. `vsnd_files` or
    /// `vsnd_files_opponent_control`). Defaults to `vsnd_files`.
    #[serde(default = "default_array_key")]
    pub array_key: String,
    /// Valve's stock entry; always kept as the first array element.
    pub stock_entry: String,
    /// Our desired owned entries, in the order they should appear (after stock
    /// and after all foreign entries).
    pub owned_in_order: Vec<String>,
    /// Reference strings we owned on a previous compile. Used to recognize and
    /// remove entries we no longer want; never treated as foreign.
    pub previous_owned: Vec<String>,
    /// If `Some`, overwrite the event's `vsnd_duration` value. If `None`, leave
    /// the existing duration untouched.
    pub new_duration: Option<f64>,
    /// Reference strings the user has explicitly DISABLED — dropped from the
    /// rebuilt array even though they are stock or foreign. Empty by default
    /// (the safe MERGE-NEVER-REPLACE behavior). Opt-in per entry from the UI.
    #[serde(default)]
    pub excluded: Vec<String>,
}

fn default_array_key() -> String {
    "vsnd_files".to_string()
}

/// A read-only view of one event's `vsnd_files` array (for the UI's "what's in
/// the pool" display).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventView {
    pub event_name: String,
    /// Which array these entries came from (e.g. `vsnd_files`).
    pub array_key: String,
    /// Reference strings in array order, quotes stripped.
    pub entries: Vec<String>,
    /// The event's `vsnd_duration`, if present and parseable.
    pub vsnd_duration: Option<f64>,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Validate that `text` looks like a KV3 text document.
pub fn validate_header(text: &str) -> Result<()> {
    if strip_bom(text).trim_start().starts_with(KV3_TEXT_HEADER_PREFIX) {
        Ok(())
    } else {
        Err(Kv3Error::MissingHeader)
    }
}

/// Read one event's `vsnd_files` array entries and duration (convenience).
pub fn read_event(text: &str, event_name: &str) -> Result<EventView> {
    read_event_array(text, event_name, "vsnd_files")
}

/// Read a specific array (`array_key`, e.g. `vsnd_files` or
/// `vsnd_files_opponent_control`) of an event, plus the event's duration.
pub fn read_event_array(text: &str, event_name: &str, array_key: &str) -> Result<EventView> {
    validate_header(text)?;
    let block = event_block(text, event_name)?;
    let (lb, rb) = find_array(text, block, array_key, event_name)?;
    let entries = parse_array_entries(text, lb, rb);
    let vsnd_duration = duration_value_span(text, block)
        .and_then(|(s, e)| text[s..e].trim().parse::<f64>().ok());
    Ok(EventView {
        event_name: event_name.to_string(),
        array_key: array_key.to_string(),
        entries,
        vsnd_duration,
    })
}

/// Apply a single event merge, returning the new file text. Every byte outside
/// the edited event's array (and optional duration value) is preserved exactly.
pub fn apply_merge(text: &str, edit: &EventMerge) -> Result<String> {
    validate_header(text)?;
    let block = event_block(text, &edit.event_name)?;
    let (lb, rb) = find_array(text, block, &edit.array_key, &edit.event_name)?;

    let existing = parse_array_entries(text, lb, rb);
    let rebuilt = rebuild_entries(&existing, edit);

    let le = detect_line_ending(text);
    let indent = bracket_indent(text, lb).to_string();
    let new_array = render_array(&rebuilt, &indent, le);

    // Collect non-overlapping replacements and apply highest-offset-first so
    // earlier byte indices stay valid.
    let mut edits: Vec<(usize, usize, String)> = vec![(lb, rb + 1, new_array)];
    if let Some(d) = edit.new_duration {
        if let Some((vs, ve)) = duration_value_span(text, block) {
            edits.push((vs, ve, format_duration(d)));
        }
    }
    edits.sort_by(|a, b| b.0.cmp(&a.0));

    let mut out = text.to_string();
    for (s, e, rep) in edits {
        out.replace_range(s..e, &rep);
    }
    Ok(out)
}

/// Apply several event merges in sequence. Each targets a distinct event, so
/// re-finding offsets per edit is correct even as the text grows/shrinks.
pub fn apply_merges(text: &str, edits: &[EventMerge]) -> Result<String> {
    let mut cur = text.to_string();
    for e in edits {
        cur = apply_merge(&cur, e)?;
    }
    Ok(cur)
}

// ---------------------------------------------------------------------------
// Merge partition (the heart of MERGE, NEVER REPLACE)
// ---------------------------------------------------------------------------

/// Rebuild an array as `[stock, ...foreign(original order), ...owned(in order)]`.
///
/// - The stock entry is always placed first (authoritative from project.json).
/// - Foreign = anything that is neither the stock entry nor a current/previous
///   owned entry. Foreign entries are preserved in their original order.
/// - Entries we previously owned but no longer want are dropped (they match the
///   owned set so they are excluded from foreign, and are not re-added).
fn rebuild_entries(existing: &[String], edit: &EventMerge) -> Vec<String> {
    let owned_set: HashSet<&str> = edit
        .owned_in_order
        .iter()
        .chain(edit.previous_owned.iter())
        .map(String::as_str)
        .collect();
    let excluded: HashSet<&str> = edit.excluded.iter().map(String::as_str).collect();

    let mut out = Vec::with_capacity(existing.len() + edit.owned_in_order.len() + 1);
    // Stock first, unless the user disabled it.
    if !excluded.contains(edit.stock_entry.as_str()) {
        out.push(edit.stock_entry.clone());
    }
    for e in existing {
        if e == &edit.stock_entry || owned_set.contains(e.as_str()) {
            continue;
        }
        if excluded.contains(e.as_str()) {
            continue; // foreign entry the user disabled
        }
        out.push(e.clone()); // foreign — preserved
    }
    for o in &edit.owned_in_order {
        if !excluded.contains(o.as_str()) {
            out.push(o.clone());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// Render `[ ... ]` matching the file's style: bracket on its own line, one
/// entry per line indented one tab deeper, each with a trailing comma.
fn render_array(entries: &[String], bracket_indent: &str, le: &str) -> String {
    let entry_indent = format!("{bracket_indent}\t");
    let mut s = String::from("[");
    s.push_str(le);
    for e in entries {
        s.push_str(&entry_indent);
        s.push('"');
        s.push_str(e);
        s.push_str("\",");
        s.push_str(le);
    }
    s.push_str(bracket_indent);
    s.push(']');
    s
}

/// Format a duration so integers keep one decimal (`27` -> `27.0`) while
/// non-integers round-trip to their shortest form (`28.874989`).
fn format_duration(v: f64) -> String {
    if v.fract() == 0.0 {
        format!("{v:.1}")
    } else {
        format!("{v}")
    }
}

// ---------------------------------------------------------------------------
// Span location (string-aware scanning)
// ---------------------------------------------------------------------------

/// Inclusive byte range `[brace_open ..= brace_close]` of an event's `{ ... }`.
fn event_block(text: &str, event_name: &str) -> Result<(usize, usize)> {
    let key = find_key_pos(text, 0, text.len(), event_name)
        .ok_or_else(|| Kv3Error::EventNotFound(event_name.to_string()))?;
    let after = &text[key + event_name.len()..];
    let brace_rel = after
        .find('{')
        .ok_or_else(|| Kv3Error::EventNotFound(event_name.to_string()))?;
    let brace_open = key + event_name.len() + brace_rel;
    let brace_close = matching_close(text, brace_open, b'{', b'}')
        .ok_or(Kv3Error::Unterminated("event block"))?;
    Ok((brace_open, brace_close))
}

/// Locate a named array (`array_key`) within an event block. Returns the byte
/// offsets of the opening `[` and closing `]`.
fn find_array(
    text: &str,
    block: (usize, usize),
    array_key: &str,
    event_name: &str,
) -> Result<(usize, usize)> {
    let (bopen, bclose) = block;
    let key = find_key_pos(text, bopen, bclose, array_key)
        .ok_or_else(|| Kv3Error::ArrayNotFound(format!("{event_name}.{array_key}")))?;
    let lb_rel = text[key..bclose]
        .find('[')
        .ok_or_else(|| Kv3Error::ArrayNotFound(event_name.to_string()))?;
    let lb = key + lb_rel;
    let rb = matching_close(text, lb, b'[', b']').ok_or(Kv3Error::Unterminated("array"))?;
    Ok((lb, rb))
}

/// Byte span of the `vsnd_duration` *value* (the number text) within a block.
fn duration_value_span(text: &str, block: (usize, usize)) -> Option<(usize, usize)> {
    let (bopen, bclose) = block;
    let key = find_key_pos(text, bopen, bclose, "vsnd_duration")?;
    let b = text.as_bytes();
    let mut j = key + "vsnd_duration".len();
    while j < bclose && matches!(b[j], b' ' | b'\t') {
        j += 1;
    }
    if j >= bclose || b[j] != b'=' {
        return None;
    }
    j += 1;
    while j < bclose && matches!(b[j], b' ' | b'\t') {
        j += 1;
    }
    let vstart = j;
    while j < bclose && !matches!(b[j], b'\n' | b'\r') {
        j += 1;
    }
    let mut vend = j;
    while vend > vstart && matches!(b[vend - 1], b' ' | b'\t') {
        vend -= 1;
    }
    Some((vstart, vend))
}

/// Find `key` used as a KV3 property/event key within `[from, to)`: preceded by
/// whitespace/`{`/start, and followed (after optional spaces) by `=`.
fn find_key_pos(text: &str, from: usize, to: usize, key: &str) -> Option<usize> {
    let b = text.as_bytes();
    let mut cur = from;
    while cur < to {
        let rel = text[cur..to].find(key)?;
        let pos = cur + rel;
        let before_ok =
            pos == 0 || matches!(b[pos - 1], b' ' | b'\t' | b'\n' | b'\r' | b'{');
        let mut j = pos + key.len();
        while j < to && matches!(b[j], b' ' | b'\t') {
            j += 1;
        }
        let after_ok = j < to && b[j] == b'=';
        if before_ok && after_ok {
            return Some(pos);
        }
        cur = pos + key.len();
    }
    None
}

/// String-aware matching-close finder. Tracks nesting depth and skips bracket
/// characters that appear inside double-quoted strings (with `\` escapes).
fn matching_close(text: &str, open_pos: usize, open: u8, close: u8) -> Option<usize> {
    let b = text.as_bytes();
    let mut i = open_pos + 1;
    let mut depth = 0usize;
    let mut in_str = false;
    while i < b.len() {
        let c = b[i];
        if in_str {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
        } else if c == open {
            depth += 1;
        } else if c == close {
            if depth == 0 {
                return Some(i);
            }
            depth -= 1;
        }
        i += 1;
    }
    None
}

/// Extract the quoted entries between an array's `[` and `]`.
fn parse_array_entries(text: &str, lbracket: usize, rbracket: usize) -> Vec<String> {
    let inner = &text[lbracket + 1..rbracket];
    let b = inner.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'"' {
            let start = i + 1;
            let mut j = start;
            while j < b.len() {
                if b[j] == b'\\' {
                    j += 2;
                    continue;
                }
                if b[j] == b'"' {
                    break;
                }
                j += 1;
            }
            out.push(inner[start..j].to_string());
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

/// Whitespace prefix of the line containing `[` (its indentation).
fn bracket_indent(text: &str, lbracket: usize) -> &str {
    let line_start = text[..lbracket].rfind('\n').map(|i| i + 1).unwrap_or(0);
    &text[line_start..lbracket]
}

fn detect_line_ending(text: &str) -> &'static str {
    if text.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{feff}').unwrap_or(text)
}

#[cfg(test)]
mod unit {
    use super::*;

    const SYNTH: &str = "<!-- kv3 encoding:text:version{x} format:generic:version{y} -->\n{\n\tEvt = \n\t{\n\t\tbase = \"Base\"\n\t\tvsnd_files = \n\t\t[\n\t\t\t\"a/stock.vsnd\",\n\t\t\t\"a/foreign1.vsnd\",\n\t\t\t\"a/old_owned.vsnd\",\n\t\t]\n\t\tvsnd_duration = 10.0\n\t}\n}\n";

    // Event with two arrays (like Music.Idol.Timer.Lp: team + opponent control).
    const SYNTH2: &str = "<!-- kv3 encoding:text:version{x} format:generic:version{y} -->\n{\n\tT = \n\t{\n\t\tvsnd_files = \n\t\t[\n\t\t\t\"team/stock.vsnd\",\n\t\t]\n\t\tvsnd_files_opponent_control = \n\t\t[\n\t\t\t\"opp/stock.vsnd\",\n\t\t]\n\t\tvsnd_duration = 12.0\n\t}\n}\n";

    fn edit(owned: &[&str], prev: &[&str], dur: Option<f64>) -> EventMerge {
        EventMerge {
            event_name: "Evt".into(),
            array_key: "vsnd_files".into(),
            stock_entry: "a/stock.vsnd".into(),
            owned_in_order: owned.iter().map(|s| s.to_string()).collect(),
            previous_owned: prev.iter().map(|s| s.to_string()).collect(),
            new_duration: dur,
            excluded: vec![],
        }
    }

    #[test]
    fn reads_entries_and_duration() {
        let v = read_event(SYNTH, "Evt").unwrap();
        assert_eq!(
            v.entries,
            vec!["a/stock.vsnd", "a/foreign1.vsnd", "a/old_owned.vsnd"]
        );
        assert_eq!(v.vsnd_duration, Some(10.0));
    }

    #[test]
    fn foreign_preserved_and_owned_appended() {
        let out = apply_merge(SYNTH, &edit(&["a/new.vsnd"], &[], None)).unwrap();
        let v = read_event(&out, "Evt").unwrap();
        // foreign1 stays, old_owned (unknown to us) is also preserved as foreign,
        // stock stays first, our new entry is appended last.
        assert_eq!(
            v.entries,
            vec![
                "a/stock.vsnd",
                "a/foreign1.vsnd",
                "a/old_owned.vsnd",
                "a/new.vsnd"
            ]
        );
    }

    #[test]
    fn previously_owned_entry_is_removed() {
        // Declare old_owned as previously owned and don't re-add it -> removed.
        let out = apply_merge(SYNTH, &edit(&["a/new.vsnd"], &["a/old_owned.vsnd"], None)).unwrap();
        let v = read_event(&out, "Evt").unwrap();
        assert_eq!(
            v.entries,
            vec!["a/stock.vsnd", "a/foreign1.vsnd", "a/new.vsnd"]
        );
    }

    #[test]
    fn noop_merge_is_byte_identical() {
        // owned empty, previous empty: foreign = [foreign1, old_owned], rebuilt =
        // [stock, foreign1, old_owned] == original order/content -> identical text.
        let out = apply_merge(SYNTH, &edit(&[], &[], None)).unwrap();
        assert_eq!(out, SYNTH);
    }

    #[test]
    fn duration_overwrite() {
        let out = apply_merge(SYNTH, &edit(&[], &[], Some(27.0))).unwrap();
        assert!(out.contains("vsnd_duration = 27.0"));
        let out2 = apply_merge(SYNTH, &edit(&[], &[], Some(28.874989))).unwrap();
        assert!(out2.contains("vsnd_duration = 28.874989"));
    }

    #[test]
    fn excluding_stock_and_foreign_drops_them() {
        let mut e = edit(&["a/new.vsnd"], &[], None);
        e.excluded = vec!["a/stock.vsnd".into(), "a/foreign1.vsnd".into()];
        let out = apply_merge(SYNTH, &e).unwrap();
        let v = read_event(&out, "Evt").unwrap();
        // stock dropped, foreign1 dropped, old_owned (untracked foreign) kept,
        // our new entry appended.
        assert_eq!(v.entries, vec!["a/old_owned.vsnd", "a/new.vsnd"]);
    }

    #[test]
    fn targets_named_array_key_leaving_sibling_untouched() {
        let e = EventMerge {
            event_name: "T".into(),
            array_key: "vsnd_files_opponent_control".into(),
            stock_entry: "opp/stock.vsnd".into(),
            owned_in_order: vec!["opp/mine.vsnd".into()],
            previous_owned: vec![],
            new_duration: None,
            excluded: vec![],
        };
        let out = apply_merge(SYNTH2, &e).unwrap();
        let opp = read_event_array(&out, "T", "vsnd_files_opponent_control").unwrap();
        assert_eq!(opp.entries, vec!["opp/stock.vsnd", "opp/mine.vsnd"]);
        // The sibling team array is untouched.
        let team = read_event_array(&out, "T", "vsnd_files").unwrap();
        assert_eq!(team.entries, vec!["team/stock.vsnd"]);
    }

    #[test]
    fn missing_header_rejected() {
        assert_eq!(validate_header("{ }"), Err(Kv3Error::MissingHeader));
    }
}
