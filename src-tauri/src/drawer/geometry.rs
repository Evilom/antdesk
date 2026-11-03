//! Pure geometry for four-edge docking. All inputs and outputs are physical
//! pixels; the public tab and panel sizes are expressed in logical pixels.
use super::{DrawerEdge, DrawerMode, DrawerState, Screen};

pub(super) const MAX_VISIBLE_ITEMS: usize = 10;
const EDGE_INSET: f64 = 4.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub(super) fn compact_height(item_count: usize) -> f64 {
    (124.0 + item_count.min(MAX_VISIBLE_ITEMS) as f64 * 62.0).clamp(224.0, 760.0)
}

/// Top/bottom preview depth. Keys sit in a row and grow inward inside this band.
const HORIZONTAL_PREVIEW_DEPTH: f64 = 176.0;
/// Header, add button and padding. Slot pitch is 162: a 156px key plus a 6px gap.
const HORIZONTAL_CHROME: f64 = 280.0;
const HORIZONTAL_PITCH: f64 = 162.0;

fn horizontal_span(item_count: usize) -> f64 {
    let keys = item_count.min(MAX_VISIBLE_ITEMS) as f64;
    (HORIZONTAL_CHROME + keys * HORIZONTAL_PITCH).clamp(520.0, 1680.0)
}

/// Length of the preview along the docked edge. Item count changes this axis only.
pub(super) fn preview_span(edge: DrawerEdge, count: usize) -> f64 {
    if horizontal(edge) { horizontal_span(count) } else { compact_height(count) }
}

fn preview_logical(edge: DrawerEdge, count: usize) -> (f64, f64) {
    if horizontal(edge) { (horizontal_span(count), HORIZONTAL_PREVIEW_DEPTH) }
    else { (360.0, compact_height(count)) }
}

fn valid_scale(screen: &Screen) -> f64 {
    if screen.scale.is_finite() && screen.scale > 0.0 { screen.scale } else { 1.0 }
}

fn horizontal(edge: DrawerEdge) -> bool {
    matches!(edge, DrawerEdge::Top | DrawerEdge::Bottom)
}

fn valid_anchor(edge: DrawerEdge, anchor: Option<f64>) -> f64 {
    anchor.filter(|value| value.is_finite())
        .unwrap_or(if horizontal(edge) { 0.5 } else { 0.0 })
        .clamp(0.0, 1.0)
}

pub(super) fn bounds_for(screen: &Screen, state: DrawerState, count: usize, anchor: Option<f64>) -> Bounds {
    let scale = valid_scale(screen);
    let horizontal_edge = horizontal(state.edge);
    let (logical_width, logical_height) = match state.mode {
        DrawerMode::Collapsed if horizontal_edge => (188.0, 38.0),
        DrawerMode::Collapsed => (42.0, 156.0),
        DrawerMode::Peek => preview_logical(state.edge, count),
        DrawerMode::Expanded => (448.0, 800.0),
    };
    let work_width = screen.width.max(1);
    let work_height = screen.height.max(1);
    let inset = (EDGE_INSET * scale).round() as u32;
    let inset_x = inset.min(work_width.saturating_sub(1) / 2);
    let inset_y = inset.min(work_height.saturating_sub(1) / 2);
    let available_width = work_width - inset_x * 2;
    let available_height = work_height - inset_y * 2;
    let fit_width = |logical: f64| ((logical * scale).round() as u32).max(1).min(available_width);
    let fit_height = |logical: f64| ((logical * scale).round() as u32).max(1).min(available_height);
    let width = fit_width(logical_width);
    let height = fit_height(logical_height);
    // Reserve the preview's travel range even while collapsed. The tab remains
    // inside the opened panel at all anchors; hover never moves it away from the
    // cursor. Along top/bottom the preview is a wide shallow band and the tab
    // shares that band's horizontal center.
    let (preview_width, preview_height) = preview_logical(state.edge, count);
    let reference_width = if state.mode == DrawerMode::Expanded { width } else { fit_width(preview_width) };
    let reference_height = if state.mode == DrawerMode::Expanded { height } else { fit_height(preview_height) };
    let anchor = valid_anchor(state.edge, anchor);
    let along_x = (f64::from(available_width - reference_width) * anchor).round() as i64;
    let along_y = (f64::from(available_height - reference_height) * anchor).round() as i64;
    let left = i64::from(screen.x);
    let top = i64::from(screen.y);
    let x = match state.edge {
        DrawerEdge::Left => left + i64::from(inset_x),
        DrawerEdge::Right => left + i64::from(work_width - width - inset_x),
        DrawerEdge::Top | DrawerEdge::Bottom => {
            left + i64::from(inset_x) + along_x + i64::from((reference_width - width) / 2)
        }
    };
    let y = match state.edge {
        DrawerEdge::Top => top + i64::from(inset_y),
        DrawerEdge::Bottom => top + i64::from(work_height - height - inset_y),
        DrawerEdge::Left | DrawerEdge::Right => top + i64::from(inset_y) + along_y,
    };
    Bounds {
        x: x.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        y: y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        width,
        height,
    }
}

