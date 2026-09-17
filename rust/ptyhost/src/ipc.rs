//! The local, same-user IPC endpoint.
//!
//! Anyone who can connect can run commands as the user, so access control is
//! the whole point of this module:
//!   * Windows — a named pipe whose DACL grants the current user only, that
//!     refuses remote clients, and that the host must create *first* (so a
//!     squatter can't own the name). The client additionally checks the pipe
//!     it opened is owned by its own user before sending anything.
//!   * Unix — a socket inside a 0700 directory owned by the user, the socket
//!     itself 0600, and every accepted peer's uid checked against ours.
//!
//! Nothing here ever listens on the network.

pub use imp::{connect, default_endpoint, Listener, Stream};

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::time::Duration;

    use tokio::net::windows::named_pipe::{
        ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
    };
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, ERROR_PIPE_BUSY, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        GetSecurityInfo, SDDL_REVISION_1, SE_KERNEL_OBJECT,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
        SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    pub type Stream = NamedPipeClient;

    /// `\\.\pipe\arc-ptyhost-<user SID>`.
    pub fn default_endpoint() -> io::Result<String> {
        Ok(format!(r"\\.\pipe\arc-ptyhost-{}", user_sid()?))
    }

    pub struct Listener {
        name: String,
        /// Self-relative security descriptor from SDDL; lives as long as the
        /// listener, which is the host's lifetime.
        sd: PSECURITY_DESCRIPTOR,
        next: NamedPipeServer,
    }

    // `sd` is only read, by `create`, after construction.
    unsafe impl Send for Listener {}

    impl Listener {
        /// Fails if the name already exists — another host is running.
        pub fn bind(name: &str) -> io::Result<Self> {
            let sid = user_sid()?;
            // Owner and the only ACE are this user; `P` blocks inherited ACEs.
            let sddl: Vec<u16> = format!("O:{sid}D:P(A;;GA;;;{sid})")
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            let ok = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut sd,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            let next = create(name, sd, true)?;
            Ok(Self { name: name.to_string(), sd, next })
        }

        pub async fn accept(&mut self) -> io::Result<NamedPipeServer> {
            self.next.connect().await?;
            let fresh = create(&self.name, self.sd, false)?;
            Ok(std::mem::replace(&mut self.next, fresh))
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            unsafe { LocalFree(self.sd as _) };
        }
    }

    fn create(name: &str, sd: PSECURITY_DESCRIPTOR, first: bool) -> io::Result<NamedPipeServer> {
        let mut sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd,
            bInheritHandle: 0,
        };
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(name, &mut sa as *mut _ as *mut c_void)
        }
    }

    pub async fn connect(name: &str) -> io::Result<NamedPipeClient> {
        let mut busy = 0;
        let client = loop {
            match ClientOptions::new().open(name) {
                Ok(c) => break c,
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) && busy < 100 => {
                    busy += 1;
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(e) => return Err(e),
            }
        };
        // A pipe of this name created by another user would receive our
        // keystrokes; refuse to talk to it.
        let owner = unsafe {
            let mut owner: PSID = std::ptr::null_mut();
            let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            let rc = GetSecurityInfo(
                client.as_raw_handle() as HANDLE,
                SE_KERNEL_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut sd,
            );
            if rc != 0 {
                return Err(io::Error::from_raw_os_error(rc as i32));
            }
            let s = sid_string(owner);
            LocalFree(sd as _);
            s?
        };
        if owner != user_sid()? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "arc-ptyhost pipe is owned by another user",
            ));
        }
        Ok(client)
    }

    fn user_sid() -> io::Result<String> {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut len = 0u32;
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
            // usize-aligned so the TOKEN_USER read below is aligned.
            let mut buf = vec![0usize; (len as usize).div_ceil(std::mem::size_of::<usize>())];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buf.as_mut_ptr() as *mut c_void,
                len,
                &mut len,
            );
            CloseHandle(token);
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            sid_string(user.User.Sid)
        }
    }

    unsafe fn sid_string(sid: PSID) -> io::Result<String> {
        let mut s: *mut u16 = std::ptr::null_mut();
        if ConvertSidToStringSidW(sid, &mut s) == 0 {
            return Err(io::Error::last_os_error());
        }
        let len = (0..).take_while(|&i| *s.add(i) != 0).count();
        let out = String::from_utf16_lossy(std::slice::from_raw_parts(s, len));
        LocalFree(s as _);
        Ok(out)
    }
}

#[cfg(unix)]
mod imp {
    use std::fs;
    use std::io;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    use std::path::Path;

    use tokio::net::{UnixListener, UnixStream};

    pub type Stream = UnixStream;

    fn uid() -> u32 {
        unsafe { libc::getuid() }
    }

    /// `$XDG_RUNTIME_DIR/arc-ptyhost-<uid>/sock`, or the same under the temp dir.
    pub fn default_endpoint() -> io::Result<String> {
        let base = dirs::runtime_dir().unwrap_or_else(std::env::temp_dir);
        let path = base.join(format!("arc-ptyhost-{}", uid())).join("sock");
        Ok(path.to_string_lossy().into_owned())
    }

    /// Create the socket's directory 0700, or verify an existing one is ours
    /// and private — the temp dir is shared, so it may have been pre-created.
    fn private_dir(sock: &str) -> io::Result<()> {
        let dir = Path::new(sock)
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "bad endpoint"))?;
        match fs::DirBuilder::new().mode(0o700).create(dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        let meta = fs::symlink_metadata(dir)?;
        if !meta.is_dir() || meta.uid() != uid() || meta.mode() & 0o077 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "arc-ptyhost socket directory is not private to this user",
            ));
        }
        Ok(())
    }

    pub struct Listener(UnixListener);

    impl Listener {
        /// Fails if a live host already answers on `name`.
        pub fn bind(name: &str) -> io::Result<Self> {
            private_dir(name)?;
            if std::os::unix::net::UnixStream::connect(name).is_ok() {
                return Err(io::Error::new(io::ErrorKind::AddrInUse, "host already running"));
            }
            // ponytail: a stale socket is removed unlocked; two hosts starting in
            // the same instant can race here. Add an flock if that ever shows up.
            let _ = fs::remove_file(name);
            let listener = UnixListener::bind(name)?;
            fs::set_permissions(name, fs::Permissions::from_mode(0o600))?;
            Ok(Self(listener))
        }

        pub async fn accept(&mut self) -> io::Result<UnixStream> {
            loop {
                let (stream, _) = self.0.accept().await?;
                match stream.peer_cred() {
                    Ok(cred) if cred.uid() == uid() => return Ok(stream),
                    _ => tracing::warn!("rejected arc-ptyhost connection from another user"),
                }
            }
        }
    }

    pub async fn connect(name: &str) -> io::Result<UnixStream> {
        private_dir(name)?;
        UnixStream::connect(name).await
    }
}
