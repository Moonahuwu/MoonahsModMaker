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

/// One array found in a document (for combining other mods).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrayInfo {
    pub event_name: String,
    pub array_key: String,
    pub entries: Vec<String>,
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
    // A scalar `vsnd_files = "x.vsnd"` reads as a single-entry pool.
    let entries = match find_value(text, block, array_key, event_name)? {
        ValueSpan::Array(lb, rb) => parse_array_entries(text, lb, rb),
        ValueSpan::Scalar(_, _, v) => vec![v],
    };
    let vsnd_duration = duration_value_span(text, block)
        .and_then(|(s, e)| text[s..e].trim().parse::<f64>().ok());
    Ok(EventView {
        event_name: event_name.to_string(),
        array_key: array_key.to_string(),
        entries,
        vsnd_duration,
    })
}

/// Enumerate every event's `vsnd_files*` value in the document. Used to learn
/// what another mod added (for combining). Both the array form and the scalar
/// `vsnd_files = "x"` form are returned (the scalar as a single-entry list), so
/// importers union one-sound events consistently with multi-sound ones.
pub fn list_arrays(text: &str) -> Result<Vec<ArrayInfo>> {
    validate_header(text)?;
    let b = text.as_bytes();
    // The header comment contains `{` (e.g. `version{...}`), so start after it.
    let header_end = text.find("-->").map(|i| i + 3).unwrap_or(0);
    let obj_open = text[header_end..]
        .find('{')
        .map(|i| header_end + i)
        .ok_or(Kv3Error::Unterminated("document"))?;
    let obj_close =
        matching_close(text, obj_open, b'{', b'}').ok_or(Kv3Error::Unterminated("document"))?;

    let mut out = Vec::new();
    for (name, bo, bc) in top_level_entries(text, obj_open, obj_close) {
        let mut from = bo;
        while let Some(rel) = text[from..bc].find("vsnd_files") {
            let kpos = from + rel;
            let before_ok =
                kpos == 0 || matches!(b[kpos - 1], b' ' | b'\t' | b'\n' | b'\r' | b'{');
            // Read the full key name (vsnd_files[_suffix]).
            let mut j = kpos;
            while j < bc && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                j += 1;
            }
            let key = &text[kpos..j];
            // After the key: optional spaces, then '='.
            let mut k = j;
            while k < bc && matches!(b[k], b' ' | b'\t') {
                k += 1;
            }
            if before_ok && k < bc && b[k] == b'=' {
                // After '=': optional spaces, then the value must be '[' (array).
                let mut v = k + 1;
                while v < bc && matches!(b[v], b' ' | b'\t' | b'\n' | b'\r') {
                    v += 1;
                }
                if v < bc && b[v] == b'[' {
                    if let Some(rb) = matching_close(text, v, b'[', b']') {
                        out.push(ArrayInfo {
                            event_name: name.clone(),
                            array_key: key.to_string(),
                            entries: parse_array_entries(text, v, rb),
                        });
                        from = rb + 1;
                        continue;
                    }
                } else if v < bc && b[v] == b'"' {
                    // Scalar one-sound value — surface it as a single-entry list.
                    let start = v + 1;
                    let mut q = start;
                    while q < bc {
                        if b[q] == b'\\' {
                            q += 2;
                            continue;
                        }
                        if b[q] == b'"' {
                            break;
                        }
                        q += 1;
                    }
                    if q < bc {
                        out.push(ArrayInfo {
                            event_name: name.clone(),
                            array_key: key.to_string(),
                            entries: vec![text[start..q].to_string()],
                        });
                        from = q + 1;
                        continue;
                    }
                }
            }
            from = j;
        }
    }
    Ok(out)
}

