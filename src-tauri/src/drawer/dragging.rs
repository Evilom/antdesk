//! Native window movement is initiated once, then the OS owns the drag. Only
//! the final placement is persisted; programmatic moves never trigger docking.
use super::{apply_layout, apply_layout_at, snapshot, DrawerController, DrawerState, Preferences, Screen};
use super::geometry::{anchor_for_drop, nearest_edge, nearest_screen, Bounds};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[cfg(target_os = "windows")]
fn left_button_down() -> Option<bool> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    // SAFETY: this Win32 query has no pointer arguments or mutable process state.
    Some(unsafe { GetAsyncKeyState(i32::from(VK_LBUTTON)) < 0 })
}

#[cfg(target_os = "macos")]
fn left_button_down() -> Option<bool> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" { fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool; }
    // Combined-session state and the left mouse button are both enum value 0.
    // SAFETY: this CoreGraphics function returns a value and borrows no pointers.
    Some(unsafe { CGEventSourceButtonState(0, 0) })
}

#[cfg(target_os = "linux")]
fn left_button_down() -> Option<bool> {
    use x11rb::{connection::Connection, protocol::xproto::{ConnectionExt, KeyButMask}};
    let (connection, screen) = x11rb::connect(None).ok()?;
    let root = connection.setup().roots.get(screen)?.root;
    let reply = connection.query_pointer(root).ok()?.reply().ok()?;
    Some(reply.mask.contains(KeyButMask::BUTTON1))
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn left_button_down() -> Option<bool> { None }

async fn wait_for_release(window: &WebviewWindow) -> Result<(), String> {
    let started = Instant::now();
    let mut changed_at = started;
    let mut previous_position = None;
    loop {
        tokio::time::sleep(Duration::from_millis(40)).await;
        match left_button_down() {
            Some(false) if started.elapsed() >= Duration::from_millis(80) => return Ok(()),
            Some(_) => {},
            None => {
                // X11-less Linux compositors may not expose global button
                // state. Use settled native bounds as a conservative fallback.
                // Windows/macOS always use the actual button release above.
                let position = window.outer_position().map_err(|error| error.to_string())?;
                if previous_position != Some(position) {
                    previous_position = Some(position);
                    changed_at = Instant::now();
                }
                if changed_at.elapsed() >= Duration::from_millis(700) { return Ok(()); }
            }
        }
        // A lost button-up after a session switch must not pin the UI forever.
        if started.elapsed() >= Duration::from_secs(120) {
            return Err("Window drag did not receive a release event".into());
        }
    }
}

fn clear_drag(app: &AppHandle) -> Result<(), String> {
    let controller = app.state::<DrawerController>();
    let mut runtime = controller.runtime.lock().map_err(|_| "Drawer state is unavailable")?;
    runtime.dragging = false;
    Ok(())
}

pub(super) async fn start(app: &AppHandle) -> Result<DrawerState, String> {
    let window = app.get_webview_window("main").ok_or("Planner window is unavailable")?;
    let original_position;
    {
        let controller = app.state::<DrawerController>();
        let _transition = controller.transition.lock().await;
        let previous = snapshot(app)?;
        if previous.dragging { return Err("The drawer is already being moved".into()); }
        original_position = window.outer_position().map_err(|error| error.to_string())?;
        controller.runtime.lock().map_err(|_| "Drawer state is unavailable")?.dragging = true;
    }
    let _ = window.emit("drawer:drag-changed", true);
    // Tauri dispatches this call to its native event loop. No runtime mutex or
    // transition gate is held while the OS enters its modal move operation.
    let moved = match window.start_dragging() {
        Ok(()) => wait_for_release(&window).await,
        Err(error) => Err(error.to_string()),
    };

    let controller = app.state::<DrawerController>();
    let _transition = controller.transition.lock().await;
    clear_drag(app)?;
    let result = (|| {
        moved?;
        let previous = snapshot(app)?;
        let position = window.outer_position().map_err(|error| error.to_string())?;
        if position == original_position {
            // A click or Escape-cancelled native drag must not relocate the
            // drawer to a different edge merely because its tab is near a corner.
            return apply_layout(app, None, None, false, false);
        }
        let size = window.inner_size().map_err(|error| error.to_string())?;
        let point = window.cursor_position().map_err(|error| error.to_string())?;
        let point = (point.x, point.y);
        let monitors = window.available_monitors().map_err(|error| error.to_string())?;
        let screens: Vec<Screen> = monitors.iter().map(Screen::from).collect();
        let index = nearest_screen(&screens, point).ok_or("No display is available for the drawer")?;
        let screen = &screens[index];
        let edge = nearest_edge(screen, point, previous.state.edge);
        let state = DrawerState { mode: previous.state.mode, edge };
        let anchor = anchor_for_drop(screen, state, previous.item_count, Bounds {
            x: position.x, y: position.y, width: size.width, height: size.height,
        });
        let target = Preferences { edge, monitor: Some(screen.identity.clone()), anchor: Some(anchor) };
        apply_layout_at(app, None, Some(edge), false, true, Some(target))
    })();
    let _ = window.emit("drawer:drag-changed", false);
    // If an OS query failed after the move, recover the last known placement
    // while preserving the original error for the frontend to report.
    if result.is_err() { let _ = apply_layout(app, None, None, false, true); }
    result
}
