//! The Dock's Quit, a logout, and a quit Apple event, held by the close guard
//! like every other Quit (#4367).
//!
//! All three send `terminate:` from outside the app's own menu. AppKit asks
//! the app delegate `applicationShouldTerminate:` first, but tao 0.35 gives
//! its delegate class only `applicationWillTerminate:`. So AppKit asked
//! nobody, and the app went straight to `RunEvent::Exit`, which no handler can
//! prevent. A running `tacho enroll` or `unenroll` stopped between two writes.
//! `install` adds the missing method to tao's delegate class, and
//! `activity::State::should_terminate` decides each answer:
//!
//! - Nothing runs: `NSTerminateNow`, the exit the app had before.
//! - Work runs: the window hides and the answer is `NSTerminateLater`. AppKit
//!   then runs the main run loop in its modal panel mode until
//!   `replyToApplicationShouldTerminate:` arrives. The app answers yes when the
//!   work ends, no when the person opens the window again, and yes once
//!   `HOLD_LIMIT` passes, so a hung sidecar cannot hold a logout.
//! - A second Quit while one waits: `NSTerminateNow`, or a yes to the held
//!   one when the second Quit comes from the tray or the app menu.
//!
//! `answer` sends every reply through the main dispatch queue. AppKit drains
//! that queue in the modal panel mode, and a block on it never runs inside
//! tao's event handler. That matters for a yes: it leads to
//! `applicationWillTerminate:`, which enters tao's handler, and the handler
//! holds a lock while it runs, so entering it again from inside would
//! deadlock.

use crate::activity::{Activity, TerminateReply};
use dispatch2::DispatchQueue;
use objc2::encode::Encode;
use objc2::ffi::class_addMethod;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
use std::ffi::{CStr, CString};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// The class tao 0.35 registers for its app delegate
/// (`platform_impl/macos/app_delegate.rs`). `EventLoop::new` creates the one
/// instance and makes it the app's delegate, so the class exists once
/// `tauri::Builder::build` returns.
const TAO_DELEGATE_CLASS: &CStr = c"TaoAppDelegateParent";

/// How long a held `terminate:` waits for the work to end before the app
/// answers yes anyway. This is the app's own choice, not a limit macOS
/// publishes for a logout.
const HOLD_LIMIT: Duration = Duration::from_secs(20);

/// The app the delegate method reads the close guard from. The method is a
/// plain function the Objective-C runtime calls, so it has no other way to
/// reach it.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// `applicationShouldTerminate:` as the runtime calls it: the receiver, the
/// selector, and the sender.
type ShouldTerminate = extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> NSApplicationTerminateReply;

/// Give tao's app delegate `applicationShouldTerminate:`. Call it after
/// `tauri::Builder::build` and before `App::run`, on the main thread.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(class) = AnyClass::get(TAO_DELEGATE_CLASS) else {
        eprintln!("oxagen: no {TAO_DELEGATE_CLASS:?} class, so a Dock Quit does not wait for running work");
        return;
    };
    if !add_should_terminate(class) {
        eprintln!("oxagen: {TAO_DELEGATE_CLASS:?} already answers applicationShouldTerminate:, so it was left as is");
        return;
    }
    // AppKit may note which optional methods a delegate has when the delegate
    // is set. Setting it again makes it see the one just added. tao keeps its
    // own reference to the delegate, so it lives while it is unset.
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let ns_app = NSApplication::sharedApplication(mtm);
    let delegate = ns_app.delegate();
    ns_app.setDelegate(None);
    ns_app.setDelegate(delegate.as_deref());
}

/// Add the method to `class`. False when the class already has its own
/// `applicationShouldTerminate:`, which `class_addMethod` leaves in place.
fn add_should_terminate(class: &AnyClass) -> bool {
    // The same type string `objc2::runtime::ClassBuilder` builds: the return
    // type, the receiver, the selector, then the sender.
    let types = format!(
        "{}{}{}{}",
        NSApplicationTerminateReply::ENCODING,
        <*mut AnyObject>::ENCODING,
        Sel::ENCODING,
        <*mut AnyObject>::ENCODING,
    );
    let Ok(types) = CString::new(types) else {
        return false;
    };
    // SAFETY: `application_should_terminate` takes the receiver, the
    // selector, and one object, and returns an `NSUInteger`, which is what
    // `types` declares and what AppKit passes. `Imp` is the untyped function
    // pointer the runtime stores. The runtime copies `types`, so it may drop
    // after the call, as `ClassBuilder::add_method` also lets it.
    unsafe {
        let imp = std::mem::transmute::<ShouldTerminate, Imp>(application_should_terminate);
        class_addMethod(
            std::ptr::from_ref(class).cast_mut(),
            sel!(applicationShouldTerminate:),
            imp,
            types.as_ptr(),
        )
        .as_bool()
    }
}

/// `applicationShouldTerminate:`. AppKit calls it on the main thread, from its
/// own handling of `terminate:` and not from inside tao's event handler.
extern "C-unwind" fn application_should_terminate(
    _this: *mut AnyObject,
    _cmd: Sel,
    _sender: *mut AnyObject,
) -> NSApplicationTerminateReply {
    // Before `install` stores the app there is no work to wait for.
    let Some(app) = APP.get() else {
        return NSApplicationTerminateReply::TerminateNow;
    };
    let Some(activity) = app.try_state::<Activity>() else {
        return NSApplicationTerminateReply::TerminateNow;
    };
    match activity.should_terminate() {
        TerminateReply::Now => NSApplicationTerminateReply::TerminateNow,
        TerminateReply::Later(hold) => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
            limit(hold);
            NSApplicationTerminateReply::TerminateLater
        }
    }
}

/// Answer hold `hold` yes once `HOLD_LIMIT` passes, if nothing answered it
/// first.
fn limit(hold: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(HOLD_LIMIT);
        let expired = APP
            .get()
            .and_then(|app| app.try_state::<Activity>())
            .is_some_and(|activity| activity.hold_expired(hold));
        if expired {
            answer(true);
        }
    });
}

/// Answer the held `terminate:`: yes to quit, no to stay open. Safe from any
/// thread, and from inside tao's event handler.
pub fn answer(proceed: bool) {
    DispatchQueue::main().exec_async(move || {
        // The main queue runs its blocks on the main thread.
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(proceed);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::ClassBuilder;

    /// The unit tests build no event loop, so tao's class does not exist. A
    /// class of the test's own takes its place. The call goes through
    /// `msg_send!`, which in a debug build checks the arguments and the return
    /// type against the type string the method was added with.
    #[test]
    fn the_added_method_answers_now_before_the_app_is_installed() {
        let superclass = AnyClass::get(c"NSObject").expect("NSObject");
        let class = ClassBuilder::new(c"OxagenQuitTestDelegate", superclass)
            .expect("a fresh class name")
            .register();
        assert!(add_should_terminate(class));
        assert!(class.responds_to(sel!(applicationShouldTerminate:)));
        assert!(!add_should_terminate(class), "a second add leaves the first in place");

        let delegate: Retained<AnyObject> = unsafe { msg_send![class, new] };
        let sender: *mut AnyObject = std::ptr::null_mut();
        let reply: NSApplicationTerminateReply = unsafe { msg_send![&*delegate, applicationShouldTerminate: sender] };
        assert_eq!(reply, NSApplicationTerminateReply::TerminateNow);
    }
}
