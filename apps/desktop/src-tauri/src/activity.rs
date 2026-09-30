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
//! On macOS the Dock's Quit, a logout, and a quit Apple event reach it too,
//! through `macos_quit`: they send `terminate:`, which AppKit holds until the
//! app answers it. `State::should_terminate` decides that answer, and a close
//! that was waiting ends by answering it rather than by `app.exit`, which
//! cannot end AppKit's wait.
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

#[cfg(target_os = "macos")]
use crate::macos_quit::answer as answer_terminate;

/// What a close or a Quit does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitDecision {
    /// Nothing is running: close or exit now.
    Now,
    /// Work is running: hide the window and exit once it ends.
    WhenIdle,
}

/// What the app answers a macOS `terminate:` (`applicationShouldTerminate:`).
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminateReply {
    /// `NSTerminateNow`: nothing is running, or this is the second Quit.
    Now,
    /// `NSTerminateLater`: hide the window and answer once the work ends. The
    /// number names this hold, so the time limit on it cannot answer a later
    /// one (see `State::hold_expired`).
    Later(u64),
}

/// The state behind the decision. Pure, so every transition is a test.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct State {
    jobs: usize,
    page_busy: bool,
    exit_when_idle: bool,
    /// The macOS `terminate:` this app answered "later", while it waits.
    held: Option<u64>,
    /// How many `terminate:` calls were held, which numbers the next one.
    #[cfg(any(target_os = "macos", test))]
    holds: u64,
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
    /// called off. True when a held `terminate:` must now be answered no.
    pub fn cancel_exit(&mut self) -> bool {
        self.exit_when_idle = false;
        self.take_held()
    }

    /// A `terminate:` on macOS: the Dock's Quit, a logout, or a quit Apple
    /// event. The same decision as any other Quit. While work runs, AppKit
    /// waits for an answer, which `take_held` hands to whoever ends the wait.
    #[cfg(any(target_os = "macos", test))]
    pub fn should_terminate(&mut self) -> TerminateReply {
        match self.request_exit() {
            ExitDecision::Now => TerminateReply::Now,
            ExitDecision::WhenIdle => {
                self.holds += 1;
                self.held = Some(self.holds);
                TerminateReply::Later(self.holds)
            }
        }
    }

    /// The time limit on hold `hold` ran out. True when that hold still waits,
    /// so the app answers yes whatever state the work is in.
    #[cfg(any(target_os = "macos", test))]
    pub fn hold_expired(&mut self, hold: u64) -> bool {
        if self.held == Some(hold) {
            self.held = None;
            true
        } else {
            false
        }
    }

    /// Hand over the held `terminate:`, if one waits: true once per hold.
    fn take_held(&mut self) -> bool {
        self.held.take().is_some()
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

    /// A close or a Quit. A second Quit while a `terminate:` is held also
    /// answers that `terminate:` yes, because the exit it asks for cannot end
    /// AppKit's wait.
    pub fn request_exit(&self) -> ExitDecision {
        let (decision, held) = self.with(|state| {
            let decision = state.request_exit();
            (decision, decision == ExitDecision::Now && state.take_held())
        });
        if held {
            answer_terminate(true);
        }
        decision
    }

    pub fn begin(&self) {
        self.with(State::begin);
    }

    /// The person opened the window again. A held `terminate:` is answered
    /// no, so a Dock Quit or a logout they came back from does not go ahead.
    pub fn cancel_exit(&self) {
        if self.with(State::cancel_exit) {
            answer_terminate(false);
        }
    }

    #[cfg(target_os = "macos")]
    pub fn should_terminate(&self) -> TerminateReply {
        self.with(State::should_terminate)
    }

    #[cfg(target_os = "macos")]
    pub fn hold_expired(&self, hold: u64) -> bool {
        self.with(|state| state.hold_expired(hold))
    }
}

/// Only macOS holds a `terminate:` (see `macos_quit`), so on Linux and
/// Windows there is never one to answer.
#[cfg(not(target_os = "macos"))]
fn answer_terminate(_proceed: bool) {}

/// Exit now that the work a close waited for has ended: answer the held
/// `terminate:` yes when there is one, and otherwise ask Tauri to exit.
fn leave<R: tauri::Runtime>(app: &tauri::AppHandle<R>, held_terminate: bool) {
    if held_terminate {
        answer_terminate(true);
    } else {
        app.exit(0);
    }
}

