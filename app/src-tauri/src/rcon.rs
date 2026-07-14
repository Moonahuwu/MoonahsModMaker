//! Minimal Source RCON client (the protocol Deadlock's dedicated server speaks).
//!
//! This is what powers the in-app admin panel: the dedicated server opens a TCP
//! socket and accepts password-authenticated commands (`status`, `changelevel`,
//! `exec ...botmatch...`, etc.). We proved the live server speaks this protocol
//! and — importantly — binds RCON to the machine's **LAN IP, not 127.0.0.1**
//! (loopback is refused), so `exec_auto` tries the primary LAN address first.
//!
//! Protocol (Valve "Source RCON"): each packet is
//!   i32 size (of everything after this field) | i32 id | i32 type |
//!   body (null-terminated) | one trailing null byte.
//! Auth = send type 3 with the password; the server answers type 2 with id == -1
//! on failure or the request id on success. Commands = type 2 (EXECCOMMAND);
//! responses come back as type 0 (RESPONSE_VALUE), possibly split across packets.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, UdpSocket};
use std::time::Duration;

const SERVERDATA_AUTH: i32 = 3;
const SERVERDATA_AUTH_RESPONSE: i32 = 2;
const SERVERDATA_EXECCOMMAND: i32 = 2;
const SERVERDATA_RESPONSE_VALUE: i32 = 0;

/// The TCP port Deadlock's dedicated server listens on (same as the game port).
pub const RCON_PORT: u16 = 27015;

fn encode(id: i32, ptype: i32, body: &str) -> Vec<u8> {
    let body = body.as_bytes();
    let size = (4 + 4 + body.len() + 2) as i32; // id + type + body + two nulls
    let mut buf = Vec::with_capacity(size as usize + 4);
    buf.extend_from_slice(&size.to_le_bytes());
    buf.extend_from_slice(&id.to_le_bytes());
    buf.extend_from_slice(&ptype.to_le_bytes());
    buf.extend_from_slice(body);
    buf.extend_from_slice(&[0, 0]);
    buf
}

/// Read exactly one RCON packet → (id, type, body). Surfaces timeouts so callers
/// can use a short read timeout as an end-of-response signal.
fn read_packet(stream: &mut TcpStream) -> Result<(i32, i32, String), String> {
    let mut size_buf = [0u8; 4];
    stream
        .read_exact(&mut size_buf)
        .map_err(|e| format!("rcon read: {e}"))?;
    let size = i32::from_le_bytes(size_buf);
    if !(10..=8192).contains(&size) {
        return Err(format!("rcon: implausible packet size {size}"));
    }
    let mut body = vec![0u8; size as usize];
    stream
        .read_exact(&mut body)
        .map_err(|e| format!("rcon read body: {e}"))?;
    let id = i32::from_le_bytes(body[0..4].try_into().unwrap());
    let ptype = i32::from_le_bytes(body[4..8].try_into().unwrap());
    // Body is null-terminated, plus the packet's trailing null → strip up to 2.
    let text = String::from_utf8_lossy(&body[8..body.len().saturating_sub(2)]).to_string();
    Ok((id, ptype, text))
}

/// Run one command against the server at `addr` and return its console output.
pub fn exec(addr: SocketAddr, password: &str, command: &str) -> Result<String, String> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(4))
        .map_err(|e| format!("connecting to {addr}: {e}"))?;
    stream.set_write_timeout(Some(Duration::from_secs(4))).ok();
    // Generous timeout for the auth + first response; the server can be busy.
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();

    // --- authenticate ---
    stream
        .write_all(&encode(1, SERVERDATA_AUTH, password))
        .map_err(|e| format!("rcon auth send: {e}"))?;
    loop {
        let (id, ptype, _) = read_packet(&mut stream)?;
        // The server may emit an empty RESPONSE_VALUE before the auth verdict.
        if ptype == SERVERDATA_AUTH_RESPONSE {
            if id == -1 {
                return Err("RCON auth failed - wrong password (relaunch the host so the password matches)".into());
            }
            break;
        }
    }

    // --- run the command ---
    stream
        .write_all(&encode(2, SERVERDATA_EXECCOMMAND, command))
        .map_err(|e| format!("rcon exec send: {e}"))?;

    // Read the (possibly multi-packet) response. After the first packet arrives,
    // drop to a short idle timeout — when no further packet comes, we're done.
    let mut out = String::new();
    let mut first = true;
    loop {
        match read_packet(&mut stream) {
            Ok((_, ptype, body)) => {
                if ptype == SERVERDATA_RESPONSE_VALUE {
                    out.push_str(&body);
                }
                if first {
                    first = false;
                    stream.set_read_timeout(Some(Duration::from_millis(700))).ok();
                }
            }
            Err(_) => break, // idle timeout (or close) = end of response
        }
    }
    Ok(out)
}