/// The actual pointer chooses the edge, so a tall panel dragged by its header
/// can dock at the bottom even though its center remains far off-screen.
pub(super) fn nearest_edge(screen: &Screen, point: (f64, f64), previous: DrawerEdge) -> DrawerEdge {
    let left = f64::from(screen.x);
    let top = f64::from(screen.y);
    let right = left + f64::from(screen.width);
    let bottom = top + f64::from(screen.height);
    let distances = [
        (DrawerEdge::Left, (point.0 - left).abs()),
        (DrawerEdge::Right, (right - point.0).abs()),
        (DrawerEdge::Top, (point.1 - top).abs()),
        (DrawerEdge::Bottom, (bottom - point.1).abs()),
    ];
    let nearest = distances.iter().min_by(|a, b| a.1.total_cmp(&b.1)).unwrap();
    // Retain the existing edge at a corner tie, avoiding a random orientation
    // flip caused by fractional-DPI rounding or a one-pixel hand movement.
    let old = distances.iter().find(|entry| entry.0 == previous).unwrap();
    if old.1 <= nearest.1 + 8.0 * valid_scale(screen) { previous } else { nearest.0 }
}

pub(super) fn nearest_screen(screens: &[Screen], point: (f64, f64)) -> Option<usize> {
    screens.iter().enumerate().min_by(|(_, a), (_, b)| {
        let distance = |screen: &Screen| {
            let x = point.0.clamp(f64::from(screen.x), f64::from(screen.x) + f64::from(screen.width));
            let y = point.1.clamp(f64::from(screen.y), f64::from(screen.y) + f64::from(screen.height));
            (point.0 - x).powi(2) + (point.1 - y).powi(2)
        };
        distance(a).total_cmp(&distance(b))
    }).map(|(index, _)| index)
}

