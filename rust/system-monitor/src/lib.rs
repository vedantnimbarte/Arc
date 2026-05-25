//! arc-system-monitor — host resource introspection.
//!
//! Wraps the `sysinfo` crate so the desktop app can show live CPU / RAM /
//! disk / network metrics in the topbar popover, plus a process table in
//! the System Resources tab. All public functions go through a shared
//! `Monitor` so the underlying `sysinfo::System` is refreshed exactly once
//! per call and the network deltas have a stable reference point.

use std::time::Instant;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sysinfo::{
    CpuRefreshKind, Disks, MemoryRefreshKind, Networks, Pid, ProcessRefreshKind, RefreshKind,
    System, Users,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SystemError {
    #[error("no such process: {0}")]
    NoSuchProcess(u32),
    #[error("kill failed for pid {0}")]
    KillFailed(u32),
}

pub type Result<T> = std::result::Result<T, SystemError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemSnapshot {
    /// Global CPU usage percentage averaged across all cores (0..100).
    pub cpu_percent: f32,
    /// Logical CPU count.
    pub cpu_count: u32,
    pub ram_used_bytes: u64,
    pub ram_total_bytes: u64,
    /// Aggregated used/total bytes across all fixed disks.
    pub disk_used_bytes: u64,
    pub disk_total_bytes: u64,
    /// Per-second network throughput, diffed against the previous snapshot.
    pub net_rx_bytes_per_sec: u64,
    pub net_tx_bytes_per_sec: u64,
    /// Process count at snapshot time.
    pub process_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
    pub user: Option<String>,
}

struct NetState {
    last_sample_at: Instant,
    last_rx_total: u64,
    last_tx_total: u64,
}

pub struct Monitor {
    inner: Mutex<Inner>,
}

struct Inner {
    sys: System,
    disks: Disks,
    networks: Networks,
    users: Users,
    net: Option<NetState>,
}

impl Monitor {
    pub fn new() -> Self {
        let sys = System::new_with_specifics(
            RefreshKind::new()
                .with_cpu(CpuRefreshKind::everything())
                .with_memory(MemoryRefreshKind::everything())
                .with_processes(ProcessRefreshKind::everything()),
        );
        let disks = Disks::new_with_refreshed_list();
        let networks = Networks::new_with_refreshed_list();
        let users = Users::new_with_refreshed_list();
        Self {
            inner: Mutex::new(Inner {
                sys,
                disks,
                networks,
                users,
                net: None,
            }),
        }
    }

    /// Refresh the underlying probe and return a one-shot snapshot.
    pub fn snapshot(&self) -> SystemSnapshot {
        let mut guard = self.inner.lock();
        guard.sys.refresh_cpu();
        guard.sys.refresh_memory();
        guard
            .sys
            .refresh_processes_specifics(ProcessRefreshKind::everything().without_disk_usage());
        guard.disks.refresh();
        guard.networks.refresh();

        let cpu_percent = guard.sys.global_cpu_info().cpu_usage();
        let cpu_count = guard.sys.cpus().len() as u32;
        let ram_used_bytes = guard.sys.used_memory();
        let ram_total_bytes = guard.sys.total_memory();

        let (mut disk_total_bytes, mut disk_used_bytes) = (0u64, 0u64);
        for d in guard.disks.iter() {
            // Skip removable mounts so the headline number reflects the
            // user's primary working storage rather than an attached USB.
            if d.is_removable() {
                continue;
            }
            let total = d.total_space();
            let free = d.available_space();
            disk_total_bytes = disk_total_bytes.saturating_add(total);
            disk_used_bytes = disk_used_bytes.saturating_add(total.saturating_sub(free));
        }

        // Network rates: sysinfo's `received()` / `transmitted()` are
        // per-refresh deltas in 0.30, but they're tied to whatever interval
        // happens to pass between two refreshes — which on first refresh
        // since boot can be the entire uptime. Track our own cumulative
        // total and diff against the previous sample's timestamp so the
        // rate is in real seconds.
        let (rx_total, tx_total) = guard.networks.iter().fold((0u64, 0u64), |(rx, tx), (_, n)| {
            (
                rx.saturating_add(n.total_received()),
                tx.saturating_add(n.total_transmitted()),
            )
        });
        let now = Instant::now();
        let (net_rx_bytes_per_sec, net_tx_bytes_per_sec) = match guard.net.as_ref() {
            Some(prev) => {
                let dt = now.saturating_duration_since(prev.last_sample_at).as_secs_f64();
                if dt > 0.05 {
                    let rx = ((rx_total.saturating_sub(prev.last_rx_total)) as f64 / dt) as u64;
                    let tx = ((tx_total.saturating_sub(prev.last_tx_total)) as f64 / dt) as u64;
                    (rx, tx)
                } else {
                    (0, 0)
                }
            }
            None => (0, 0),
        };
        guard.net = Some(NetState {
            last_sample_at: now,
            last_rx_total: rx_total,
            last_tx_total: tx_total,
        });

        let process_count = guard.sys.processes().len() as u32;

        SystemSnapshot {
            cpu_percent,
            cpu_count,
            ram_used_bytes,
            ram_total_bytes,
            disk_used_bytes,
            disk_total_bytes,
            net_rx_bytes_per_sec,
            net_tx_bytes_per_sec,
            process_count,
        }
    }

    /// List every visible process with its current CPU% and memory
    /// footprint. The caller does the sort/filter — keeping this raw means
    /// the UI can switch columns without a round-trip.
    pub fn processes(&self) -> Vec<ProcessInfo> {
        let mut guard = self.inner.lock();
        guard
            .sys
            .refresh_processes_specifics(ProcessRefreshKind::everything().without_disk_usage());
        guard.users.refresh_list();
        let users = &guard.users;
        guard
            .sys
            .processes()
            .iter()
            .map(|(pid, proc_)| {
                let user = proc_
                    .user_id()
                    .and_then(|uid| users.get_user_by_id(uid))
                    .map(|u| u.name().to_string());
                ProcessInfo {
                    pid: pid.as_u32(),
                    name: proc_.name().to_string(),
                    cpu_percent: proc_.cpu_usage(),
                    memory_bytes: proc_.memory(),
                    user,
                }
            })
            .collect()
    }

    /// Send the platform's standard "terminate" signal to `pid`. On
    /// Windows this calls `TerminateProcess`; on Unix it's `SIGKILL`.
    pub fn kill(&self, pid: u32) -> Result<()> {
        let mut guard = self.inner.lock();
        guard
            .sys
            .refresh_processes_specifics(ProcessRefreshKind::everything().without_disk_usage());
        let process = guard
            .sys
            .process(Pid::from_u32(pid))
            .ok_or(SystemError::NoSuchProcess(pid))?;
        if process.kill() {
            Ok(())
        } else {
            Err(SystemError::KillFailed(pid))
        }
    }
}

impl Default for Monitor {
    fn default() -> Self {
        Self::new()
    }
}
