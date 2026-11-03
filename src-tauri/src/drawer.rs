//! Native docking for the planner. Web content animates inside three native bounds;
//! no animation frames or pointer movements cross the IPC boundary.
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize};

mod dragging;
mod geometry;
use geometry::{bounds_for, preview_span, MAX_VISIBLE_ITEMS};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DrawerMode {
    #[default]
    Collapsed,
    Peek,
    Expanded,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DrawerEdge {
    #[default]
    Left,
    Right,
    Top,
    Bottom,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct DrawerState {
    pub mode: DrawerMode,
    pub edge: DrawerEdge,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(default)]
struct Preferences {
    edge: DrawerEdge,
    monitor: Option<MonitorIdentity>,
    // Fraction of the usable travel along the selected edge. Old preferences
    // omit this value and retain their original default location.
    anchor: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct MonitorIdentity {
    name: Option<String>,
    x: i32,
    y: i32,
}

#[derive(Clone, Debug, PartialEq)]
struct Screen {
    identity: MonitorIdentity,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}

impl From<&Monitor> for Screen {
    fn from(monitor: &Monitor) -> Self {
        let area = monitor.work_area();
        Self {
            identity: MonitorIdentity {
                name: monitor.name().cloned(),
                x: monitor.position().x,
                y: monitor.position().y,
            },
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
            scale: monitor.scale_factor(),
        }
    }
}

#[derive(Clone, Debug, Default)]
struct Runtime {
    state: DrawerState,
    preferences: Preferences,
    screens: Vec<Screen>,
    // Only the number of visible keys affects native bounds. Task contents and
    // ordering remain frontend data; hover and drag frames never cross IPC.
    item_count: usize,
    // Only an explicit native header drag can change the persisted dock edge.
    // Programmatic position events and hover reflow never initiate docking.
    dragging: bool,
}

#[derive(Default)]
pub struct DrawerController {
    // OS calls can dispatch window events. Never hold runtime's std mutex across
    // those calls; the async gate serializes transitions without blocking the UI.
    transition: tokio::sync::Mutex<()>,
    runtime: Mutex<Runtime>,
    shortcut: Mutex<Option<String>>,
    #[cfg(target_os = "windows")]
    previous_foreground: windows_focus::PreviousForeground,
}

// WS_EX_NOACTIVATE prevents future activation; it does not release keyboard
// focus that an expanded WebView2 window already owns. Return that focus only
// while our main window is still foreground, respecting any intervening switch
// the user made to another application.
#[cfg(target_os = "windows")]
mod windows_focus {
    use super::{snapshot, DrawerMode};
    use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
    use tauri::{AppHandle, WebviewWindow};
    use windows_sys::Win32::{
        Foundation::HWND,
        UI::{
            Input::KeyboardAndMouse::{SetActiveWindow, SetFocus},
            WindowsAndMessaging::{
                GetForegroundWindow, GetShellWindow, GetWindowThreadProcessId, IsIconic,
                IsWindow, IsWindowVisible, SetForegroundWindow,
            },
        },
    };

    #[derive(Default)]
    pub struct PreviousForeground {
        hwnd: AtomicIsize,
        process_id: AtomicU32,
    }

    // Do not restore closed, hidden, minimized, or same-process windows. Checking
    // the process id as well also rejects a recycled HWND belonging to a new app.
    unsafe fn external_process(hwnd: HWND) -> Option<u32> {
        if hwnd.is_null() || IsWindow(hwnd) == 0 || IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
            return None;
        }
        let mut process_id = 0;
        if GetWindowThreadProcessId(hwnd, &mut process_id) == 0
            || process_id == 0
            || process_id == std::process::id()
        {
            return None;
        }
        Some(process_id)
    }

    impl PreviousForeground {
        pub fn remember(&self) {
            // SAFETY: Win32 validates these borrowed handles; none is owned or
            // closed here, and no pointer is dereferenced by Rust.
            unsafe {
                let foreground = GetForegroundWindow();
                if let Some(process_id) = external_process(foreground) {
                    self.process_id.store(process_id, Ordering::SeqCst);
                    self.hwnd.store(foreground as isize, Ordering::SeqCst);
                }
            }
        }

        pub fn release(&self, app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
            let main = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
            let previous = self.hwnd.load(Ordering::SeqCst);
            let previous_process = self.process_id.load(Ordering::SeqCst);
            let app = app.clone();
            // SetFocus/SetActiveWindow operate on the calling UI thread's input
            // queue. The callback also checks the foreground again after queuing.
            window.run_on_main_thread(move || {
                if !snapshot(&app).is_ok_and(|runtime| runtime.state.mode != DrawerMode::Expanded) {
                    return;
                }
                // SAFETY: every external HWND is revalidated at use time; the
                // fallback only clears input state on our own window thread.
                unsafe {
                    let main = main as HWND;
                    if GetForegroundWindow() != main { return; }
                    let previous = previous as HWND;
                    if external_process(previous) == Some(previous_process)
                        && GetForegroundWindow() == main
                        && SetForegroundWindow(previous) != 0
                    {
                        return;
                    }
                    // A previous app may have exited while the drawer was open.
                    // The shell is a safe fallback; never pick an arbitrary app.
                    let shell = GetShellWindow();
                    if external_process(shell).is_some()
                        && GetForegroundWindow() == main
                        && SetForegroundWindow(shell) != 0
                    {
                        return;
                    }
                    if GetForegroundWindow() == main {
                        // Foreground activation can be denied by Windows. Leave
                        // the visible webview alive but unable to consume typing.
                        SetFocus(std::ptr::null_mut());
                        SetActiveWindow(std::ptr::null_mut());
                    }
                }
            }).map_err(|error| error.to_string())
        }
    }
}

fn find_screen(screens: &[Screen], identity: Option<&MonitorIdentity>) -> Option<usize> {
    let identity = identity?;
    screens.iter().position(|screen| screen.identity == *identity)
        .or_else(|| {
            identity.name.as_ref().and_then(|name| {
                screens.iter().position(|screen| screen.identity.name.as_ref() == Some(name))
            })
        })
        .or_else(|| {
            screens.iter().position(|screen| {
                screen.identity.x == identity.x && screen.identity.y == identity.y
            })
        })
}

fn preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir()
        .map(|path| path.join("drawer-preferences.json"))
        .map_err(|error| error.to_string())
}

fn load_preferences(app: &AppHandle) -> Preferences {
    let result = preferences_path(app).and_then(|path| {
        if !path.exists() { return Ok(Preferences::default()); }
        let bytes = fs::read(path).map_err(|error| error.to_string())?;
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())
    });
    result.unwrap_or_else(|error| {
        eprintln!("Drawer preferences could not be loaded: {error}");
        Preferences::default()
    })
}

