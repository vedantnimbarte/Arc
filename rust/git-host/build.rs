//! Exists for one line.
//!
//! `DEVICE_CLIENT_ID` reads `ARC_GITHUB_CLIENT_ID` through `option_env!`, which
//! is resolved at compile time. Cargo has no way to know that, so without this
//! it will happily serve a cached build after the variable changes — the new id
//! is silently ignored and sign-in keeps using whatever was baked in first.
//! That failure is invisible and costs an afternoon; this file is four lines.

fn main() {
    println!("cargo:rerun-if-env-changed=ARC_GITHUB_CLIENT_ID");
}
