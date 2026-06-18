use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopSurfaceKind {
    ExternalWindow,
    AntdeskWindow,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSurface {
    pub id: String,
    pub app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub kind: DesktopSurfaceKind,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub focused: bool,
    pub z_index: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopSurfaceCapability {
    Full,
    Degraded,
    None,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSurfaceResponse {
    pub surfaces: Vec<DesktopSurface>,
    pub sampled_at_ms: u128,
    pub capability: DesktopSurfaceCapability,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Rect {
    fn scaled(self, scale: f64) -> Self {
        let scale = if scale > 0.0 { scale } else { 1.0 };
        Self {
            x: self.x / scale,
            y: self.y / scale,
            width: self.width / scale,
            height: self.height / scale,
        }
    }
}

pub fn collect(app: &tauri::AppHandle) -> DesktopSurfaceResponse {
    let scale = app
        .get_webview_window("pet")
        .and_then(|w| w.current_monitor().ok().flatten())
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);

    let mut own = collect_antdesk_surfaces(app, scale);
    let mut response = platform_surfaces(scale);
    response.surfaces.retain(|s| is_surface_usable(s));
    response.surfaces.append(&mut own);
    response.surfaces.truncate(24);
    response.sampled_at_ms = now_ms();
    response
}

pub fn legacy_visible_windows(app: &tauri::AppHandle) -> serde_json::Value {
    let response = collect(app);
    let windows: Vec<serde_json::Value> = response
        .surfaces
        .into_iter()
        .filter(|s| s.kind == DesktopSurfaceKind::ExternalWindow)
        .map(|s| {
            serde_json::json!({
                "name": s.app,
                "x": s.x,
                "y": s.y,
                "width": s.width,
                "height": s.height,
            })
        })
        .collect();
    serde_json::json!(windows)
}

fn collect_antdesk_surfaces(app: &tauri::AppHandle, scale: f64) -> Vec<DesktopSurface> {
    ["main", "quick", "notepad", "fab-menu"]
        .iter()
        .enumerate()
        .filter_map(|(idx, label)| {
            let window = app.get_webview_window(label)?;
            if !window.is_visible().unwrap_or(false) {
                return None;
            }
            let pos = window.outer_position().ok()?;
            let size = window.outer_size().ok()?;
            let rect = Rect {
                x: pos.x as f64,
                y: pos.y as f64,
                width: size.width as f64,
                height: size.height as f64,
            }
            .scaled(scale);
            Some(DesktopSurface {
                id: format!("antdesk:{}", label),
                app: "AntDesk".to_string(),
                title: Some((*label).to_string()),
                kind: DesktopSurfaceKind::AntdeskWindow,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                focused: window.is_focused().unwrap_or(false),
                z_index: 10_000 + idx as i32,
            })
        })
        .filter(is_surface_usable)
        .collect()
}

fn platform_surfaces(_scale: f64) -> DesktopSurfaceResponse {
    #[cfg(target_os = "macos")]
    {
        // CGWindow bounds match the desktop coordinate space that the existing
        // pet physics consumed from the previous Quartz/Python bridge.
        return macos::collect(1.0);
    }
    #[cfg(target_os = "windows")]
    {
        return windows_backend::collect(_scale);
    }
    #[cfg(target_os = "linux")]
    {
        return linux::collect(_scale);
    }
    #[allow(unreachable_code)]
    DesktopSurfaceResponse {
        surfaces: vec![],
        sampled_at_ms: now_ms(),
        capability: DesktopSurfaceCapability::None,
        reason: Some("desktop window enumeration is not supported on this platform".to_string()),
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn is_surface_usable(surface: &DesktopSurface) -> bool {
    if surface.width < 120.0 || surface.height < 80.0 {
        return false;
    }
    if surface.width > 10_000.0 || surface.height > 10_000.0 {
        return false;
    }
    if surface.app.trim().is_empty() {
        return false;
    }
    true
}

fn is_antdesk_or_system_window(app: &str, title: Option<&str>) -> bool {
    let app_l = app.to_ascii_lowercase();
    let title_l = title.unwrap_or("").to_ascii_lowercase();
    if app_l.contains("antdesk") || title_l.contains("antdesk") {
        return true;
    }
    matches!(
        app,
        "Dock" | "Window Server" | "SystemUIServer" | "ShellExperienceHost" | "Program Manager"
    )
}

fn make_surface(
    id: String,
    app: String,
    title: Option<String>,
    rect: Rect,
    scale: f64,
    focused: bool,
    z_index: i32,
) -> Option<DesktopSurface> {
    if is_antdesk_or_system_window(&app, title.as_deref()) {
        return None;
    }
    let rect = rect.scaled(scale);
    let surface = DesktopSurface {
        id,
        app,
        title,
        kind: DesktopSurfaceKind::ExternalWindow,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        focused,
        z_index,
    };
    is_surface_usable(&surface).then_some(surface)
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowAlpha, kCGWindowBounds, kCGWindowLayer,
        kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly, kCGWindowName,
        kCGWindowNumber, kCGWindowOwnerName,
    };

    pub fn collect(scale: f64) -> DesktopSurfaceResponse {
        let Some(array) = copy_window_info(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID,
        ) else {
            return DesktopSurfaceResponse {
                surfaces: vec![],
                sampled_at_ms: now_ms(),
                capability: DesktopSurfaceCapability::None,
                reason: Some("CGWindowListCopyWindowInfo returned no windows".to_string()),
            };
        };

        let mut surfaces = Vec::new();
        for (z, item) in array.iter().enumerate() {
            let dict: CFDictionary = unsafe {
                CFDictionary::wrap_under_get_rule(*item as CFDictionaryRef)
            };
            let layer = number(&dict, unsafe { CFString::wrap_under_get_rule(kCGWindowLayer) })
                .unwrap_or(0.0);
            let alpha = number(&dict, unsafe { CFString::wrap_under_get_rule(kCGWindowAlpha) })
                .unwrap_or(1.0);
            if layer.round() as i32 != 0 || alpha <= 0.0 {
                continue;
            }

            let app = string(&dict, unsafe { CFString::wrap_under_get_rule(kCGWindowOwnerName) })
                .unwrap_or_default();
            let title = string(&dict, unsafe { CFString::wrap_under_get_rule(kCGWindowName) });
            let id = number(&dict, unsafe { CFString::wrap_under_get_rule(kCGWindowNumber) })
                .map(|n| format!("macos:{:.0}", n))
                .unwrap_or_else(|| format!("macos:{}", z));
            let rect = rect(&dict, unsafe { CFString::wrap_under_get_rule(kCGWindowBounds) });
            let Some(rect) = rect else { continue };
            if let Some(surface) = make_surface(id, app, title, rect, scale, z == 0, z as i32) {
                surfaces.push(surface);
            }
        }

        DesktopSurfaceResponse {
            surfaces,
            sampled_at_ms: now_ms(),
            capability: DesktopSurfaceCapability::Full,
            reason: None,
        }
    }

    fn value(dict: &CFDictionary, key: CFString) -> Option<CFType> {
        let key_ref = key.as_CFTypeRef() as *const std::os::raw::c_void;
        dict.find(key_ref)
            .map(|v| unsafe { CFType::wrap_under_get_rule(*v as CFTypeRef) })
    }

    fn string(dict: &CFDictionary, key: CFString) -> Option<String> {
        value(dict, key)
            .and_then(|v| v.downcast::<CFString>())
            .map(|s| s.to_string())
            .filter(|s| !s.trim().is_empty())
    }

    fn number(dict: &CFDictionary, key: CFString) -> Option<f64> {
        value(dict, key)
            .and_then(|v| v.downcast::<CFNumber>())
            .and_then(|n| n.to_f64().or_else(|| n.to_i64().map(|v| v as f64)))
    }

    fn rect(dict: &CFDictionary, key: CFString) -> Option<Rect> {
        let bounds = value(dict, key)?.downcast::<CFDictionary>()?;
        let x = number(&bounds, CFString::new("X"))?;
        let y = number(&bounds, CFString::new("Y"))?;
        let width = number(&bounds, CFString::new("Width"))?;
        let height = number(&bounds, CFString::new("Height"))?;
        Some(Rect {
            x,
            y,
            width,
            height,
        })
    }
}

#[cfg(target_os = "windows")]
mod windows_backend {
    use super::*;
    use std::ffi::OsString;
    use std::mem::MaybeUninit;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible,
    };

    pub fn collect(scale: f64) -> DesktopSurfaceResponse {
        let mut ctx = EnumContext {
            scale,
            focused: unsafe { GetForegroundWindow() },
            surfaces: Vec::new(),
            z: 0,
        };
        unsafe {
            EnumWindows(Some(enum_window), &mut ctx as *mut EnumContext as LPARAM);
        }
        DesktopSurfaceResponse {
            surfaces: ctx.surfaces,
            sampled_at_ms: now_ms(),
            capability: DesktopSurfaceCapability::Full,
            reason: None,
        }
    }

    struct EnumContext {
        scale: f64,
        focused: HWND,
        surfaces: Vec<DesktopSurface>,
        z: i32,
    }

    unsafe extern "system" fn enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam as *mut EnumContext);
        ctx.z += 1;
        if IsWindowVisible(hwnd) == 0 {
            return TRUE;
        }

        let title = window_title(hwnd);
        let app = title.clone().unwrap_or_else(|| "Window".to_string());
        let Some(rect) = window_rect(hwnd) else {
            return TRUE;
        };
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let id = format!("windows:{}:{}", pid, hwnd);
        if let Some(surface) = make_surface(
            id,
            app,
            title,
            rect,
            ctx.scale,
            hwnd == ctx.focused,
            ctx.z,
        ) {
            ctx.surfaces.push(surface);
        }
        TRUE
    }

    unsafe fn window_title(hwnd: HWND) -> Option<String> {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize + 1];
        let got = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if got <= 0 {
            return None;
        }
        Some(
            OsString::from_wide(&buf[..got as usize])
                .to_string_lossy()
                .trim()
                .to_string(),
        )
        .filter(|s| !s.is_empty())
    }

    unsafe fn window_rect(hwnd: HWND) -> Option<Rect> {
        let mut rect = MaybeUninit::<RECT>::uninit();
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            rect.as_mut_ptr() as *mut _,
            std::mem::size_of::<RECT>() as u32,
        );
        if hr != 0 {
            return None;
        }
        let rect = rect.assume_init();
        let width = (rect.right - rect.left) as f64;
        let height = (rect.bottom - rect.top) as f64;
        Some(Rect {
            x: rect.left as f64,
            y: rect.top as f64,
            width,
            height,
        })
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt};

    pub fn collect(scale: f64) -> DesktopSurfaceResponse {
        if std::env::var("WAYLAND_DISPLAY").is_ok() && std::env::var("DISPLAY").is_err() {
            return DesktopSurfaceResponse {
                surfaces: vec![],
                sampled_at_ms: now_ms(),
                capability: DesktopSurfaceCapability::Degraded,
                reason: Some("Wayland does not expose global window geometry".to_string()),
            };
        }

        match collect_x11(scale) {
            Ok(surfaces) => DesktopSurfaceResponse {
                surfaces,
                sampled_at_ms: now_ms(),
                capability: DesktopSurfaceCapability::Full,
                reason: None,
            },
            Err(err) => DesktopSurfaceResponse {
                surfaces: vec![],
                sampled_at_ms: now_ms(),
                capability: DesktopSurfaceCapability::Degraded,
                reason: Some(err),
            },
        }
    }

    fn collect_x11(scale: f64) -> Result<Vec<DesktopSurface>, String> {
        let (conn, screen_num) = x11rb::connect(None).map_err(|e| e.to_string())?;
        let screen = &conn.setup().roots[screen_num];
        let root = screen.root;
        let client_list = intern(&conn, b"_NET_CLIENT_LIST_STACKING")?;
        let active_window = intern(&conn, b"_NET_ACTIVE_WINDOW")?;
        let wm_name = intern(&conn, b"_NET_WM_NAME")?;
        let utf8 = intern(&conn, b"UTF8_STRING")?;

        let active = conn
            .get_property(false, root, active_window, AtomEnum::WINDOW, 0, 1)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?
            .value32()
            .and_then(|mut v| v.next());

        let windows: Vec<u32> = conn
            .get_property(false, root, client_list, AtomEnum::WINDOW, 0, u32::MAX)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?
            .value32()
            .map(|v| v.collect())
            .unwrap_or_default();

        let mut surfaces = Vec::new();
        for (z, win) in windows.into_iter().enumerate() {
            let geo = conn
                .get_geometry(win)
                .map_err(|e| e.to_string())?
                .reply()
                .map_err(|e| e.to_string())?;
            let title = conn
                .get_property(false, win, wm_name, utf8, 0, 256)
                .ok()
                .and_then(|c| c.reply().ok())
                .and_then(|r| String::from_utf8(r.value).ok())
                .filter(|s| !s.trim().is_empty());
            let app = title.clone().unwrap_or_else(|| "X11 Window".to_string());
            if let Some(surface) = make_surface(
                format!("x11:{}", win),
                app,
                title,
                Rect {
                    x: geo.x as f64,
                    y: geo.y as f64,
                    width: geo.width as f64,
                    height: geo.height as f64,
                },
                scale,
                active == Some(win),
                z as i32,
            ) {
                surfaces.push(surface);
            }
        }
        Ok(surfaces)
    }

    fn intern<C: Connection>(conn: &C, name: &[u8]) -> Result<u32, String> {
        Ok(conn
            .intern_atom(false, name)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?
            .atom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scales_physical_rect_to_logical_coordinates() {
        let rect = Rect {
            x: 200.0,
            y: 100.0,
            width: 800.0,
            height: 600.0,
        }
        .scaled(2.0);
        assert_eq!(
            rect,
            Rect {
                x: 100.0,
                y: 50.0,
                width: 400.0,
                height: 300.0,
            }
        );
    }

    #[test]
    fn filters_antdesk_and_system_windows() {
        assert!(is_antdesk_or_system_window("AntDesk", None));
        assert!(is_antdesk_or_system_window("Dock", None));
        assert!(is_antdesk_or_system_window("Chrome", Some("AntDesk")));
        assert!(!is_antdesk_or_system_window("Chrome", Some("Inbox")));
    }

    #[test]
    fn rejects_tiny_or_empty_surfaces() {
        let base = DesktopSurface {
            id: "x".to_string(),
            app: "Chrome".to_string(),
            title: None,
            kind: DesktopSurfaceKind::ExternalWindow,
            x: 0.0,
            y: 0.0,
            width: 119.0,
            height: 200.0,
            focused: false,
            z_index: 0,
        };
        assert!(!is_surface_usable(&base));
        assert!(is_surface_usable(&DesktopSurface {
            width: 320.0,
            height: 200.0,
            ..base.clone()
        }));
        assert!(!is_surface_usable(&DesktopSurface {
            app: "".to_string(),
            width: 320.0,
            height: 200.0,
            ..base
        }));
    }
}