fn save_preferences(app: &AppHandle, preferences: &Preferences) -> Result<(), String> {
    let path = preferences_path(app)?;
    let parent = path.parent().ok_or("Drawer preferences directory is unavailable")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(preferences).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())
}

fn snapshot(app: &AppHandle) -> Result<Runtime, String> {
    app.state::<DrawerController>().runtime.lock()
        .map(|runtime| runtime.clone())
        .map_err(|_| "Drawer state is unavailable".to_string())
}

// Called during setup or while holding transition. Do not call from a window
// event synchronously: getters may dispatch to the window's event thread.
fn apply_layout(
    app: &AppHandle,
    mode: Option<DrawerMode>,
    edge: Option<DrawerEdge>,
    focus: bool,
    restore_monitor: bool,
) -> Result<DrawerState, String> {
    apply_layout_at(app, mode, edge, focus, restore_monitor, None)
}

fn apply_layout_at(
    app: &AppHandle,
    mode: Option<DrawerMode>,
    edge: Option<DrawerEdge>,
    focus: bool,
    restore_monitor: bool,
    target: Option<Preferences>,
) -> Result<DrawerState, String> {
    let previous = snapshot(app)?;
    // Windows dispatches scale/focus events while its native move loop runs.
    // A queued hover or display reflow must never pull the window out of it.
    if previous.dragging { return Ok(previous.state); }
    let state = DrawerState {
        mode: mode.unwrap_or(previous.state.mode),
        edge: edge.unwrap_or(previous.state.edge),
    };
    let requested = target.as_ref().unwrap_or(&previous.preferences);
    let anchor = if requested.edge == state.edge { requested.anchor } else { None };
    let window = app.get_webview_window("main").ok_or("Planner window is unavailable")?;
    #[cfg(target_os = "windows")]
    if focus && state.mode == DrawerMode::Expanded {
        app.state::<DrawerController>().previous_foreground.remember();
    }
    let monitors = window.available_monitors().map_err(|error| error.to_string())?;
    let screens: Vec<Screen> = monitors.iter().map(Screen::from).collect();
    if screens.is_empty() { return Err("No display is available for the drawer".into()); }
    let current = window.current_monitor().ok().flatten().map(|monitor| Screen::from(&monitor).identity);
    let primary = window.primary_monitor().ok().flatten().map(|monitor| Screen::from(&monitor).identity);
    let saved = find_screen(&screens, requested.monitor.as_ref());
    let current = find_screen(&screens, current.as_ref());
    let selected = if restore_monitor { saved.or(current) } else { current.or(saved) }
        .or_else(|| find_screen(&screens, primary.as_ref()))
        .unwrap_or(0);
    let screen = &screens[selected];
    let bounds = bounds_for(screen, state, previous.item_count, anchor);

    // A peek must never activate the application. Making the small states
    // non-activating also prevents hover-open from stealing keyboard input.
    window.set_focusable(state.mode == DrawerMode::Expanded)
        .map_err(|error| error.to_string())?;
    if focus && state.mode == DrawerMode::Expanded {
        window.unminimize().map_err(|error| error.to_string())?;
    }
    let position = PhysicalPosition::new(bounds.x, bounds.y);
    if window.outer_position().ok() != Some(position) {
        window.set_position(position).map_err(|error| error.to_string())?;
    }
    let size = PhysicalSize::new(bounds.width, bounds.height);
    if window.inner_size().ok() != Some(size) {
        window.set_size(size).map_err(|error| error.to_string())?;
    }
    if !window.is_visible().map_err(|error| error.to_string())? {
        window.show().map_err(|error| error.to_string())?;
    }

    let preferences = Preferences { edge: state.edge, monitor: Some(screen.identity.clone()), anchor };
    {
        let controller = app.state::<DrawerController>();
        let mut runtime = controller.runtime.lock().map_err(|_| "Drawer state is unavailable")?;
        *runtime = Runtime { state, preferences: preferences.clone(), screens, item_count: previous.item_count, dragging: false };
    }
    // Notify before focusing so the frontend knows the new state when receiving
    // native focus events. No task/assistant data is touched by these preferences.
    window.emit("drawer:state-changed", state).map_err(|error| error.to_string())?;
    if focus && state.mode == DrawerMode::Expanded {
        window.set_focus().map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "windows")]
    if state.mode != DrawerMode::Expanded {
        app.state::<DrawerController>().previous_foreground.release(app, &window)?;
    }
    if previous.preferences != preferences {
        if let Err(error) = save_preferences(app, &preferences) {
            eprintln!("Drawer preference save failed: {error}");
        }
    }
    Ok(state)
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let controller = app.state::<DrawerController>();
    let _transition = controller.transition.try_lock()
        .map_err(|_| "Drawer initialization is already in progress")?;
    let preferences = load_preferences(app);
    {
        let controller = app.state::<DrawerController>();
        let mut runtime = controller.runtime.lock().map_err(|_| "Drawer state is unavailable")?;
        runtime.state.edge = preferences.edge;
        runtime.preferences = preferences;
    }
    // Both autostart and normal launch leave a visible, non-activating edge tab.
    apply_layout(app, Some(DrawerMode::Collapsed), None, false, true)?;
    start_display_watch(app.clone());
    Ok(())
}