/// Append `new_entries` (deduped, preserving order) to an existing named array,
/// leaving every other byte intact. No-op (returns input) if nothing is new.
/// Errors if the event/array doesn't exist (caller decides whether to skip).
pub fn add_entries(
    text: &str,
    event_name: &str,
    array_key: &str,
    new_entries: &[String],
) -> Result<String> {
    validate_header(text)?;
    let block = event_block(text, event_name)?;
    // Support both the array form and the scalar `vsnd_files = "x"` form. The
    // scalar is promoted to an array only if there's actually something new to
    // add, so a no-op union stays byte-identical (MERGE, NEVER REPLACE).
    let (existing, rstart, rend, indent) =
        match find_value(text, block, array_key, event_name)? {
            ValueSpan::Array(lb, rb) => {
                (parse_array_entries(text, lb, rb), lb, rb, line_indent(text, lb).to_string())
            }
            ValueSpan::Scalar(qs, qe, v) => (vec![v], qs, qe, line_indent(text, qs).to_string()),
        };

    let mut result = existing.clone();
    let mut seen: HashSet<String> = existing.iter().cloned().collect();
    let before = result.len();
    for e in new_entries {
        if seen.insert(e.clone()) {
            result.push(e.clone());
        }
    }
    if result.len() == before {
        return Ok(text.to_string()); // nothing new to add
    }
    let le = detect_line_ending(text);
    let new_array = render_array(&result, &indent, le);
    let mut out = text.to_string();
    out.replace_range(rstart..=rend, &new_array);
    Ok(out)
}

