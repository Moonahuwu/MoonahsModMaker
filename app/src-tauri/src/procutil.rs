//! Child-process helpers.
//!
//! The release build is a windowless GUI app (`windows_subsystem = "windows"`),
//! so on Windows every spawned console tool (ffmpeg, ffprobe, resourcecompiler,
//! vpk-helper, curl, tar, reg) would otherwise pop its own console window — a
//! compile run flashes dozens of them. `quiet()` creates the command with
//! CREATE_NO_WINDOW so children run invisibly; their stdout/stderr are still
//! captured normally via `.output()`. Dev builds have a console the children
//! would inherit, which is why this only ever showed up in the packaged exe.
//!
//! Do NOT use this for processes that are *supposed* to show a window (the
//! dedicated server console in `host.rs` uses CREATE_NEW_CONSOLE instead).

use std::ffi::OsStr;
use std::process::Command;

/// `Command::new`, but the child gets no console window on Windows.
pub fn quiet(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    hide_window(&mut cmd);
    cmd
}

#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_cmd: &mut Command) {}
