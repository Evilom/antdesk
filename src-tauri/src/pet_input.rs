/// Native dragging can consume the WebView's mouseup event. Read only the left
/// button while a pet drag is active, so movement never resumes under the cursor.
#[tauri::command]
pub fn pet_primary_button_down(window: tauri::Window) -> Result<bool, String> {
    if window.label() != "pet" { return Err("Pet window only".into()); }
    primary_button_down()
}

#[cfg(target_os = "macos")]
fn primary_button_down() -> Result<bool, String> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" { fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool; }
    // Combined session state; this does not record events or request Input Monitoring.
    Ok(unsafe { CGEventSourceButtonState(0, 0) })
}

#[cfg(target_os = "windows")]
fn primary_button_down() -> Result<bool, String> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    Ok(unsafe { GetAsyncKeyState(VK_LBUTTON as i32) < 0 })
}

#[cfg(target_os = "linux")]
fn primary_button_down() -> Result<bool, String> {
    use x11rb::{connection::Connection, protocol::xproto::{ConnectionExt, KeyButMask}};
    let (connection, screen) = x11rb::connect(None).map_err(|e| e.to_string())?;
    let reply = connection.query_pointer(connection.setup().roots[screen].root)
        .map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?;
    Ok(u16::from(reply.mask) & u16::from(KeyButMask::BUTTON1) != 0)
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn primary_button_down() -> Result<bool, String> { Err("Native drag unavailable".into()) }