/// Apply a single event merge, returning the new file text. Every byte outside
/// the edited event's array (and optional duration value) is preserved exactly.
pub fn apply_merge(text: &str, edit: &EventMerge) -> Result<String> {
    validate_header(text)?;
    let block = event_block(text, &edit.event_name)?;

    // The value may be an array (splice in place) or a scalar string (promote to
    // an array). `(existing entries, replace start, replace end-exclusive)`.
    let (existing, rstart, rend, indent) =
        match find_value(text, block, &edit.array_key, &edit.event_name)? {
            ValueSpan::Array(lb, rb) => (
                parse_array_entries(text, lb, rb),
                lb,
                rb + 1,
                line_indent(text, lb).to_string(),
            ),
            // Scalar -> array: the lone value becomes the existing single entry,
            // and we replace just the `"..."` span with a full array. Indent comes
            // from the key's line (the `[` lands inline after `= `).
            ValueSpan::Scalar(qs, qe, v) => {
                (vec![v], qs, qe + 1, line_indent(text, qs).to_string())
            }
        };

    let rebuilt = rebuild_entries(&existing, edit);
    let le = detect_line_ending(text);
    let new_array = render_array(&rebuilt, &indent, le);

    // Collect non-overlapping replacements and apply highest-offset-first so
    // earlier byte indices stay valid.
    let mut edits: Vec<(usize, usize, String)> = vec![(rstart, rend, new_array)];
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
    // Stock first, unless the user disabled it. An empty stock entry means "no
    // designated stock" (e.g. dynamic ability slots) — existing entries are then
    // all preserved as foreign and ours are appended.
    if !edit.stock_entry.is_empty() && !excluded.contains(edit.stock_entry.as_str()) {
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

/// Enumerate depth-1 keys whose value is a `{ ... }` block, returning
/// `(name, brace_open, brace_close)` for each. Skips scalar/array values.
fn top_level_entries(text: &str, open: usize, close: usize) -> Vec<(String, usize, usize)> {
    let b = text.as_bytes();
    let mut i = open + 1;
    let mut out = Vec::new();
    while i < close {
        while i < close && matches!(b[i], b' ' | b'\t' | b'\n' | b'\r' | b',') {
            i += 1;
        }
        if i >= close {
            break;
        }
        let ks = i;
        while i < close && !matches!(b[i], b' ' | b'\t' | b'\n' | b'\r' | b'=') {
            i += 1;
        }
        let key = text[ks..i].to_string();
        while i < close && b[i] != b'=' {
            i += 1;
        }
        if i >= close {
            break;
        }
        i += 1; // past '='
        while i < close && matches!(b[i], b' ' | b'\t' | b'\n' | b'\r') {
            i += 1;
        }
        if i >= close {
            break;
        }
        match b[i] {
            b'{' => match matching_close(text, i, b'{', b'}') {
                Some(bc) => {
                    out.push((key, i, bc));
                    i = bc + 1;
                }
                None => break,
            },
            b'[' => {
                i = matching_close(text, i, b'[', b']').map(|x| x + 1).unwrap_or(close);
            }
            b'"' => {
                let mut j = i + 1;
                while j < close {
                    if b[j] == b'\\' {
                        j += 2;
                        continue;
                    }
                    if b[j] == b'"' {
                        break;
                    }
                    j += 1;
                }
                i = j + 1;
            }
            _ => {
                while i < close && !matches!(b[i], b'\n' | b'\r') {
                    i += 1;
                }
            }
        }
    }
    out
}

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

/// The value of a `vsnd_files`-style key: either an array, or a single scalar
/// string (the game uses the scalar form for one-sound events, e.g. an ability's
/// `vsnd_files = "sounds/.../x.vsnd"`). We can merge into both: a scalar is
/// promoted to an array so our entries can be added.
enum ValueSpan {
    /// Inclusive offsets of the opening `[` and closing `]`.
    Array(usize, usize),
    /// A quoted scalar value: (opening-quote offset, closing-quote offset,
    /// unquoted contents).
    Scalar(usize, usize, String),
}

/// Locate the value of `array_key` within an event block — an array `[...]` or a
/// scalar `"..."`.
fn find_value(
    text: &str,
    block: (usize, usize),
    array_key: &str,
    event_name: &str,
) -> Result<ValueSpan> {
    let (bopen, bclose) = block;
    let b = text.as_bytes();
    let key = find_key_pos(text, bopen, bclose, array_key)
        .ok_or_else(|| Kv3Error::ArrayNotFound(format!("{event_name}.{array_key}")))?;
    // Skip past the key, optional spaces, '=', and whitespace to the value start.
    let mut j = key + array_key.len();
    while j < bclose && matches!(b[j], b' ' | b'\t') {
        j += 1;
    }
    if j >= bclose || b[j] != b'=' {
        return Err(Kv3Error::ArrayNotFound(format!("{event_name}.{array_key}")));
    }
    j += 1;
    while j < bclose && matches!(b[j], b' ' | b'\t' | b'\n' | b'\r') {
        j += 1;
    }
    if j >= bclose {
        return Err(Kv3Error::ArrayNotFound(format!("{event_name}.{array_key}")));
    }
    match b[j] {
        b'[' => {
            let rb = matching_close(text, j, b'[', b']').ok_or(Kv3Error::Unterminated("array"))?;
            Ok(ValueSpan::Array(j, rb))
        }
        b'"' => {
            let start = j + 1;
            let mut k = start;
            while k < text.len() {
                if b[k] == b'\\' {
                    k += 2;
                    continue;
                }
                if b[k] == b'"' {
                    break;
                }
                k += 1;
            }
            if k >= text.len() {
                return Err(Kv3Error::Unterminated("string"));
            }
            Ok(ValueSpan::Scalar(j, k, text[start..k].to_string()))
        }
        _ => Err(Kv3Error::ArrayNotFound(format!("{event_name}.{array_key}"))),
    }
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

/// Leading whitespace (indentation) of the line containing `pos`. Stops at the
/// first non-whitespace char, so it's correct even when `pos` points mid-line
/// (e.g. an inline `key = [...]` array or a scalar value after `key = `).
fn line_indent(text: &str, pos: usize) -> &str {
    let line_start = text[..pos].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let b = text.as_bytes();
    let mut e = line_start;
    while e < pos && matches!(b[e], b' ' | b'\t') {
        e += 1;
    }
    &text[line_start..e]
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
    fn list_arrays_enumerates_both_arrays() {
        let arrays = list_arrays(SYNTH2).unwrap();
        assert_eq!(arrays.len(), 2);
        assert_eq!(arrays[0].event_name, "T");
        assert_eq!(arrays[0].array_key, "vsnd_files");
        assert_eq!(arrays[0].entries, vec!["team/stock.vsnd"]);
        assert_eq!(arrays[1].array_key, "vsnd_files_opponent_control");
        assert_eq!(arrays[1].entries, vec!["opp/stock.vsnd"]);
    }

    #[test]
    fn add_entries_unions_and_dedupes() {
        let out = add_entries(
            SYNTH,
            "Evt",
            "vsnd_files",
            &["a/new.vsnd".into(), "a/foreign1.vsnd".into()],
        )
        .unwrap();
        let v = read_event(&out, "Evt").unwrap();
        // foreign1 already present (deduped); new appended at the end.
        assert_eq!(
            v.entries,
            vec!["a/stock.vsnd", "a/foreign1.vsnd", "a/old_owned.vsnd", "a/new.vsnd"]
        );
    }

    // Like an ability event in the live game: `vsnd_files` is a SCALAR string,
    // not an array (e.g. Punkgoat.Blasted.Lp).
    const SYNTH_SCALAR: &str = "<!-- kv3 encoding:text:version{x} format:generic:version{y} -->\n{\n\tEvt = \n\t{\n\t\tbase = \"Base.Ability\"\n\t\tvsnd_files = \"a/stock.vsnd\"\n\t\tvsnd_duration = 15.0\n\t}\n}\n";

    #[test]
    fn reads_scalar_vsnd_files_as_single_entry() {
        let v = read_event(SYNTH_SCALAR, "Evt").unwrap();
        assert_eq!(v.entries, vec!["a/stock.vsnd"]);
        assert_eq!(v.vsnd_duration, Some(15.0));
    }

    #[test]
    fn scalar_vsnd_files_is_promoted_to_array_on_merge() {
        let out = apply_merge(SYNTH_SCALAR, &edit(&["a/new.vsnd"], &[], Some(20.0))).unwrap();
        // The scalar became an array with stock first + our entry appended.
        let v = read_event(&out, "Evt").unwrap();
        assert_eq!(v.entries, vec!["a/stock.vsnd", "a/new.vsnd"]);
        assert_eq!(v.vsnd_duration, Some(20.0));
        // It's a real array now, and the surrounding keys are intact.
        assert!(out.contains("vsnd_files = ["));
        assert!(out.contains("base = \"Base.Ability\""));
        // Re-merging the now-array form stays stable (idempotent shape).
        let again = apply_merge(&out, &edit(&["a/new.vsnd"], &[], None)).unwrap();
        let v2 = read_event(&again, "Evt").unwrap();
        assert_eq!(v2.entries, vec!["a/stock.vsnd", "a/new.vsnd"]);
    }

    #[test]
    fn list_arrays_includes_scalar_vsnd_files() {
        // A scalar one-sound event (like UI.Matchmake.Made) is surfaced as a
        // single-entry list so importers union it like any array.
        let arrays = list_arrays(SYNTH_SCALAR).unwrap();
        assert_eq!(arrays.len(), 1);
        assert_eq!(arrays[0].event_name, "Evt");
        assert_eq!(arrays[0].array_key, "vsnd_files");
        assert_eq!(arrays[0].entries, vec!["a/stock.vsnd"]);
    }

    #[test]
    fn add_entries_promotes_scalar_and_is_noop_when_nothing_new() {
        // Unioning a new sound into a scalar event promotes it to an array.
        let out = add_entries(SYNTH_SCALAR, "Evt", "vsnd_files", &["a/other.vsnd".into()]).unwrap();
        let v = read_event(&out, "Evt").unwrap();
        assert_eq!(v.entries, vec!["a/stock.vsnd", "a/other.vsnd"]);
        assert!(out.contains("vsnd_files = ["));
        assert!(out.contains("base = \"Base.Ability\""));
        // Unioning only the already-present entry changes nothing (stays scalar,
        // byte-identical).
        let noop = add_entries(SYNTH_SCALAR, "Evt", "vsnd_files", &["a/stock.vsnd".into()]).unwrap();
        assert_eq!(noop, SYNTH_SCALAR);
    }

    // Hand-authored mod files sometimes write the array inline on the key's
    // line. The rewritten array's indent must come from the line's leading
    // whitespace, not the text before `[` (which would inject `vsnd_files = `
    // into every entry line).
    const SYNTH_INLINE: &str = "<!-- kv3 encoding:text:version{x} format:generic:version{y} -->\n{\n\tEvt = \n\t{\n\t\tvsnd_files = [ \"a/stock.vsnd\", \"a/foreign1.vsnd\" ]\n\t\tvsnd_duration = 10.0\n\t}\n}\n";

    #[test]
    fn add_entries_handles_inline_array() {
        let out = add_entries(SYNTH_INLINE, "Evt", "vsnd_files", &["a/new.vsnd".into()]).unwrap();
        let v = read_event(&out, "Evt").unwrap();
        assert_eq!(v.entries, vec!["a/stock.vsnd", "a/foreign1.vsnd", "a/new.vsnd"]);
        // No entry line may repeat the key text (the old bracket_indent bug).
        assert_eq!(out.matches("vsnd_files").count(), 1);
        assert!(out.contains("vsnd_duration = 10.0"));
    }

    #[test]
    fn apply_merge_handles_inline_array() {
        let out = apply_merge(SYNTH_INLINE, &edit(&["a/new.vsnd"], &[], None)).unwrap();
        let v = read_event(&out, "Evt").unwrap();
        assert_eq!(
            v.entries,
            vec!["a/stock.vsnd", "a/foreign1.vsnd", "a/new.vsnd"]
        );
        assert_eq!(out.matches("vsnd_files").count(), 1);
    }

    #[test]
    fn missing_header_rejected() {
        assert_eq!(validate_header("{ }"), Err(Kv3Error::MissingHeader));
    }
}