/// End one job, and exit when that was the last thing a close waited for.
pub fn end_job<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(activity) = app.try_state::<Activity>() {
        if let Some(held) = activity.with(|state| state.end().then(|| state.take_held())) {
            leave(app, held);
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
    if let Some(held) = activity.with(|state| state.set_page_busy(busy).then(|| state.take_held())) {
        leave(&app, held);
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

    #[test]
    fn a_terminate_with_nothing_running_goes_ahead() {
        let mut state = State::default();
        assert_eq!(state.should_terminate(), TerminateReply::Now);
        assert!(!state.take_held(), "nothing waits for an answer");
    }

    /// #4367: a Dock Quit during `tacho enroll` ended the app between two
    /// writes. Now it waits, and the job's end is what answers it.
    #[test]
    fn a_terminate_while_a_sidecar_runs_waits_for_it_to_end() {
        let mut state = State::default();
        state.begin();
        assert_eq!(state.should_terminate(), TerminateReply::Later(1));
        assert!(state.end(), "the job's end is the exit");
        assert!(state.take_held(), "and it answers the held terminate");
        assert!(!state.take_held(), "once");
    }

    #[test]
    fn a_terminate_while_the_page_is_busy_waits_for_both_steps() {
        let mut state = State::default();
        state.set_page_busy(true);
        assert_eq!(state.should_terminate(), TerminateReply::Later(1));
        // `tacho unenroll` ends, and the removal of the app's files follows.
        state.begin();
        assert!(!state.end(), "the page is still busy");
        assert!(state.set_page_busy(false));
        assert!(state.take_held());
    }

    #[test]
    fn a_second_quit_while_a_terminate_waits_goes_ahead_now() {
        // A second Dock Quit, if AppKit asks again while it waits.
        let mut state = State::default();
        state.begin();
        assert_eq!(state.should_terminate(), TerminateReply::Later(1));
        assert_eq!(state.should_terminate(), TerminateReply::Now);
        // The tray's Quit or Cmd+Q: an exit now, and the held terminate is
        // handed over to be answered yes (`Activity::request_exit`).
        let mut state = State::default();
        state.begin();
        assert_eq!(state.should_terminate(), TerminateReply::Later(1));
        assert_eq!(state.request_exit(), ExitDecision::Now);
        assert!(state.take_held());
    }

    #[test]
    fn a_terminate_after_a_waiting_tray_quit_goes_ahead_now() {
        let mut state = State::default();
        state.begin();
        assert_eq!(state.request_exit(), ExitDecision::WhenIdle);
        assert_eq!(state.should_terminate(), TerminateReply::Now);
    }

    #[test]
    fn a_waiting_tray_quit_ends_in_an_exit_with_nothing_to_answer() {
        let mut state = State::default();
        state.begin();
        assert_eq!(state.request_exit(), ExitDecision::WhenIdle);
        assert!(state.end());
        assert!(!state.take_held(), "no terminate waits, so the app exits");
    }

    #[test]
    fn opening_the_window_answers_a_held_terminate_no() {
        let mut state = State::default();
        state.begin();
        assert_eq!(state.should_terminate(), TerminateReply::Later(1));
        assert!(state.cancel_exit(), "the held terminate is answered no");
        assert!(!state.end(), "and the work's end no longer exits");
        assert!(!state.cancel_exit(), "nothing is held now");
    }

    #[test]
    fn the_time_limit_answers_a_hold_that_still_waits() {
        let mut state = State::default();
        state.begin();
        assert_eq!(state.should_terminate(), TerminateReply::Later(1));
        assert!(state.hold_expired(1), "a hung job does not hold a logout");
        assert!(!state.hold_expired(1));
        // The job ends after the answer went out: no second answer.
        assert!(state.end());
        assert!(!state.take_held());
    }

    #[test]
    fn a_time_limit_never_answers_a_later_hold() {
        let mut state = State::default();
        state.begin();
        assert_eq!(state.should_terminate(), TerminateReply::Later(1));
        assert!(state.cancel_exit());
        assert_eq!(state.should_terminate(), TerminateReply::Later(2));
        assert!(!state.hold_expired(1), "the first hold's limit is stale");
        assert!(state.hold_expired(2));
    }

    #[test]
    fn a_time_limit_after_the_work_ended_answers_nothing() {
        let mut state = State::default();
        state.begin();
        assert_eq!(state.should_terminate(), TerminateReply::Later(1));
        assert!(state.end());
        assert!(state.take_held());
        assert!(!state.hold_expired(1));
    }
}
