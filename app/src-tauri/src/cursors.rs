//! Custom mouse cursors.
//!
//! Since the 2026-09-29 patch Deadlock draws its own cursors from four loose
//! BMP files in `game/citadel/resource/cursors/` (the pointer, the ping
//! pointer, the shop hand, the post-game commend) plus `cursor.res`, which
//! carries the hot spots. How the engine reads them (mined from the binaries
//! 2026-10-05): the client asks the input system for
//! `resource/cursors/<name>.bmp`, and the platform layer opens that with
//! `SDL_IOFromFile` + `SDL_LoadBMP_IO` - a real file ON DISK, never the vpk
//! filesystem. So a cursor cannot ride in a mod pak: the files have to be
//! written into the game folder (the community's cursor mods are exactly that,
//! a zip of BMPs to drop in by hand).
//!
//! This module automates it: any image becomes the game's exact BMP layout
//! (40-byte header, 32-bit BGRA, bottom-up, straight alpha), written in place
//! with the file it replaces kept beside it as `<name>.eim.bak`, plus a small
//! manifest of what we wrote - so a later game update or Steam file verify
//! (both reset the cursors) can be told apart from our own files, and
//! "restore" never copies a stale backup over a newer game file.
//!
//! Hot spots: `cursor.res` blocks are keyed by the BMP's file stem (the stock
//! file's `cursor_commend` block is the proof; its `cursor_default` /
//! `cursor_hand_open` blocks are leftovers with no file). A cursor with no
//! block clicks at its top-left pixel. The engine scales image and hot spot
//! together by `citadel_mouse_cursor_scale`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// One cursor the game loads: our slot id, the file, the stock image size and
/// the stock hot spot in pixels.
pub(crate) struct Slot {
    pub id: &'static str,
    pub file: &'static str,
    pub stock: (u32, u32),
    pub stock_hot: (u32, u32),
}

pub(crate) const SLOTS: [Slot; 4] = [
    Slot { id: "default", file: "cursor.bmp", stock: (48, 58), stock_hot: (0, 0) },
    Slot { id: "ping", file: "cursor_ping.bmp", stock: (48, 58), stock_hot: (0, 0) },
    Slot { id: "shop", file: "cursor_shop.bmp", stock: (60, 60), stock_hot: (0, 0) },
    Slot { id: "commend", file: "cursor_commend.bmp", stock: (88, 88), stock_hot: (22, 2) },
];

const RES_FILE: &str = "cursor.res";
const MANIFEST: &str = ".eim_cursors.json";
const BAK_EXT: &str = ".eim.bak";
/// Cursor images are clamped to this box: smaller is unusable, and the OS
/// refuses colour cursors much past 256 pixels.
const MIN_PX: u32 = 8;
const MAX_PX: u32 = 256;

/// The game's own `cursor.res` (2026-09-29), for when the folder has none to
/// start from and for exported packs.
const DEFAULT_RES: &str = "// This file is only needed when using SDL, since it opens the cursors\n// as BMP files instead of loading .ani files.\n\"resource/cursor/cursor.res\"\n{\n\tcursor_default\n\t{\n\t\t\"hotx\"\t\t\"0\"\n\t\t\"hoty\"\t\t\"0\"\n\t}\n\t\n\tcursor_hand_open\n\t{\n\t\t\"hotx\"\t\t\"14\"\n\t\t\"hoty\"\t\t\"14\"\n\t}\n\n\t// Aim with the tip of the thumb.\n\tcursor_commend\n\t{\n\t\t\"hotx\"\t\t\"22\"\n\t\t\"hoty\"\t\t\"2\"\n\t}\n\n}\n";

const PACK_README: &str = "Custom Deadlock cursors\r\n\r\nInstall:\r\n1. Open your Deadlock folder: steamapps/common/Deadlock/game/citadel/resource/cursors\r\n2. Copy the files in there somewhere safe first if you want the originals back later.\r\n3. Drop the files from this zip into that folder and replace the existing ones.\r\n4. Start Deadlock.\r\n\r\nA game update or Steam's \"Verify integrity of game files\" puts the original cursors back. Copy these in again afterwards.\r\n\r\nMade with Moonah's Mod Maker - https://gamebanana.com/tools/23422\r\n";

pub(crate) fn slot_by_id(id: &str) -> Option<&'static Slot> {
    SLOTS.iter().find(|s| s.id == id)
}

/// A cursor's `cursor.res` key: the BMP's file stem.
fn res_key(slot: &Slot) -> &'static str {
    slot.file.trim_end_matches(".bmp")
}

// ---------------------------------------------------------------------------
// Pixels: BMP in / out, PNG out (previews). No image crate in this workspace,
// and cursors are tiny, so the three codecs live here.
// ---------------------------------------------------------------------------

/// A decoded image: BGRA, rows top-down, straight alpha.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Bgra {
    pub w: u32,
    pub h: u32,
    pub px: Vec<u8>,
}

fn le_u16(b: &[u8], at: usize) -> u32 {
    u32::from(u16::from_le_bytes([b[at], b[at + 1]]))
}