/// Keep the dropped panel's top on side edges and its center on horizontal
/// edges. This normalized fraction survives monitor DPI/work-area changes.
pub(super) fn anchor_for_drop(screen: &Screen, state: DrawerState, count: usize, dropped: Bounds) -> f64 {
    let first = bounds_for(screen, state, count, Some(0.0));
    let last = bounds_for(screen, state, count, Some(1.0));
    let (value, start, travel) = if horizontal(state.edge) {
        (
            f64::from(dropped.x) + f64::from(dropped.width) / 2.0,
            f64::from(first.x) + f64::from(first.width) / 2.0,
            f64::from(last.x) - f64::from(first.x),
        )
    } else {
        (f64::from(dropped.y), f64::from(first.y), f64::from(last.y) - f64::from(first.y))
    };
    if travel <= 0.0 { 0.0 } else { ((value - start) / travel).clamp(0.0, 1.0) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drawer::MonitorIdentity;

    fn screen(x: i32, y: i32, width: u32, height: u32, scale: f64) -> Screen {
        Screen { identity: MonitorIdentity { name: None, x, y }, x, y, width, height, scale }
    }

    #[test]
    fn folded_tabs_use_logical_dimensions_at_fractional_dpi() {
        let work = screen(0, 0, 2560, 1400, 1.25);
        let side = bounds_for(&work, DrawerState::default(), 4, None);
        assert_eq!(side, Bounds { x: 5, y: 5, width: 53, height: 195 });
        let top = bounds_for(&work, DrawerState { mode: DrawerMode::Collapsed, edge: DrawerEdge::Top }, 4, None);
        assert_eq!((top.width, top.height, top.y), (235, 48, 5));
    }

    #[test]
    fn top_and_bottom_previews_lie_sideways_along_the_edge() {
        let work = screen(0, 0, 1920, 1080, 1.0);
        let top = bounds_for(&work, DrawerState { mode: DrawerMode::Peek, edge: DrawerEdge::Top }, 4, None);
        let bottom = bounds_for(&work, DrawerState { mode: DrawerMode::Peek, edge: DrawerEdge::Bottom }, 4, Some(0.5));
        let side = bounds_for(&work, DrawerState { mode: DrawerMode::Peek, edge: DrawerEdge::Left }, 4, None);
        assert_eq!((top.width, top.height, top.y), (928, 176, 4));
        assert_eq!(top.x, 496);
        assert_eq!((bottom.width, bottom.height), (928, 176));
        assert_eq!(bottom.y + bottom.height as i32, 1076);
        assert_eq!(bottom.x, top.x);
        assert!(side.height > side.width);
        let few = bounds_for(&work, DrawerState { mode: DrawerMode::Peek, edge: DrawerEdge::Top }, 1, Some(0.0));
        assert_eq!((few.width, few.height, few.x, few.y), (520, 176, 4, 4));
        assert!(few.width > few.height);
        let eight = bounds_for(&work, DrawerState { mode: DrawerMode::Peek, edge: DrawerEdge::Top }, 8, Some(0.0));
        let capped = bounds_for(&work, DrawerState { mode: DrawerMode::Peek, edge: DrawerEdge::Top }, 10, Some(0.0));
        assert_eq!((eight.width, capped.width), (1576, 1680));
        assert!(eight.width > top.width);
    }

    #[test]
    fn bottom_opens_upward_inside_negative_monitor_work_area() {
        let work = screen(-1920, 48, 1920, 992, 1.0);
        let folded = bounds_for(&work, DrawerState { mode: DrawerMode::Collapsed, edge: DrawerEdge::Bottom }, 4, Some(0.75));
        let preview = bounds_for(&work, DrawerState { mode: DrawerMode::Peek, edge: DrawerEdge::Bottom }, 4, Some(0.75));
        assert_eq!(folded.y + folded.height as i32, 1036);
        assert_eq!(preview.y + preview.height as i32, 1036);
        assert_eq!(folded.x * 2 + folded.width as i32, preview.x * 2 + preview.width as i32);
        assert!(preview.y < folded.y);
    }

    #[test]
    fn pointer_over_folded_tab_stays_inside_preview_on_every_edge() {
        for work in [screen(-2560, 44, 2560, 1396, 1.5), screen(60, 30, 320, 480, 2.0)] {
            for edge in [DrawerEdge::Left, DrawerEdge::Right, DrawerEdge::Top, DrawerEdge::Bottom] {
                for anchor in [0.0, 0.4, 1.0] {
                    let tab = bounds_for(&work, DrawerState { mode: DrawerMode::Collapsed, edge }, 8, Some(anchor));
                    let preview = bounds_for(&work, DrawerState { mode: DrawerMode::Peek, edge }, 8, Some(anchor));
                    assert!(tab.x >= preview.x && tab.y >= preview.y);
                    assert!(tab.x as i64 + tab.width as i64 <= preview.x as i64 + preview.width as i64);
                    assert!(tab.y as i64 + tab.height as i64 <= preview.y as i64 + preview.height as i64);
                    assert!(preview.x >= work.x && preview.y >= work.y);
                    assert!(preview.x as i64 + preview.width as i64 <= work.x as i64 + work.width as i64);
                    assert!(preview.y as i64 + preview.height as i64 <= work.y as i64 + work.height as i64);
                }
            }
        }
    }

    #[test]
    fn tiny_work_area_and_invalid_dpi_still_produce_visible_bounds() {
        let tiny = bounds_for(&screen(0, 0, 1, 1, 2.0), DrawerState::default(), 4, Some(f64::NAN));
        assert_eq!(tiny, Bounds { x: 0, y: 0, width: 1, height: 1 });
        let fallback = bounds_for(&screen(0, 0, 1920, 1040, f64::NAN), DrawerState::default(), 0, None);
        assert_eq!((fallback.width, fallback.height), (42, 156));
    }

    #[test]
    fn actual_drop_point_selects_all_four_edges_and_stable_corner() {
        let work = screen(-1920, 40, 1920, 1000, 1.0);
        assert_eq!(nearest_edge(&work, (-1910.0, 540.0), DrawerEdge::Top), DrawerEdge::Left);
        assert_eq!(nearest_edge(&work, (-10.0, 540.0), DrawerEdge::Top), DrawerEdge::Right);
        assert_eq!(nearest_edge(&work, (-960.0, 45.0), DrawerEdge::Left), DrawerEdge::Top);
        assert_eq!(nearest_edge(&work, (-960.0, 1030.0), DrawerEdge::Left), DrawerEdge::Bottom);
        assert_eq!(nearest_edge(&work, (-1917.0, 43.0), DrawerEdge::Top), DrawerEdge::Top);
        assert_eq!(nearest_edge(&work, (-1917.0, 43.0), DrawerEdge::Left), DrawerEdge::Left);
    }

    #[test]
    fn release_selects_secondary_monitor_and_survives_gaps() {
        let screens = [screen(0, 0, 1920, 1040, 1.0), screen(-2560, 0, 2560, 1396, 1.5)];
        assert_eq!(nearest_screen(&screens, (-2300.0, 700.0)), Some(1));
        assert_eq!(nearest_screen(&screens, (900.0, 500.0)), Some(0));
        assert_eq!(nearest_screen(&[], (0.0, 0.0)), None);
    }

    #[test]
    fn normalized_anchor_round_trips_without_position_jumps() {
        let work = screen(-2560, 44, 2560, 1396, 1.5);
        for edge in [DrawerEdge::Left, DrawerEdge::Right, DrawerEdge::Top, DrawerEdge::Bottom] {
            for mode in [DrawerMode::Collapsed, DrawerMode::Peek, DrawerMode::Expanded] {
                let state = DrawerState { mode, edge };
                let target = bounds_for(&work, state, 6, Some(0.63));
                let anchor = anchor_for_drop(&work, state, 6, target);
                assert_eq!(bounds_for(&work, state, 6, Some(anchor)), target);
            }
        }
    }

    #[test]
    fn task_count_only_sizes_preview_and_caps_without_overflow() {
        assert_eq!(compact_height(0), 224.0);
        assert_eq!(compact_height(2), 248.0);
        assert_eq!(compact_height(usize::MAX), 744.0);
        let work = screen(0, 0, 1920, 1080, 1.0);
        for mode in [DrawerMode::Collapsed, DrawerMode::Expanded] {
            let state = DrawerState { mode, edge: DrawerEdge::Left };
            assert_eq!(bounds_for(&work, state, 0, Some(0.0)), bounds_for(&work, state, usize::MAX, Some(0.0)));
        }
    }
}
