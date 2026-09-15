//! Port forwarding (`-L` / `-R`) and the ProxyJump rules, kept apart from the
//! session plumbing so the parts that decide what is *allowed* can be tested
//! without a server.
//!
//! * **Local** (`-L`): ARC listens on `127.0.0.1:<bind_port>` and pipes each
//!   accepted socket through a `direct-tcpip` channel to `dest_host:dest_port`
//!   as seen from the server.
//! * **Remote** (`-R`): the server listens on its loopback `<bind_port>` and
//!   hands each connection back as a `forwarded-tcpip` channel, which ARC pipes
//!   to `dest_host:dest_port` as seen from this machine.
//!
//! Loopback only, both ways. Binding a forward on every interface turns a
//! laptop (or the server) into an open relay for whoever shares the network,
//! and nobody reaches for that by accident in a GUI.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForwardKind {
    Local,
    Remote,
}

/// One forward, as saved on a host and as requested on a live session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForwardSpec {
    pub kind: ForwardKind,
    /// Local: the port ARC listens on. Remote: the port the server listens on.
    pub bind_port: u16,
    pub dest_host: String,
    pub dest_port: u16,
}

impl ForwardSpec {
    /// Checked at the trust boundary (saving a host, adding a live forward)
    /// so a bad spec fails with a sentence instead of a socket error later.
    ///
    /// Port 0 is refused on the bind side: "any free port" would work, but the
    /// user would then have to go and find out which one, and a saved forward
    /// that moves every connect is not what anyone saves.
    pub fn validate(&self) -> Result<()> {
        if self.bind_port == 0 {
            return Err(anyhow!("listen port must be 1-65535"));
        }
        if self.dest_port == 0 {
            return Err(anyhow!("destination port must be 1-65535"));
        }
        let host = self.dest_host.trim();
        if host.is_empty() {
            return Err(anyhow!("destination host is required"));
        }
        if host.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(anyhow!("destination host can't contain spaces"));
        }
        Ok(())
    }
}

/// Validate a host's jump setting before it is saved.
///
/// One level of ProxyJump only: the jump host must connect directly, and a
/// host other hosts already jump through can't take a jump of its own (that
/// would make them two levels deep). Those two rules also rule out every
/// cycle, but the self and two-host cases get their own message because
/// "cycle" is what the user actually did.
///
/// * `host_id` — the host being saved; `None` for a new one.
/// * `jump_of_jump` — the chosen jump host's own `jump_host_id`.
/// * `jumped_through` — whether any other host names `host_id` as its jump.
pub fn check_jump(
    host_id: Option<&str>,
    jump_id: &str,
    jump_of_jump: Option<&str>,
    jumped_through: bool,
) -> Result<()> {
    if host_id == Some(jump_id) {
        return Err(anyhow!("a host can't be its own jump host"));
    }
    if let Some(next) = jump_of_jump {
        if host_id == Some(next) {
            return Err(anyhow!("jump hosts would form a cycle"));
        }
        return Err(anyhow!(
            "the jump host uses a jump host itself; only one level is supported"
        ));
    }
    if jumped_through {
        return Err(anyhow!(
            "other hosts jump through this one, so it can't use a jump host itself"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(bind: u16, host: &str, dest: u16) -> ForwardSpec {
        ForwardSpec {
            kind: ForwardKind::Local,
            bind_port: bind,
            dest_host: host.into(),
            dest_port: dest,
        }
    }

    #[test]
    fn forward_spec_validation() {
        assert!(spec(8080, "localhost", 80).validate().is_ok());
        assert!(spec(0, "localhost", 80).validate().is_err());
        assert!(spec(8080, "localhost", 0).validate().is_err());
        assert!(spec(8080, "  ", 80).validate().is_err());
        assert!(spec(8080, "db host", 5432).validate().is_err());
    }

    #[test]
    fn jump_rules() {
        // New host through a direct host: fine.
        assert!(check_jump(None, "bastion", None, false).is_ok());
        assert!(check_jump(Some("app"), "bastion", None, false).is_ok());
        // Self.
        assert!(check_jump(Some("app"), "app", None, false).is_err());
        // Two-host cycle: app -> bastion while bastion -> app.
        let e = check_jump(Some("app"), "bastion", Some("app"), true).unwrap_err();
        assert!(e.to_string().contains("cycle"), "{e}");
        // Two levels.
        assert!(check_jump(Some("app"), "bastion", Some("edge"), false).is_err());
        // Something already jumps through this host.
        assert!(check_jump(Some("bastion"), "edge", None, true).is_err());
    }
}