#[cfg(desktop)]
pub fn setup_shortcut(app: &AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let mut registered = None;
    for shortcut in ["Ctrl+Shift+A", "Ctrl+Alt+A", "Ctrl+Alt+Shift+A"] {
        match app.global_shortcut().register(shortcut) {
            Ok(()) => {
                registered = Some(shortcut.to_string());
                break;
            }
            Err(error) => eprintln!("{shortcut} is unavailable: {error}"),
        }
    }
    let controller = app.state::<DrawerController>();
    match controller.shortcut.lock() {
        Ok(mut shortcut) => *shortcut = registered.clone(),
        Err(_) => eprintln!("Drawer shortcut state is unavailable"),
    }
    // Registration happens before the first show. The event also allows a future
    // settings panel to observe a registration retry without changing mode/edge.
    let _ = app.emit("drawer:shortcut-changed", registered);
}

pub async fn set_mode(app: &AppHandle, mode: DrawerMode, edge: Option<DrawerEdge>, focus: bool) -> Result<DrawerState, String> {
    let controller = app.state::<DrawerController>();
    let _transition = controller.transition.lock().await;
    apply_layout(app, Some(mode), edge, focus, false)
}

pub async fn toggle(app: &AppHandle) -> Result<DrawerState, String> {
    let controller = app.state::<DrawerController>();
    let _transition = controller.transition.lock().await;
    let mode = if snapshot(app)?.state.mode == DrawerMode::Expanded {
        DrawerMode::Collapsed
    } else {
        DrawerMode::Expanded
    };
    apply_layout(app, Some(mode), None, mode == DrawerMode::Expanded, false)
}

