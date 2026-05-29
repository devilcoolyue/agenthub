//! Platform-specific implementations behind a uniform interface.
//!
//! Today this isolates the terminal launch differences between macOS and
//! Windows so the command layer (`commands::terminal`) stays free of
//! `#[cfg(target_os = ...)]` branches. Path resolution still lives with its
//! callers; only the "open a terminal and run a command" surface moved here.

pub mod terminal;
