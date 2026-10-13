use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;
use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
mod macos;

pub fn install_native_quit_shortcut(
    app: &tauri::AppHandle,
) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    macos::install(app)?;
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

pub fn remove_native_quit_shortcut() {
    #[cfg(target_os = "macos")]
    macos::remove();
}

const RUNNING: u8 = 0;
const SAVING: u8 = 1;
const EXITING: u8 = 2;
const SAVE_DEADLINE: Duration = Duration::from_millis(2500);

#[derive(Default)]
pub struct ShutdownState(AtomicU8);

impl ShutdownState {
    fn begin(&self) -> bool {
        self.0
            .compare_exchange(RUNNING, SAVING, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    fn finish(&self) -> bool {
        self.0.swap(EXITING, Ordering::AcqRel) != EXITING
    }
}

/// Saving is best effort: a dead WebContent process cannot prevent native quit.
pub fn request(app: &tauri::AppHandle) {
    if !app.state::<ShutdownState>().begin() {
        return;
    }

    // Start the native deadline before asking JavaScript to save. Its timers and
    // IPC acknowledgements may never run after a WebKit process termination.
    let deadline_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SAVE_DEADLINE);
        finish(&deadline_app);
    });

    if let Some(window) = app.get_webview_window("main") {
        if window.emit("app-quit-requested", ()).is_err() {
            finish(app);
        }
    } else {
        finish(app);
    }
}

pub fn finish(app: &tauri::AppHandle) {
    if app.state::<ShutdownState>().finish() {
        app.exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn repeated_close_requests_do_not_restart_the_deadline() {
        let state = ShutdownState::default();
        assert!(state.begin());
        assert!(!state.begin());
        assert!(state.finish());
        assert!(!state.begin());
        assert!(!state.finish());
    }

    #[test]
    fn acknowledgement_and_native_deadline_exit_only_once() {
        let state = Arc::new(ShutdownState::default());
        assert!(state.begin());
        let barrier = Arc::new(Barrier::new(3));
        let attempts: Vec<_> = (0..2)
            .map(|_| {
                let state = state.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    state.finish()
                })
            })
            .collect();
        barrier.wait();
        let exits = attempts
            .into_iter()
            .filter_map(|t| t.join().ok())
            .filter(|v| *v)
            .count();
        assert_eq!(exits, 1);
    }

    #[test]
    fn native_deadline_can_finish_without_renderer_acknowledgement() {
        let state = ShutdownState::default();
        assert!(state.begin());
        assert!(state.finish());
        assert!(!state.finish());
    }
}
