//! `arc-ptyhost` — the detached session host behind "Keep terminals running
//! after ARC closes". Lives in the app crate so Tauri bundles it next to the
//! main executable; all of the logic is in `rust/ptyhost`.

fn main() {
    arc_ptyhost::host::main();
}
