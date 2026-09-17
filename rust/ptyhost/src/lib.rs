//! arc-ptyhost — keeps terminal sessions alive across ARC restarts.
//!
//! A small detached process (`arc-ptyhost`) owns the PTYs of persistent
//! terminal tabs, so closing ARC leaves the shells — and whatever agent CLI is
//! mid-conversation inside them — running. ARC talks to it over a per-user
//! local IPC endpoint (a named pipe on Windows, a Unix socket elsewhere) and
//! reattaches each restored tab by its id on the next launch.
//!
//!   [`proto`]  — frame codec + messages, shared by both ends
//!   [`host`]   — the host process: sessions, ring buffers, idle exit
//!   [`client`] — what ARC embeds: launch-on-demand, spawn / attach / write …

pub mod client;
pub mod host;
mod ipc;
pub mod proto;
mod ring;

pub use ipc::default_endpoint;
