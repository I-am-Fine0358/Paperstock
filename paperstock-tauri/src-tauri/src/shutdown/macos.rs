use std::cell::RefCell;
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};

thread_local! {
    // AppKit monitors and their callbacks are installed/removed on the main
    // thread. Keeping the token here avoids claiming Objective-C objects Send.
    static QUIT_MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}

fn is_quit_shortcut(flags: NSEventModifierFlags, characters: Option<&str>) -> bool {
    let shortcut_modifiers = NSEventModifierFlags::Command
        | NSEventModifierFlags::Control
        | NSEventModifierFlags::Option
        | NSEventModifierFlags::Shift;
    flags.intersection(shortcut_modifiers) == NSEventModifierFlags::Command
        && characters.is_some_and(|s| s.eq_ignore_ascii_case("q"))
}

pub fn install(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let _main_thread = MainThreadMarker::new().ok_or_else(|| {
        std::io::Error::other("Quit shortcut must be installed on the main thread")
    })?;
    QUIT_MONITOR.with(|monitor| {
        if monitor.borrow().is_some() {
            return Ok(());
        }
        let app = app.clone();
        let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit supplies a live NSEvent for the duration of this
            // synchronous callback, always on the main thread.
            let native_event = unsafe { event.as_ref() };
            let characters = native_event
                .charactersIgnoringModifiers()
                .map(|s| s.to_string());
            if is_quit_shortcut(native_event.modifierFlags(), characters.as_deref()) {
                // A stopped WebContent process can swallow menu equivalents.
                // Start the Rust deadline before dispatch reaches WKWebView.
                super::request(&app);
                std::ptr::null_mut()
            } else {
                event.as_ptr()
            }
        });
        // SAFETY: the handler returns either AppKit's original event pointer
        // or nil; AppKit copies the block and keeps it alive with the monitor.
        // This is an app-local monitor, never a system-wide key event hook.
        let token = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler)
        }
        .ok_or_else(|| std::io::Error::other("Could not install the native quit shortcut"))?;
        *monitor.borrow_mut() = Some(token);
        Ok(())
    })
}

pub fn remove() {
    if MainThreadMarker::new().is_none() {
        return;
    }
    QUIT_MONITOR.with(|monitor| {
        if let Some(token) = monitor.borrow_mut().take() {
            // SAFETY: this is the token returned by AppKit's monitor API, and
            // removal occurs on the same main thread as installation.
            unsafe { NSEvent::removeMonitor(&token) };
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmd_q_and_caps_lock_cmd_q_are_native_quit() {
        assert!(is_quit_shortcut(NSEventModifierFlags::Command, Some("q")));
        assert!(is_quit_shortcut(
            NSEventModifierFlags::Command | NSEventModifierFlags::CapsLock,
            Some("Q")
        ));
    }

    #[test]
    fn logout_lock_screen_and_other_modified_shortcuts_pass_through() {
        for modifier in [
            NSEventModifierFlags::Shift,
            NSEventModifierFlags::Control,
            NSEventModifierFlags::Option,
        ] {
            assert!(!is_quit_shortcut(
                NSEventModifierFlags::Command | modifier,
                Some("q")
            ));
        }
    }

    #[test]
    fn plain_text_and_other_command_keys_pass_through() {
        assert!(!is_quit_shortcut(NSEventModifierFlags::empty(), Some("q")));
        assert!(!is_quit_shortcut(NSEventModifierFlags::Command, Some("w")));
        assert!(!is_quit_shortcut(NSEventModifierFlags::Command, None));
    }
}
