//! Whether the app is in the middle of changing the machine, and what closing
//! the window or choosing Quit does while it is.
//!
//! Closing the last window or choosing Quit in the tray used to exit at once,
//! and the shell plugin killed a running `tacho` with it: an `enroll` stopped
//! between writing one agent's hooks and the next, an `unenroll` between the
//! hooks and the service (audit D-11). Now a close or a Quit while work runs
//! hides the window instead, and the app exits once the work ends. A second
//! Quit while that exit waits goes through at once, so a hung sidecar never
//! leaves an app that only Force Quit can stop.
//!
//! The paths that reach this guard: the window's close button, the tray's
//! Quit, and on macOS the app menu's Quit and Cmd+Q (see `lib::macos_menu`).
//! The Dock's Quit and a logout on macOS do not: they send `terminate:`,
//! which tao turns into an exit with no request first.
//!
//! Work in progress is either kind:
//! - a sidecar command that changes the machine, which `sidecar::run_sidecar`
//!   counts until it exits (a read such as `tacho status` does not count),
//!   and a Rust command that writes to the machine (`Job`);
//! - the page's own busy state, which `set_busy` reports. It covers the gap
//!   between two steps of one action, such as `tacho unenroll` and the removal
//!   of the app's own files after it, and an update being installed.

use std::sync::Mutex;
use tauri::Manager;

/// What a close or a Quit does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitDecision {
    /// Nothing is running: close or exit now.
    Now,
    /// Work is running: hide the window and exit once it ends.
    WhenIdle,
}

/// The state behind the decision. Pure, so every transition is a test.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct State {
    jobs: usize,
    page_busy: bool,
    exit_when_idle: bool,
}

impl State {
    pub fn busy(&self) -> bool {
        self.jobs > 0 || self.page_busy
    }

    /// A close or a Quit. While busy, the first one waits for the work to
    /// end. A second one while it waits exits now: the person asked twice,
    /// and a sidecar that never ends, or a page that died while busy, must
    /// not keep the app running with no window.
    pub fn request_exit(&mut self) -> ExitDecision {
        if !self.busy() || self.exit_when_idle {
            ExitDecision::Now
        } else {
            self.exit_when_idle = true;
            ExitDecision::WhenIdle
        }
    }

    pub fn begin(&mut self) {
        self.jobs += 1;
    }

    /// A job ended. True when that makes the app idle with an exit waiting.
    pub fn end(&mut self) -> bool {
        self.jobs = self.jobs.saturating_sub(1);
        self.exit_due()
    }

    /// The page's busy state changed. True when it leaves an exit due.
    pub fn set_page_busy(&mut self, busy: bool) -> bool {
        self.page_busy = busy;
        self.exit_due()
    }

    /// The window was shown again: the person is back, so a waiting exit is
    /// called off.
    pub fn cancel_exit(&mut self) {
        self.exit_when_idle = false;
    }

    fn exit_due(&self) -> bool {
        self.exit_when_idle && !self.busy()
    }
}

/// The managed state, shared by the commands and the event handlers.
#[derive(Default)]
pub struct Activity(Mutex<State>);

impl Activity {
    fn with<T>(&self, change: impl FnOnce(&mut State) -> T) -> T {
        change(&mut self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }

    pub fn request_exit(&self) -> ExitDecision {
        self.with(State::request_exit)
    }

    pub fn begin(&self) {
        self.with(State::begin);
    }

    pub fn cancel_exit(&self) {
        self.with(State::cancel_exit);
    }
}

/// End one job, and exit when that was the last thing a close waited for.
pub fn end_job<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(activity) = app.try_state::<Activity>() {
        if activity.with(State::end) {
            app.exit(0);
        }
    }
}

/// A Rust command's write to the machine, counted for as long as it lives.
pub struct Job<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> Job<R> {
    pub fn start(app: &tauri::AppHandle<R>) -> Self {
        if let Some(activity) = app.try_state::<Activity>() {
            activity.begin();
        }
        Self { app: app.clone() }
    }
}

impl<R: tauri::Runtime> Drop for Job<R> {
    fn drop(&mut self) {
        end_job(&self.app);
    }
}

/// The page reports its busy state: true while an action runs, false when it
/// ends.
#[tauri::command]
pub fn set_busy(app: tauri::AppHandle, activity: tauri::State<Activity>, busy: bool) {
    if activity.with(|state| state.set_page_busy(busy)) {
        app.exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_running_closes_at_once() {
        let mut state = State::default();
        assert_eq!(state.request_exit(), ExitDecision::Now);
    }

    #[test]
    fn a_running_sidecar_holds_the_exit_until_it_ends() {
        let mut state = State::default();
        state.begin();
        assert_eq!(state.request_exit(), ExitDecision::WhenIdle);
        // A second job starts and the first ends: still not idle.
        state.begin();
        assert!(!state.end());
        assert!(state.end(), "the last job's end is the exit");
        assert_eq!(state.request_exit(), ExitDecision::Now);
    }

    #[test]
    fn the_page_busy_between_two_steps_holds_the_exit() {
        let mut state = State::default();
        assert!(!state.set_page_busy(true));
        assert_eq!(state.request_exit(), ExitDecision::WhenIdle);
        // `tacho unenroll` runs and ends inside the action.
        state.begin();
        assert!(!state.end(), "the page is still busy");
        assert!(state.set_page_busy(false));
    }

    #[test]
    fn no_exit_is_due_unless_one_was_asked_for() {
        let mut state = State::default();
        state.begin();
        assert!(!state.end());
        assert!(!state.set_page_busy(true));
        assert!(!state.set_page_busy(false));
    }

    #[test]
    fn showing_the_window_again_calls_off_a_waiting_exit() {
        let mut state = State::default();
        state.begin();
        assert_eq!(state.request_exit(), ExitDecision::WhenIdle);
        state.cancel_exit();
        assert!(!state.end());
    }

    /// The review of D-11: a Quit during a hung `enroll` hid the window, and
    /// every later Quit hid it again, so only Force Quit stopped the app.
    #[test]
    fn a_second_quit_while_the_first_waits_exits_now() {
        let mut state = State::default();
        state.begin();
        assert_eq!(state.request_exit(), ExitDecision::WhenIdle);
        assert_eq!(state.request_exit(), ExitDecision::Now);
        // The same when the page's busy state is what holds it.
        let mut state = State::default();
        state.set_page_busy(true);
        assert_eq!(state.request_exit(), ExitDecision::WhenIdle);
        assert_eq!(state.request_exit(), ExitDecision::Now);
    }

    #[test]
    fn showing_the_window_makes_the_next_quit_a_first_one_again() {
        let mut state = State::default();
        state.begin();
        assert_eq!(state.request_exit(), ExitDecision::WhenIdle);
        state.cancel_exit();
        assert_eq!(state.request_exit(), ExitDecision::WhenIdle);
    }

    #[test]
    fn an_end_without_a_start_never_underflows() {
        let mut state = State::default();
        assert!(!state.end());
        assert!(!state.busy());
    }
}