pub fn queue_reflow(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let controller = app.state::<DrawerController>();
        let _transition = controller.transition.lock().await;
        if let Err(error) = apply_layout(&app, None, None, false, false) {
            eprintln!("Drawer display adjustment failed: {error}");
        }
    });
}

fn start_display_watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let Some(window) = app.get_webview_window("main") else { break; };
            let Ok(monitors) = window.available_monitors() else { continue; };
            let screens: Vec<Screen> = monitors.iter().map(Screen::from).collect();
            // Ignore temporary zero-display states during sleep/hot-plug. The
            // next successful enumeration restores bounds without taking focus.
            if screens.is_empty() { continue; }
            let Ok(previous) = snapshot(&app) else { continue; };
            if previous.screens != screens {
                let controller = app.state::<DrawerController>();
                let _transition = controller.transition.lock().await;
                if let Err(error) = apply_layout(&app, None, None, false, true) {
                    eprintln!("Drawer monitor recovery failed: {error}");
                }
            }
        }
    });
}

#[tauri::command]
pub fn drawer_get_state(app: AppHandle) -> Result<DrawerState, String> {
    Ok(snapshot(&app)?.state)
}

#[tauri::command]
pub fn drawer_get_shortcut(app: AppHandle) -> Option<String> {
    app.state::<DrawerController>().shortcut.lock().ok().and_then(|shortcut| shortcut.clone())
}

#[tauri::command]
pub async fn drawer_set_state(app: AppHandle, mode: DrawerMode, edge: Option<DrawerEdge>) -> Result<DrawerState, String> {
    set_mode(&app, mode, edge, mode == DrawerMode::Expanded).await
}

#[tauri::command]
pub async fn drawer_start_drag(app: AppHandle) -> Result<DrawerState, String> {
    dragging::start(&app).await
}

#[tauri::command]
pub async fn drawer_set_item_count(app: AppHandle, count: usize) -> Result<DrawerState, String> {
    let controller = app.state::<DrawerController>();
    let _transition = controller.transition.lock().await;
    let previous = snapshot(&app)?;
    let count = count.min(MAX_VISIBLE_ITEMS);
    if previous.item_count == count { return Ok(previous.state); }
    {
        let mut runtime = controller.runtime.lock().map_err(|_| "Drawer state is unavailable")?;
        runtime.item_count = count;
    }
    // Expanded uses fixed bounds. Collapsed tabs share the preview's along-edge
    // anchor, so a longer queue can also slide a side tab or a top/bottom tab.
    if previous.state.mode == DrawerMode::Expanded
        || previous.dragging
        || preview_span(previous.state.edge, previous.item_count) == preview_span(previous.state.edge, count)
    {
        return Ok(previous.state);
    }
    match apply_layout(&app, None, None, false, false) {
        Ok(state) => Ok(state),
        Err(error) => {
            // Preserve retryability if a display/window transition failed.
            if let Ok(mut runtime) = controller.runtime.lock() {
                runtime.item_count = previous.item_count;
            }
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(x: i32, y: i32, width: u32, height: u32, scale: f64) -> Screen {
        Screen { identity: MonitorIdentity { name: None, x, y }, x, y, width, height, scale }
    }

    #[test]
    fn remembered_monitor_survives_layout_changes() {
        let mut secondary = screen(-1920, 0, 1920, 1040, 1.0);
        secondary.identity.name = Some("external".into());
        let remembered = MonitorIdentity { name: Some("external".into()), x: 1920, y: 0 };
        assert_eq!(find_screen(&[screen(0, 0, 1920, 1040, 1.0), secondary], Some(&remembered)), Some(1));
        assert_eq!(find_screen(&[screen(0, 0, 1920, 1040, 1.0)], Some(&remembered)), None);
    }

    #[test]
    fn older_preferences_without_anchor_remain_valid() {
        let preferences: Preferences = serde_json::from_str(r#"{"edge":"right","monitor":null}"#).unwrap();
        assert_eq!(preferences.edge, DrawerEdge::Right);
        assert_eq!(preferences.anchor, None);
        let bottom: Preferences = serde_json::from_str(r#"{"edge":"bottom","anchor":0.7}"#).unwrap();
        assert_eq!(bottom.edge, DrawerEdge::Bottom);
        assert_eq!(bottom.anchor, Some(0.7));
    }
}