/// Best-effort primary LAN IPv4 (no packets are actually sent — connecting a UDP
/// socket just resolves the OS's outbound route). Used because the server binds
/// RCON to this address rather than loopback.
fn primary_ip() -> Option<IpAddr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip())
}

/// Where is the RCON listener ACTUALLY bound? Read the OS TCP table instead
/// of guessing interfaces: the engine binds a seemingly arbitrary adapter
/// (observed: a WSL/Hyper-V virtual adapter at 192.168.208.1 while the real
/// LAN IP had nothing), which made every guessed-address connect fail
/// "refused" even though the server was fine.
fn rcon_listener_ips() -> Vec<IpAddr> {
    let mut out: Vec<IpAddr> = Vec::new();
    let Ok(o) = crate::procutil::quiet("netstat").args(["-ano", "-p", "tcp"]).output() else {
        return out;
    };
    let text = String::from_utf8_lossy(&o.stdout);
    for line in text.lines() {
        let l = line.trim();
        if !l.to_ascii_uppercase().starts_with("TCP") || !l.contains("LISTENING") {
            continue;
        }
        // "TCP    192.168.208.1:27015    0.0.0.0:0    LISTENING    51372"
        let Some(local) = l.split_whitespace().nth(1) else { continue };
        let Some((ip, port)) = local.rsplit_once(':') else { continue };
        if port != RCON_PORT.to_string() {
            continue;
        }
        // A wildcard bind is reachable via loopback; otherwise use the bound ip.
        let parsed = if ip == "0.0.0.0" {
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        } else if let Ok(p) = ip.parse::<IpAddr>() {
            p
        } else {
            continue;
        };
        if !out.contains(&parsed) {
            out.push(parsed);
        }
    }
    out
}

/// Is a server's RCON/game TCP listener up right now? Pure OS-table lookup -
/// no packets touch the game port (backs the pre-launch double-launch guard).
pub fn server_listening() -> bool {
    !rcon_listener_ips().is_empty()
}

/// Try the command against the most likely host addresses (LAN IP first, then
/// loopback) so the caller doesn't have to know which interface the server bound.
pub fn exec_auto(password: &str, command: &str) -> Result<String, String> {
    // The ACTUAL bound address first (from the TCP table), then the guessed
    // primary LAN IP and loopback as fallbacks for table-read failures.
    let mut candidates: Vec<IpAddr> = rcon_listener_ips();
    if let Some(ip) = primary_ip() {
        if !candidates.contains(&ip) {
            candidates.push(ip);
        }
    }
    let lo = IpAddr::V4(Ipv4Addr::LOCALHOST);
    if !candidates.contains(&lo) {
        candidates.push(lo);
    }

    // Report EVERY address tried: showing only the last error hid the LAN
    // attempt (the one that matters - the server binds RCON to the LAN IP,
    // loopback refusing is normal) and made boot-time failures unreadable.
    let mut errs: Vec<String> = Vec::new();
    for ip in candidates {
        match exec(SocketAddr::new(ip, RCON_PORT), password, command) {
            Ok(out) => return Ok(out),
            // An auth failure is definitive (right host, wrong password) so
            // surface it immediately; other errors → try the next address.
            Err(e) if e.starts_with("RCON auth failed") => return Err(e),
            Err(e) => errs.push(e),
        }
    }
    Err(format!(
        "{}. If the server is still loading the map, RCON isn't open yet - wait for it to finish booting and try again.",
        errs.join("; ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_layout_is_correct() {
        // body "hi" → size = 4+4+2+2 = 12
        let p = encode(7, SERVERDATA_AUTH, "hi");
        assert_eq!(i32::from_le_bytes(p[0..4].try_into().unwrap()), 12);
        assert_eq!(i32::from_le_bytes(p[4..8].try_into().unwrap()), 7);
        assert_eq!(i32::from_le_bytes(p[8..12].try_into().unwrap()), SERVERDATA_AUTH);
        assert_eq!(&p[12..14], b"hi");
        assert_eq!(&p[14..16], &[0, 0]); // null-terminator + trailing null
        assert_eq!(p.len(), 16);
    }

    #[test]
    fn encode_empty_body() {
        let p = encode(0, SERVERDATA_RESPONSE_VALUE, "");
        assert_eq!(i32::from_le_bytes(p[0..4].try_into().unwrap()), 10);
        assert_eq!(p.len(), 14);
    }
}