fn le_u32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn le_i32(b: &[u8], at: usize) -> i32 {
    i32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

/// Decode the BMP flavours cursors come in: 32-bit BI_RGB (the game's own
/// files, and what ffmpeg writes), 32-bit BI_BITFIELDS with any byte-aligned
/// masks (what image editors export - the community packs are V5 headers),
/// and opaque 24-bit. A 32-bit BI_RGB file whose alpha bytes are ALL zero is
/// opaque, the same reading SDL gives it.
pub(crate) fn decode_bmp(b: &[u8]) -> Result<Bgra, String> {
    if b.len() < 54 || &b[..2] != b"BM" {
        return Err("not a BMP file".into());
    }
    let data_off = le_u32(b, 10) as usize;
    let hdr = le_u32(b, 14) as usize;
    let w = le_i32(b, 18);
    let h_signed = le_i32(b, 22);
    let bpp = le_u16(b, 28);
    let comp = le_u32(b, 30);
    if hdr < 40 || w <= 0 || h_signed == 0 {
        return Err("unsupported BMP header".into());
    }
    let (w, h) = (w as u32, h_signed.unsigned_abs());
    if w > 4096 || h > 4096 {
        return Err(format!("image is too large for a cursor ({w}x{h})"));
    }
    let bottom_up = h_signed > 0;
    let mut masks = match (bpp, comp) {
        (32, 0) | (24, 0) => [0x00ff_0000u32, 0x0000_ff00, 0x0000_00ff, 0xff00_0000],
        (32, 3) | (32, 6) => {
            // V4/V5 headers carry the masks inside; a plain 40-byte header is
            // followed by them.
            let at = 54;
            if b.len() < at + 12 {
                return Err("truncated BMP masks".into());
            }
            let alpha = if (hdr >= 56 || comp == 6) && b.len() >= at + 16 { le_u32(b, at + 12) } else { 0 };
            [le_u32(b, at), le_u32(b, at + 4), le_u32(b, at + 8), alpha]
        }
        _ => return Err(format!("unsupported BMP format ({bpp}-bit, compression {comp})")),
    };
    for m in masks.iter().take(3) {
        if *m == 0 || (m >> m.trailing_zeros()) != 0xff {
            return Err("unsupported BMP colour masks".into());
        }
    }
    if masks[3] != 0 && (masks[3] >> masks[3].trailing_zeros()) != 0xff {
        masks[3] = 0;
    }
    let bytes_pp = (bpp / 8) as usize;
    let stride = ((w as usize * bytes_pp) + 3) & !3;
    let need = data_off + stride * h as usize;
    if data_off < 54 || b.len() < need {
        return Err("truncated BMP pixel data".into());
    }
    let shifts = [
        masks[0].trailing_zeros(),
        masks[1].trailing_zeros(),
        masks[2].trailing_zeros(),
        masks[3].trailing_zeros(),
    ];
    let mut px = vec![0u8; w as usize * h as usize * 4];
    let mut any_alpha = false;
    for y in 0..h as usize {
        let src_row = if bottom_up { h as usize - 1 - y } else { y };
        let row = &b[data_off + src_row * stride..];
        for x in 0..w as usize {
            let o = (y * w as usize + x) * 4;
            if bytes_pp == 3 {
                px[o] = row[x * 3];
                px[o + 1] = row[x * 3 + 1];
                px[o + 2] = row[x * 3 + 2];
                px[o + 3] = 255;
            } else {
                let v = le_u32(row, x * 4);
                px[o] = ((v & masks[2]) >> shifts[2]) as u8;
                px[o + 1] = ((v & masks[1]) >> shifts[1]) as u8;
                px[o + 2] = ((v & masks[0]) >> shifts[0]) as u8;
                let a = if masks[3] != 0 { ((v & masks[3]) >> shifts[3]) as u8 } else { 255 };
                any_alpha |= a != 0;
                px[o + 3] = a;
            }
        }
    }
    // No usable alpha at all: the file is opaque (BI_RGB with zeroed alpha
    // bytes; an all-zero BI_BITFIELDS alpha would otherwise be an invisible
    // cursor).
    if bytes_pp == 4 && !any_alpha {
        for a in px.iter_mut().skip(3).step_by(4) {
            *a = 255;
        }
    }
    Ok(Bgra { w, h, px })
}

/// Encode in the game's own layout: 14 + 40 byte headers, 32-bit BI_RGB,
/// rows bottom-up, 72 dpi - byte-for-byte what the stock cursors use.
pub(crate) fn encode_bmp(img: &Bgra) -> Vec<u8> {
    let data = img.w as usize * img.h as usize * 4;
    let mut out = Vec::with_capacity(54 + data);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&((54 + data) as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&54u32.to_le_bytes());
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(img.w as i32).to_le_bytes());
    out.extend_from_slice(&(img.h as i32).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&(data as u32).to_le_bytes());
    out.extend_from_slice(&2834i32.to_le_bytes());
    out.extend_from_slice(&2834i32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    let row = img.w as usize * 4;
    for y in (0..img.h as usize).rev() {
        out.extend_from_slice(&img.px[y * row..(y + 1) * row]);
    }
    out
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &b in bytes {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn adler32(bytes: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &x in bytes {
        a = (a + u32::from(x)) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

/// A valid RGBA PNG with stored (uncompressed) deflate blocks - plenty for
/// cursor-sized previews, and it needs no compression library.
pub(crate) fn encode_png(img: &Bgra) -> Vec<u8> {
    let row = img.w as usize * 4;
    let mut raw = Vec::with_capacity((row + 1) * img.h as usize);
    for y in 0..img.h as usize {
        raw.push(0);
        for p in img.px[y * row..(y + 1) * row].chunks_exact(4) {
            raw.extend_from_slice(&[p[2], p[1], p[0], p[3]]);
        }
    }
    let mut z = vec![0x78, 0x01];
    let mut blocks = raw.chunks(65535).peekable();
    if blocks.peek().is_none() {
        z.extend_from_slice(&[1, 0, 0, 0xff, 0xff]);
    }
    while let Some(block) = blocks.next() {
        z.push(u8::from(blocks.peek().is_none()));
        z.extend_from_slice(&(block.len() as u16).to_le_bytes());
        z.extend_from_slice(&(!(block.len() as u16)).to_le_bytes());
        z.extend_from_slice(block);
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut chunk = |kind: &[u8; 4], body: &[u8]| {
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        let mut tagged = kind.to_vec();
        tagged.extend_from_slice(body);
        out.extend_from_slice(&tagged);
        out.extend_from_slice(&crc32(&tagged).to_be_bytes());
    };
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&img.w.to_be_bytes());
    ihdr.extend_from_slice(&img.h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(b"IHDR", &ihdr);
    chunk(b"IDAT", &z);
    chunk(b"IEND", &[]);
    out
}

fn hash_bytes(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

// ---------------------------------------------------------------------------
// cursor.res hot spots
// ---------------------------------------------------------------------------

fn unquote(token: &str) -> &str {
    token.trim().trim_matches('"')
}

/// The line range `[start, end]` of `key`'s block (its name line through its
/// closing brace), when the file has one.
fn res_block(lines: &[&str], key: &str) -> Option<(usize, usize)> {
    let mut i = 0;
    while i < lines.len() {
        let t = lines[i].trim();
        if !t.starts_with("//") && unquote(t) == key {
            let open = (i + 1..lines.len()).find(|&j| !lines[j].trim().is_empty())?;
            if lines[open].trim() != "{" {
                i += 1;
                continue;
            }
            let close = (open + 1..lines.len()).find(|&j| lines[j].trim() == "}")?;
            return Some((i, close));
        }
        i += 1;
    }
    None
}

/// The hot spot `cursor.res` gives `key`, if it has a block for it.
pub(crate) fn get_hotspot(text: &str, key: &str) -> Option<(u32, u32)> {
    let lines: Vec<&str> = text.lines().collect();
    let (start, end) = res_block(&lines, key)?;
    let (mut x, mut y) = (None, None);
    for l in &lines[start + 1..end] {
        let mut it = l.split_whitespace();
        let (Some(k), Some(v)) = (it.next(), it.next()) else { continue };
        match unquote(k) {
            "hotx" => x = unquote(v).parse().ok(),
            "hoty" => y = unquote(v).parse().ok(),
            _ => {}
        }
    }
    Some((x?, y?))
}

/// Give `key` this hot spot: its block's values are rewritten in place, or a
/// new block is added just inside the file's closing brace. Every other line
/// is left alone.
pub(crate) fn set_hotspot(text: &str, key: &str, x: u32, y: u32) -> String {
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let values = [format!("\t\t\"hotx\"\t\t\"{x}\""), format!("\t\t\"hoty\"\t\t\"{y}\"")];
    let found = {
        let view: Vec<&str> = lines.iter().map(String::as_str).collect();
        res_block(&view, key).and_then(|(start, end)| {
            (start + 1..end).find(|&j| view[j].trim() == "{").map(|open| (open, end))
        })
    };
    match found {
        Some((open, end)) => {
            lines.splice(open + 1..end, values);
        }
        None => {
            let at = lines.iter().rposition(|l| l.trim() == "}").unwrap_or(lines.len());
            let [hx, hy] = values;
            let block =
                [format!("\t{key}"), "\t{".to_string(), hx, hy, "\t}".to_string(), String::new()];
            for (i, l) in block.into_iter().enumerate() {
                lines.insert(at + i, l);
            }
        }
    }
    let mut out = lines.join(nl);
    out.push_str(nl);
    out
}

// ---------------------------------------------------------------------------
// The game folder: managed writes, backups, restore
// ---------------------------------------------------------------------------

/// `game/citadel/resource/cursors`, from the game pak path the app already
/// knows (or the citadel folder itself).
pub fn cursors_dir(pak_path: &str) -> Result<PathBuf, String> {
    let p = Path::new(pak_path.trim());
    let citadel = if p.is_dir() {
        p.to_path_buf()
    } else {
        p.parent().map(Path::to_path_buf).unwrap_or_default()
    };
    if pak_path.trim().is_empty() || !citadel.join("gameinfo.gi").is_file() {
        return Err(
            "Deadlock's game folder is not set - pick the game pak in Settings first".to_string()
        );
    }
    Ok(citadel.join("resource").join("cursors"))
}

fn require_dir(pak_path: &str) -> Result<PathBuf, String> {
    let dir = cursors_dir(pak_path)?;
    if !dir.is_dir() {
        return Err(
            "This Deadlock install has no resource/cursors folder - custom cursors need the 2026-09-29 game update or newer"
                .to_string(),
        );
    }
    Ok(dir)
}

/// What we wrote into the folder: file name -> hash of our bytes.
#[derive(Serialize, Deserialize, Default)]
struct Manifest {
    #[serde(default)]
    files: BTreeMap<String, String>,
}

fn load_manifest(dir: &Path) -> Manifest {
    std::fs::read_to_string(dir.join(MANIFEST))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_manifest(dir: &Path, m: &Manifest) -> Result<(), String> {
    let path = dir.join(MANIFEST);
    if m.files.is_empty() {
        let _ = std::fs::remove_file(path);
        return Ok(());
    }
    let text = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))
}

fn bak_path(dir: &Path, file: &str) -> PathBuf {
    dir.join(format!("{file}{BAK_EXT}"))
}

/// The file on disk is exactly what we last wrote.
fn is_ours(dir: &Path, m: &Manifest, file: &str) -> bool {
    match (m.files.get(file), std::fs::read(dir.join(file))) {
        (Some(want), Ok(bytes)) => *want == hash_bytes(&bytes),
        _ => false,
    }
}

/// Write one of our files. Whatever is there and is NOT ours (the game's
/// file, a fresh one after an update, another mod's) becomes the backup
/// first; our own previous write is simply replaced.
fn write_managed(dir: &Path, m: &mut Manifest, file: &str, bytes: &[u8]) -> Result<(), String> {
    let dest = dir.join(file);
    if dest.is_file() && !is_ours(dir, m, file) {
        std::fs::copy(&dest, bak_path(dir, file))
            .map_err(|e| format!("backing up {file}: {e}"))?;
    }
    std::fs::write(&dest, bytes).map_err(|e| {
        format!("writing {}: {e} (close Deadlock if it is running, then try again)", dest.display())
    })?;
    m.files.insert(file.to_string(), hash_bytes(bytes));
    Ok(())
}

/// Outcome of putting one file back.
#[derive(PartialEq, Debug)]
enum Restored {
    /// The backup went back in.
    Yes,
    /// The file on disk is ours but there is no backup to put back.
    NoBackup,
    /// Nothing of ours there (already the game's, or replaced since).
    NotOurs,
}

/// Put back what a file replaced. A backup only goes back over OUR file: if
/// the game (an update, a file verify) or the user has replaced it since, the
/// backup is stale and is dropped instead.
fn restore_one(dir: &Path, m: &mut Manifest, file: &str) -> Result<Restored, String> {
    let bak = bak_path(dir, file);
    let ours = is_ours(dir, m, file) || (m.files.contains_key(file) && !dir.join(file).exists());
    if !ours {
        let _ = std::fs::remove_file(&bak);
        m.files.remove(file);
        return Ok(Restored::NotOurs);
    }
    if !bak.is_file() {
        return Ok(Restored::NoBackup);
    }
    std::fs::copy(&bak, dir.join(file)).map_err(|e| format!("restoring {file}: {e}"))?;
    let _ = std::fs::remove_file(&bak);
    m.files.remove(file);
    Ok(Restored::Yes)
}

// ---------------------------------------------------------------------------
// Rendering a source image into a cursor
// ---------------------------------------------------------------------------

/// One cursor the user set (mirrors the TS type, camelCase).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorEntry {
    pub slot: String,
    pub source_image: String,
    /// Image height in pixels; 0 keeps the image's own size.
    #[serde(default)]
    pub height: u32,
    /// The click point, as a fraction of the image (0 = left / top).
    #[serde(default)]
    pub hot_x: f64,
    #[serde(default)]
    pub hot_y: f64,
    #[serde(default = "enabled_default")]
    pub enabled: bool,
}

fn enabled_default() -> bool {
    true
}

fn run_ffmpeg(ffmpeg: &str, args: &[&str]) -> Result<(), String> {
    let out = crate::procutil::quiet(ffmpeg)
        .args(args)
        .output()
        .map_err(|e| format!("could not run ffmpeg ({e}) - set its path in Settings"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let tail: Vec<&str> = err.lines().rev().filter(|l| !l.trim().is_empty()).take(2).collect();
    Err(format!(
        "ffmpeg could not read the image: {}",
        tail.into_iter().rev().collect::<Vec<_>>().join(" / ")
    ))
}

/// The size a cursor is written at: the wanted height (or the image's own
/// size), aspect kept, inside the allowed box.
pub(crate) fn target_size(w: u32, h: u32, height: u32) -> (u32, u32) {
    let (w, h) = (f64::from(w.max(1)), f64::from(h.max(1)));
    let mut th = if height == 0 { h } else { f64::from(height.clamp(MIN_PX, MAX_PX)) };
    let mut tw = w * th / h;
    let over = (tw / f64::from(MAX_PX)).max(th / f64::from(MAX_PX));
    if over > 1.0 {
        tw /= over;
        th /= over;
    }
    ((tw.round() as u32).clamp(1, MAX_PX), (th.round() as u32).clamp(1, MAX_PX))
}

/// Source image -> cursor pixels at the entry's size. BMP sources decode
/// here (exact pixels, and ffmpeg is not needed at all when no resize is
/// asked); everything else goes through ffmpeg (first frame of animations).
fn render(ffmpeg: &str, e: &CursorEntry, work: &Path) -> Result<Bgra, String> {
    let src = Path::new(&e.source_image);
    if !src.is_file() {
        return Err(format!("image not found: {}", e.source_image));
    }
    std::fs::create_dir_all(work).map_err(|e| e.to_string())?;
    let is_bmp = src.extension().is_some_and(|x| x.eq_ignore_ascii_case("bmp"));
    let native = if is_bmp {
        decode_bmp(&std::fs::read(src).map_err(|e| e.to_string())?)?
    } else {
        let tmp = work.join(format!("{}_native.bmp", e.slot));
        run_ffmpeg(
            ffmpeg,
            &[
                "-y",
                "-i",
                &e.source_image,
                "-frames:v",
                "1",
                "-vf",
                "format=bgra",
                "-pix_fmt",
                "bgra",
                &tmp.to_string_lossy(),
            ],
        )?;
        let img = decode_bmp(&std::fs::read(&tmp).map_err(|e| e.to_string())?)?;
        let _ = std::fs::remove_file(&tmp);
        img
    };
    let (tw, th) = target_size(native.w, native.h, e.height);
    if (tw, th) == (native.w, native.h) {
        return Ok(native);
    }
    // Resize through ffmpeg from a PNG we wrote ourselves, so the alpha it
    // reads is never in doubt (a BMP's alpha is a matter of interpretation).
    let png = work.join(format!("{}_src.png", e.slot));
    let out = work.join(format!("{}_sized.bmp", e.slot));
    std::fs::write(&png, encode_png(&native)).map_err(|e| e.to_string())?;
    run_ffmpeg(
        ffmpeg,
        &[
            "-y",
            "-i",
            &png.to_string_lossy(),
            "-frames:v",
            "1",
            "-vf",
            &format!("scale={tw}:{th}:flags=lanczos,format=bgra"),
            "-pix_fmt",
            "bgra",
            &out.to_string_lossy(),
        ],
    )?;
    let img = decode_bmp(&std::fs::read(&out).map_err(|e| e.to_string())?)?;
    let _ = std::fs::remove_file(&png);
    let _ = std::fs::remove_file(&out);
    Ok(img)
}

fn hot_px(e: &CursorEntry, img: &Bgra) -> (u32, u32) {
    let at = |f: f64, n: u32| {
        let f = if f.is_finite() { f.clamp(0.0, 1.0) } else { 0.0 };
        (f * f64::from(n.saturating_sub(1))).round() as u32
    };
    (at(e.hot_x, img.w), at(e.hot_y, img.h))
}

/// Every enabled entry rendered (first entry per slot wins). Done up front,
/// so one unreadable image stops the run before anything is written.
fn render_all(
    ffmpeg: &str,
    entries: &[CursorEntry],
    work: &Path,
) -> Result<Vec<(&'static Slot, Bgra, (u32, u32))>, String> {
    let mut out: Vec<(&'static Slot, Bgra, (u32, u32))> = Vec::new();
    for e in entries {
        if !e.enabled || e.source_image.trim().is_empty() {
            continue;
        }
        let Some(slot) = slot_by_id(&e.slot) else {
            return Err(format!("unknown cursor \"{}\" - update the app", e.slot));
        };
        if out.iter().any(|(s, _, _)| s.id == slot.id) {
            continue;
        }
        let img = render(ffmpeg, e, work).map_err(|err| format!("{}: {err}", slot.file))?;
        let hot = hot_px(e, &img);
        out.push((slot, img, hot));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Commands' cores
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    /// Cursors written into the game folder.
    pub applied: Vec<String>,
    /// Cursors put back because they are no longer set.
    pub restored: Vec<String>,
    pub dir: String,
}

/// Make the game folder match `entries`: set cursors are written (the files
/// they replace backed up), cursors that are no longer set go back to what
/// they replaced, and `cursor.res` carries the hot spots.
pub fn apply(
    pak_path: &str,
    ffmpeg: &str,
    entries: &[CursorEntry],
    work: &Path,
) -> Result<ApplyReport, String> {
    let dir = require_dir(pak_path)?;
    let rendered = render_all(ffmpeg, entries, work)?;
    let mut m = load_manifest(&dir);
    let mut report = ApplyReport {
        applied: Vec::new(),
        restored: Vec::new(),
        dir: dir.to_string_lossy().into_owned(),
    };
    // The hot-spot file starts from the GAME's text every time (the backup
    // when the current file is ours), so a cursor that is no longer set never
    // keeps an old hot spot of ours.
    let res_base = if is_ours(&dir, &m, RES_FILE) {
        std::fs::read_to_string(bak_path(&dir, RES_FILE)).unwrap_or_else(|_| DEFAULT_RES.to_string())
    } else {
        std::fs::read_to_string(dir.join(RES_FILE)).unwrap_or_else(|_| DEFAULT_RES.to_string())
    };
    for slot in &SLOTS {
        match rendered.iter().find(|(s, _, _)| s.id == slot.id) {
            Some((_, img, _)) => {
                write_managed(&dir, &mut m, slot.file, &encode_bmp(img))?;
                report.applied.push(slot.id.to_string());
            }
            None => {
                if restore_one(&dir, &mut m, slot.file)? == Restored::Yes {
                    report.restored.push(slot.id.to_string());
                }
            }
        }
    }
    if rendered.is_empty() {
        restore_one(&dir, &mut m, RES_FILE)?;
    } else {
        let mut text = res_base;
        for (slot, _, (x, y)) in &rendered {
            text = set_hotspot(&text, res_key(slot), *x, *y);
        }
        write_managed(&dir, &mut m, RES_FILE, text.as_bytes())?;
    }
    save_manifest(&dir, &m)?;
    Ok(report)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    /// Files put back from their backups.
    pub restored: usize,
    /// Files of ours that had no backup to put back.
    pub no_backup: Vec<String>,
}

/// Put back everything we replaced.
pub fn restore(pak_path: &str) -> Result<RestoreReport, String> {
    let dir = require_dir(pak_path)?;
    let mut m = load_manifest(&dir);
    let mut report = RestoreReport { restored: 0, no_backup: Vec::new() };
    let files: Vec<&str> = SLOTS.iter().map(|s| s.file).chain([RES_FILE]).collect();
    for file in files {
        match restore_one(&dir, &mut m, file)? {
            Restored::Yes => report.restored += 1,
            Restored::NoBackup => report.no_backup.push(file.to_string()),
            Restored::NotOurs => {}
        }
    }
    save_manifest(&dir, &m)?;
    Ok(report)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorSlotStatus {
    pub slot: String,
    pub file: String,
    pub exists: bool,
    pub width: u32,
    pub height: u32,
    /// The hot spot the game will use, in pixels.
    pub hot_x: u32,
    pub hot_y: u32,
    /// "yours" (what this app wrote), "changed" (this app wrote it, something
    /// replaced it since - a game update or file verify), "game" (never
    /// ours), or "missing".
    pub state: String,
    pub has_backup: bool,
    /// A PNG of the file as it is on disk, for display ("" when unreadable).
    pub preview: String,
    pub stock_width: u32,
    pub stock_height: u32,
    /// The game's own hot spot for this cursor at its stock size - the
    /// starting point offered for a new image.
    pub stock_hot_x: u32,
    pub stock_hot_y: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorStatus {
    pub dir: String,
    pub dir_exists: bool,
    pub slots: Vec<CursorSlotStatus>,
}

/// What is in the game folder right now. Previews land in `preview_dir`,
/// named by content so a changed cursor gets a fresh file (the webview caches
/// by path).
pub fn status(pak_path: &str, preview_dir: &Path) -> Result<CursorStatus, String> {
    let dir = cursors_dir(pak_path)?;
    let dir_exists = dir.is_dir();
    let m = load_manifest(&dir);
    let res = std::fs::read_to_string(dir.join(RES_FILE)).unwrap_or_default();
    let _ = std::fs::create_dir_all(preview_dir);
    let mut slots = Vec::new();
    for slot in &SLOTS {
        let bytes = std::fs::read(dir.join(slot.file)).ok();
        let img = bytes.as_deref().and_then(|b| decode_bmp(b).ok());
        let state = match (&bytes, m.files.get(slot.file)) {
            (None, _) => "missing",
            (Some(b), Some(want)) if *want == hash_bytes(b) => "yours",
            (Some(_), Some(_)) => "changed",
            (Some(_), None) => "game",
        };
        let mut preview = String::new();
        if let (Some(b), Some(img)) = (&bytes, &img) {
            let png = preview_dir.join(format!("{}_{}.png", slot.id, hash_bytes(b)));
            if png.is_file() || std::fs::write(&png, encode_png(img)).is_ok() {
                preview = png.to_string_lossy().into_owned();
            }
        }
        let hot = get_hotspot(&res, res_key(slot)).unwrap_or((0, 0));
        slots.push(CursorSlotStatus {
            slot: slot.id.to_string(),
            file: slot.file.to_string(),
            exists: bytes.is_some(),
            width: img.as_ref().map(|i| i.w).unwrap_or(0),
            height: img.as_ref().map(|i| i.h).unwrap_or(0),
            hot_x: hot.0,
            hot_y: hot.1,
            state: state.to_string(),
            has_backup: bak_path(&dir, slot.file).is_file(),
            preview,
            stock_width: slot.stock.0,
            stock_height: slot.stock.1,
            stock_hot_x: slot.stock_hot.0,
            stock_hot_y: slot.stock_hot.1,
        });
    }
    Ok(CursorStatus { dir: dir.to_string_lossy().into_owned(), dir_exists, slots })
}

/// One ready-made cursor set inside a pack: its folder name and the cursor
/// files it has, by slot id.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackVariant {
    pub name: String,
    pub files: BTreeMap<String, String>,
}

/// Find cursor sets under a folder (an unpacked cursor mod): every folder
/// that holds at least one of the game's cursor file names, any case. A pack
/// with several looks ("Player 1" .. "Player 4") yields one variant each.
pub fn scan_pack(root: &Path) -> Vec<PackVariant> {
    fn walk(dir: &Path, root: &Path, depth: usize, out: &mut Vec<PackVariant>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut files: BTreeMap<String, String> = BTreeMap::new();
        let mut subdirs: Vec<PathBuf> = Vec::new();
        for e in rd.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_lowercase();
            if path.is_dir() {
                if !name.starts_with('.') && !name.starts_with("__") {
                    subdirs.push(path);
                }
            } else if let Some(slot) = SLOTS.iter().find(|s| s.file == name) {
                files.insert(slot.id.to_string(), path.to_string_lossy().into_owned());
            }
        }
        if !files.is_empty() {
            let rel = dir.strip_prefix(root).ok().map(|p| p.to_string_lossy().replace('\\', "/"));
            let name = match rel.as_deref() {
                Some("") | None => root
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "Cursor pack".into()),
                Some(r) => r.to_string(),
            };
            out.push(PackVariant { name, files });
        }
        if depth < 5 {
            subdirs.sort();
            for d in subdirs {
                walk(&d, root, depth + 1, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, 0, &mut out);
    out
}

/// Copy a pack folder's cursor files into `dest` (one sub-folder per
/// variant), so the entries the UI makes from them outlive the source folder.
pub fn adopt_pack(root: &Path, dest: &Path) -> Result<Vec<PackVariant>, String> {
    let mut out = Vec::new();
    for (i, v) in scan_pack(root).into_iter().enumerate() {
        let dir = dest.join(format!("v{i}"));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut files = BTreeMap::new();
        for (slot_id, src) in v.files {
            let Some(slot) = slot_by_id(&slot_id) else { continue };
            let to = dir.join(slot.file);
            std::fs::copy(&src, &to).map_err(|e| format!("{src}: {e}"))?;
            files.insert(slot_id, to.to_string_lossy().into_owned());
        }
        out.push(PackVariant { name: v.name, files });
    }
    Ok(out)
}

/// Write the set as a shareable cursor pack: a zip of the BMPs under the
/// game's file names, a `cursor.res` with the hot spots, and install notes -
/// the same shape the community's cursor mods have.
pub fn export_pack(
    ffmpeg: &str,
    entries: &[CursorEntry],
    out_zip: &Path,
    work: &Path,
) -> Result<String, String> {
    use std::io::Write;
    let rendered = render_all(ffmpeg, entries, work)?;
    if rendered.is_empty() {
        return Err("no cursors are set yet".into());
    }
    if let Some(parent) = out_zip.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = std::fs::File::create(out_zip).map_err(|e| format!("{}: {e}", out_zip.display()))?;
    let mut z = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut res = DEFAULT_RES.to_string();
    for (slot, img, (x, y)) in &rendered {
        z.start_file(slot.file, opts).map_err(|e| e.to_string())?;
        z.write_all(&encode_bmp(img)).map_err(|e| e.to_string())?;
        res = set_hotspot(&res, res_key(slot), *x, *y);
    }
    z.start_file(RES_FILE, opts).map_err(|e| e.to_string())?;
    z.write_all(res.as_bytes()).map_err(|e| e.to_string())?;
    z.start_file("README.txt", opts).map_err(|e| e.to_string())?;
    z.write_all(PACK_README.as_bytes()).map_err(|e| e.to_string())?;
    z.finish().map_err(|e| e.to_string())?;
    Ok(out_zip.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("eim_cursors_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A small test image whose pixels depend on `seed` (alpha varies too).
    fn image(w: u32, h: u32, seed: u8) -> Bgra {
        let mut px = Vec::new();
        for y in 0..h {
            for x in 0..w {
                px.extend_from_slice(&[
                    seed.wrapping_add(x as u8),
                    seed.wrapping_mul(3).wrapping_add(y as u8),
                    (x * 7 + y * 13) as u8,
                    if (x + y) % 3 == 0 { 0 } else { 255 - (x as u8) },
                ]);
            }
        }
        Bgra { w, h, px }
    }

    #[test]
    fn bmp_is_written_in_the_games_layout_and_round_trips() {
        let img = image(5, 3, 40);
        let b = encode_bmp(&img);
        assert_eq!(&b[..2], b"BM");
        assert_eq!(le_u32(&b, 2) as usize, b.len());
        assert_eq!(le_u32(&b, 10), 54, "pixel data right after the two headers");
        assert_eq!(le_u32(&b, 14), 40, "BITMAPINFOHEADER, like the stock cursors");
        assert_eq!((le_i32(&b, 18), le_i32(&b, 22)), (5, 3), "positive height = bottom-up");
        assert_eq!((le_u16(&b, 28), le_u32(&b, 30)), (32, 0), "32-bit BI_RGB");
        // Bottom-up: the file's first row is the image's last.
        assert_eq!(&b[54..54 + 20], &img.px[2 * 20..3 * 20]);
        assert_eq!(decode_bmp(&b).unwrap(), img);
    }

    /// The editors' export: a V5 header, BI_BITFIELDS, rows top-down.
    #[test]
    fn decodes_bitfield_bmps_from_image_editors() {
        let img = image(4, 2, 9);
        let mut b = Vec::new();
        b.extend_from_slice(b"BM");
        b.extend_from_slice(&(138u32 + 32).to_le_bytes());
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(&138u32.to_le_bytes());
        b.extend_from_slice(&124u32.to_le_bytes());
        b.extend_from_slice(&4i32.to_le_bytes());
        b.extend_from_slice(&(-2i32).to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&32u16.to_le_bytes());
        b.extend_from_slice(&3u32.to_le_bytes());
        b.extend_from_slice(&[0u8; 20]);
        // Masks deliberately NOT in BGRA byte order: R in the low byte.
        for m in [0x0000_00ffu32, 0x0000_ff00, 0x00ff_0000, 0xff00_0000] {
            b.extend_from_slice(&m.to_le_bytes());
        }
        b.resize(138, 0);
        for p in img.px.chunks_exact(4) {
            b.extend_from_slice(&[p[2], p[1], p[0], p[3]]);
        }
        assert_eq!(decode_bmp(&b).unwrap(), img);
    }

    #[test]
    fn a_bmp_with_no_alpha_at_all_is_opaque() {
        let mut img = image(3, 3, 1);
        for a in img.px.iter_mut().skip(3).step_by(4) {
            *a = 0;
        }
        let out = decode_bmp(&encode_bmp(&img)).unwrap();
        assert!(out.px.iter().skip(3).step_by(4).all(|a| *a == 255));
        assert!(decode_bmp(b"not a bitmap").is_err());
    }

    #[test]
    fn png_previews_are_well_formed() {
        // Published check values for the two checksums.
        assert_eq!(crc32(b"IEND"), 0xae42_6082);
        assert_eq!(adler32(b"Wikipedia"), 0x11e6_0398);
        let img = image(7, 5, 77);
        let png = encode_png(&img);
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        // Walk the chunks: lengths and CRCs must hold, IHDR must carry the size.
        let (mut at, mut kinds) = (8usize, Vec::new());
        while at < png.len() {
            let len = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
            let tagged = &png[at + 4..at + 8 + len];
            let crc = u32::from_be_bytes(png[at + 8 + len..at + 12 + len].try_into().unwrap());
            assert_eq!(crc32(tagged), crc);
            if &tagged[..4] == b"IHDR" {
                assert_eq!(&tagged[4..12], &[0, 0, 0, 7, 0, 0, 0, 5]);
                assert_eq!(&tagged[12..14], &[8, 6], "8-bit RGBA");
            }
            kinds.push(String::from_utf8_lossy(&tagged[..4]).into_owned());
            at += 12 + len;
        }
        assert_eq!(kinds, ["IHDR", "IDAT", "IEND"]);
    }

    #[test]
    fn hot_spots_edit_only_their_own_block() {
        // A new block for the pointer; the stock leftovers are untouched and
        // "cursor" never matches "cursor_default".
        let t = set_hotspot(DEFAULT_RES, "cursor", 7, 9);
        assert_eq!(get_hotspot(&t, "cursor"), Some((7, 9)));
        assert_eq!(get_hotspot(&t, "cursor_default"), Some((0, 0)));
        assert_eq!(get_hotspot(&t, "cursor_hand_open"), Some((14, 14)));
        assert_eq!(get_hotspot(&t, "cursor_commend"), Some((22, 2)));
        assert_eq!(get_hotspot(&t, "cursor_ping"), None);
        // Replacing an existing block keeps one copy of it.
        let t2 = set_hotspot(&t, "cursor_commend", 40, 12);
        assert_eq!(get_hotspot(&t2, "cursor_commend"), Some((40, 12)));
        assert_eq!(t2.matches("cursor_commend").count(), 1);
        assert_eq!(get_hotspot(&t2, "cursor"), Some((7, 9)));
        // Still one root block, braces balanced, the header line intact.
        assert_eq!(t2.matches('{').count(), t2.matches('}').count());
        assert!(t2.contains("\"resource/cursor/cursor.res\""));
        assert!(t2.trim_end().ends_with('}'));
        // Setting twice is stable.
        assert_eq!(set_hotspot(&t2, "cursor", 7, 9), t2);
    }

    #[test]
    fn sizes_keep_aspect_and_stay_in_the_allowed_box() {
        assert_eq!(target_size(48, 58, 0), (48, 58), "0 keeps the image's own size");
        assert_eq!(target_size(480, 580, 58), (48, 58));
        assert_eq!(target_size(100, 50, 64), (128, 64));
        assert_eq!(target_size(4000, 100, 64), (256, 6), "too wide: shrinks to fit");
        assert_eq!(target_size(2000, 1000, 0), (256, 128), "huge originals are capped");
        assert_eq!(target_size(10, 10, 2), (8, 8), "never smaller than the minimum");
    }

    /// A fake game folder: `citadel/gameinfo.gi` + stock cursors.
    fn fake_game(tag: &str) -> (PathBuf, String, PathBuf) {
        let root = temp_root(tag);
        let citadel = root.join("game").join("citadel");
        let dir = citadel.join("resource").join("cursors");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(citadel.join("gameinfo.gi"), "x").unwrap();
        for (i, s) in SLOTS.iter().enumerate() {
            std::fs::write(dir.join(s.file), encode_bmp(&image(6, 6, 100 + i as u8))).unwrap();
        }
        std::fs::write(dir.join(RES_FILE), DEFAULT_RES).unwrap();
        let pak = citadel.join("pak01_dir.vpk").to_string_lossy().into_owned();
        (root, pak, dir)
    }

    fn entry(slot: &str, src: &Path, hot: (f64, f64)) -> CursorEntry {
        CursorEntry {
            slot: slot.into(),
            source_image: src.to_string_lossy().into_owned(),
            height: 0,
            hot_x: hot.0,
            hot_y: hot.1,
            enabled: true,
        }
    }

    /// The whole life cycle on a fake game folder, with BMP sources at their
    /// own size (no ffmpeg involved): apply, a game update in between,
    /// un-setting one cursor, and restore.
    #[test]
    fn apply_backs_up_tracks_and_restores() {
        let (root, pak, dir) = fake_game("cycle");
        let stock: Vec<Vec<u8>> = SLOTS.iter().map(|s| std::fs::read(dir.join(s.file)).unwrap()).collect();
        let mine_a = root.join("a.bmp");
        let mine_b = root.join("b.BMP");
        std::fs::write(&mine_a, encode_bmp(&image(10, 20, 1))).unwrap();
        std::fs::write(&mine_b, encode_bmp(&image(12, 12, 2))).unwrap();
        let work = root.join("work");
        let previews = root.join("previews");

        // Before: everything is the game's.
        let st = status(&pak, &previews).unwrap();
        assert!(st.dir_exists && st.slots.iter().all(|s| s.state == "game" && !s.has_backup));
        assert!(st.slots.iter().all(|s| Path::new(&s.preview).is_file()));
        assert_eq!((st.slots[3].hot_x, st.slots[3].hot_y), (22, 2), "commend's stock hot spot");

        // Apply the pointer + the shop hand.
        let entries = vec![entry("default", &mine_a, (1.0, 0.5)), entry("shop", &mine_b, (0.0, 0.0))];
        let rep = apply(&pak, "ffmpeg-not-needed", &entries, &work).unwrap();
        assert_eq!(rep.applied, ["default", "shop"]);
        assert_eq!(decode_bmp(&std::fs::read(dir.join("cursor.bmp")).unwrap()).unwrap(), image(10, 20, 1));
        assert_eq!(std::fs::read(bak_path(&dir, "cursor.bmp")).unwrap(), stock[0]);
        assert_eq!(std::fs::read(bak_path(&dir, RES_FILE)).unwrap(), DEFAULT_RES.as_bytes());
        assert!(!bak_path(&dir, "cursor_ping.bmp").exists(), "untouched cursors get no backup");
        let res = std::fs::read_to_string(dir.join(RES_FILE)).unwrap();
        assert_eq!(get_hotspot(&res, "cursor"), Some((9, 10)), "fractions -> pixels of the 10x20 image");
        assert_eq!(get_hotspot(&res, "cursor_shop"), Some((0, 0)));
        assert_eq!(get_hotspot(&res, "cursor_commend"), Some((22, 2)), "stock entry kept");
        let st = status(&pak, &previews).unwrap();
        let states: Vec<&str> = st.slots.iter().map(|s| s.state.as_str()).collect();
        assert_eq!(states, ["yours", "game", "yours", "game"]);
        assert_eq!((st.slots[0].width, st.slots[0].height, st.slots[0].hot_x, st.slots[0].hot_y), (10, 20, 9, 10));

        // Applying again backs nothing up twice (the backup stays the game's).
        apply(&pak, "ffmpeg-not-needed", &entries, &work).unwrap();
        assert_eq!(std::fs::read(bak_path(&dir, "cursor.bmp")).unwrap(), stock[0]);

        // A game update replaces the pointer with a NEW stock file.
        let new_stock = encode_bmp(&image(6, 6, 200));
        std::fs::write(dir.join("cursor.bmp"), &new_stock).unwrap();
        assert_eq!(status(&pak, &previews).unwrap().slots[0].state, "changed");
        // Re-applying keeps the NEW game file as the backup, not the old one.
        apply(&pak, "ffmpeg-not-needed", &entries, &work).unwrap();
        assert_eq!(std::fs::read(bak_path(&dir, "cursor.bmp")).unwrap(), new_stock);

        // Un-set the shop hand: it goes back to the game's, its hot spot too.
        let rep = apply(&pak, "ffmpeg-not-needed", &entries[..1], &work).unwrap();
        assert_eq!(rep.restored, ["shop"]);
        assert_eq!(std::fs::read(dir.join("cursor_shop.bmp")).unwrap(), stock[2]);
        assert!(!bak_path(&dir, "cursor_shop.bmp").exists());
        let res = std::fs::read_to_string(dir.join(RES_FILE)).unwrap();
        assert_eq!(get_hotspot(&res, "cursor_shop"), None, "no stale hot spot left behind");
        assert_eq!(get_hotspot(&res, "cursor"), Some((9, 10)));

        // Restore: the game's files are back, nothing of ours remains.
        let rep = restore(&pak).unwrap();
        assert_eq!((rep.restored, rep.no_backup.len()), (2, 0), "pointer + cursor.res");
        assert_eq!(std::fs::read(dir.join("cursor.bmp")).unwrap(), new_stock);
        assert_eq!(std::fs::read(dir.join(RES_FILE)).unwrap(), DEFAULT_RES.as_bytes());
        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(BAK_EXT) || n == MANIFEST)
            .collect();
        assert!(left.is_empty(), "{left:?}");
        assert!(status(&pak, &previews).unwrap().slots.iter().all(|s| s.state == "game"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Restore after the game already replaced our file must not put an OLD
    /// backup over the game's new one.
    #[test]
    fn restore_never_overwrites_a_newer_game_file() {
        let (root, pak, dir) = fake_game("stale");
        let mine = root.join("m.bmp");
        std::fs::write(&mine, encode_bmp(&image(9, 9, 5))).unwrap();
        apply(&pak, "x", &[entry("ping", &mine, (0.5, 0.5))], &root.join("w")).unwrap();
        let updated = encode_bmp(&image(6, 6, 250));
        std::fs::write(dir.join("cursor_ping.bmp"), &updated).unwrap();
        let rep = restore(&pak).unwrap();
        assert_eq!(std::fs::read(dir.join("cursor_ping.bmp")).unwrap(), updated);
        assert!(!bak_path(&dir, "cursor_ping.bmp").exists(), "the stale backup is dropped");
        assert_eq!(rep.restored, 1, "only cursor.res was still ours");
        // An unreadable source stops the run before anything is written.
        let before = std::fs::read(dir.join("cursor.bmp")).unwrap();
        let bad = entry("default", &root.join("missing.png"), (0.0, 0.0));
        let err = apply(&pak, "x", &[entry("shop", &mine, (0.0, 0.0)), bad], &root.join("w")).unwrap_err();
        assert!(err.contains("cursor.bmp"), "{err}");
        assert_eq!(std::fs::read(dir.join("cursor.bmp")).unwrap(), before);
        assert!(!dir.join(MANIFEST).exists(), "nothing was applied");
        // A folder that is not a Deadlock install is refused outright.
        assert!(cursors_dir(&root.to_string_lossy()).is_err());
        assert!(cursors_dir("").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn packs_are_found_per_variant_and_adopted() {
        let root = temp_root("pack");
        let p1 = root.join("Wii Cursors").join("Player 1");
        let p2 = root.join("Wii Cursors").join("Player 2");
        std::fs::create_dir_all(&p1).unwrap();
        std::fs::create_dir_all(&p2).unwrap();
        std::fs::create_dir_all(root.join("__MACOSX")).unwrap();
        std::fs::write(root.join("__MACOSX").join("cursor.bmp"), b"junk").unwrap();
        std::fs::write(p1.join("Cursor.BMP"), encode_bmp(&image(4, 4, 1))).unwrap();
        std::fs::write(p1.join("cursor_commend.bmp"), encode_bmp(&image(4, 4, 2))).unwrap();
        std::fs::write(p2.join("cursor_ping.bmp"), encode_bmp(&image(4, 4, 3))).unwrap();
        std::fs::write(p2.join("readme.txt"), "hi").unwrap();
        let found = scan_pack(&root);
        assert_eq!(found.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(), ["Wii Cursors/Player 1", "Wii Cursors/Player 2"]);
        assert_eq!(found[0].files.keys().collect::<Vec<_>>(), ["commend", "default"]);
        assert_eq!(found[1].files.keys().collect::<Vec<_>>(), ["ping"]);
        // A flat pack is named after its folder.
        let flat = root.join("kitty_cursor");
        std::fs::create_dir_all(&flat).unwrap();
        std::fs::write(flat.join("cursor_shop.bmp"), encode_bmp(&image(4, 4, 4))).unwrap();
        assert_eq!(scan_pack(&flat)[0].name, "kitty_cursor");
        // Adopting copies the files under the game's own names.
        let adopted = adopt_pack(&root.join("Wii Cursors"), &root.join("adopted")).unwrap();
        assert_eq!(adopted.len(), 2);
        let p = Path::new(&adopted[0].files["default"]);
        assert!(p.is_file() && p.file_name().unwrap() == "cursor.bmp");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Real community packs off this machine's Downloads (the two the feature
    /// was built against): unzip, find the looks, apply one to a fake game
    /// folder, and check the game folder ends up with the pack's exact pixels
    /// in the game's own BMP layout. Skips quietly when the zips are gone.
    ///   cargo test -p app --lib -- --ignored e2e_cursor_packs_real --nocapture
    #[test]
    #[ignore]
    fn e2e_cursor_packs_real() {
        let unzip = |zip_path: &Path, dest: &Path| {
            let mut ar = zip::ZipArchive::new(std::fs::File::open(zip_path).unwrap()).unwrap();
            ar.extract(dest).unwrap();
        };
        for (zip_name, want_looks, want_files) in
            [("kitty_cursor.zip", 1usize, 3usize), ("deadlock_nintendo_wii_cursors.zip", 4, 4)]
        {
            let zip_path = Path::new(r"D:\Downloads 2.0").join(zip_name);
            if !zip_path.is_file() {
                eprintln!("skip: {} not on this machine", zip_path.display());
                continue;
            }
            let (root, pak, dir) = fake_game("realpack");
            unzip(&zip_path, &root.join("unpacked"));
            let looks = adopt_pack(&root.join("unpacked"), &root.join("adopted")).unwrap();
            eprintln!("{zip_name}: {:?}", looks.iter().map(|v| (&v.name, v.files.len())).collect::<Vec<_>>());
            assert_eq!(looks.len(), want_looks);
            assert!(looks.iter().all(|v| v.files.len() == want_files));
            let entries: Vec<CursorEntry> = looks[0]
                .files
                .iter()
                .map(|(slot, src)| entry(slot, Path::new(src), (0.0, 0.0)))
                .collect();
            let rep = apply(&pak, "ffmpeg-not-needed", &entries, &root.join("work")).unwrap();
            assert_eq!(rep.applied.len(), want_files);
            for (slot_id, src) in &looks[0].files {
                let slot = slot_by_id(slot_id).unwrap();
                let written = std::fs::read(dir.join(slot.file)).unwrap();
                // The game's layout, whatever the pack's own header was...
                assert_eq!((le_u32(&written, 14), le_u16(&written, 28), le_u32(&written, 30)), (40, 32, 0));
                // ...holding the pack's pixels exactly.
                let ours = decode_bmp(&written).unwrap();
                let theirs = decode_bmp(&std::fs::read(src).unwrap()).unwrap();
                assert_eq!(ours, theirs, "{slot_id}");
                let alpha: Vec<u8> = ours.px.iter().skip(3).step_by(4).copied().collect();
                assert!(alpha.contains(&0) && alpha.contains(&255), "{slot_id}: real transparency kept");
                eprintln!("  {} <- {}x{}", slot.file, ours.w, ours.h);
            }
            let rep = restore(&pak).unwrap();
            assert_eq!(rep.restored, want_files + 1, "every cursor + cursor.res");
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    /// Real ffmpeg: a transparent PNG is resized into a cursor with its alpha
    /// intact, an exported pack holds the game's file names, and the real
    /// game folder + a real community pack decode. Run with:
    ///   cargo test -p app --lib -- --ignored e2e_cursors_real_ffmpeg --nocapture
    #[test]
    #[ignore]
    fn e2e_cursors_real_ffmpeg() {
        let (root, pak, dir) = fake_game("e2e");
        // 96x120 source: transparent left half, opaque right half.
        let mut src = Bgra { w: 96, h: 120, px: Vec::new() };
        for _y in 0..120 {
            for x in 0..96u32 {
                src.px.extend_from_slice(&[30, 200, 240, if x < 48 { 0 } else { 255 }]);
            }
        }
        let png = root.join("art.png");
        std::fs::write(&png, encode_png(&src)).unwrap();
        let mut e = entry("default", &png, (0.5, 0.0));
        e.height = 60;
        let rep = apply(&pak, "ffmpeg", &[e.clone()], &root.join("work")).unwrap();
        assert_eq!(rep.applied, ["default"]);
        let bytes = std::fs::read(dir.join("cursor.bmp")).unwrap();
        assert_eq!((le_u32(&bytes, 14), le_u16(&bytes, 28), le_u32(&bytes, 30)), (40, 32, 0));
        let out = decode_bmp(&bytes).unwrap();
        assert_eq!((out.w, out.h), (48, 60), "our own PNG went through ffmpeg and came back sized");
        let alpha_at = |x: u32, y: u32| out.px[((y * out.w + x) * 4 + 3) as usize];
        assert_eq!(alpha_at(4, 30), 0, "transparent side stays transparent");
        assert_eq!(alpha_at(44, 30), 255, "opaque side stays opaque");
        let px = &out.px[((30 * out.w + 44) * 4) as usize..][..3];
        assert!(px[0] < 60 && px[1] > 170 && px[2] > 210, "colour survives: {px:?}");
        let res = std::fs::read_to_string(dir.join(RES_FILE)).unwrap();
        assert_eq!(get_hotspot(&res, "cursor"), Some((24, 0)));
        eprintln!("resized cursor: {}x{} hot {:?}", out.w, out.h, get_hotspot(&res, "cursor"));

        // Export: a zip in the community pack shape.
        let zip_path = root.join("out").join("my_cursors.zip");
        export_pack("ffmpeg", &[e], &zip_path, &root.join("work")).unwrap();
        let mut ar = zip::ZipArchive::new(std::fs::File::open(&zip_path).unwrap()).unwrap();
        let mut names: Vec<String> = (0..ar.len()).map(|i| ar.by_index(i).unwrap().name().to_string()).collect();
        names.sort();
        assert_eq!(names, ["README.txt", "cursor.bmp", "cursor.res"]);

        // The real game folder and a real community pack, when present.
        let game = Path::new(r"D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\resource\cursors");
        for s in &SLOTS {
            if let Ok(b) = std::fs::read(game.join(s.file)) {
                let img = decode_bmp(&b).unwrap_or_else(|e| panic!("{}: {e}", s.file));
                eprintln!("game {}: {}x{} (expected {}x{} if stock)", s.file, img.w, img.h, s.stock.0, s.stock.1);
                // Our encoder reproduces the game's own pixel data exactly.
                let again = encode_bmp(&img);
                assert_eq!(decode_bmp(&again).unwrap(), img);
                if le_u32(&b, 14) == 40 {
                    assert_eq!(&again[14..34], &b[14..34], "same info header up to the compression field");
                }
            }
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
