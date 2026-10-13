//! The splash as AppKit draws it, so the window can show before WebKit starts. It covers the
//! webview until the page paints its own splash on the same spot, then goes.

use objc2::rc::Retained;
use objc2::{AllocAnyThread, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSBox, NSBoxType, NSColor, NSImage, NSImageView, NSTitlePosition, NSUserInterfaceItemIdentification, NSView, NSWindow, NSWindowOrderingMode,
};
use objc2_foundation::{ns_string, NSData, NSPoint, NSRect, NSSize};

use crate::Scheme;

/// The size of `#boot svg` in index.html.
const MARK_PT: f64 = 64.0;

struct Ground {
    rgb: (f64, f64, f64),
    ink: &'static str,
}

/// The colours of `#boot` in index.html.
const fn ground(scheme: Scheme) -> Ground {
    match scheme {
        Scheme::Light => Ground { rgb: (0xef as f64 / 255.0, 0xee as f64 / 255.0, 0xe9 as f64 / 255.0), ink: "#121212" },
        Scheme::Dark => Ground { rgb: (0x0e as f64 / 255.0, 0x0e as f64 / 255.0, 0x0e as f64 / 255.0), ink: "#ecebe8" },
    }
}

/// The mark of index.html, in one colour.
fn mark_svg(ink: &str) -> String {
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="64" height="64"><path d="M14 65.03 Q59 88.61 86 57.58" fill="none" stroke="{ink}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/><circle cx="23.62" cy="33.99" r="9.19" fill="{ink}"/><circle cx="76.38" cy="33.99" r="9.19" fill="{ink}"/></svg>"#
    )
}

pub fn cover(window: &NSWindow, scheme: Scheme, mtm: MainThreadMarker) {
    let Some(content) = window.contentView() else { return };
    let Ground { rgb: (r, g, b), ink } = ground(scheme);
    let bounds = content.bounds();
    let cover = NSBox::initWithFrame(NSBox::alloc(mtm), bounds);
    cover.setBoxType(NSBoxType::Custom);
    cover.setTitlePosition(NSTitlePosition::NoTitle);
    cover.setBorderWidth(0.0);
    cover.setContentViewMargins(NSSize::ZERO);
    cover.setFillColor(&NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, 1.0));
    cover.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable);
    cover.setIdentifier(Some(ns_string!("tomo.splash")));
    let data = NSData::with_bytes(mark_svg(ink).as_bytes());
    if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
        let mark = NSImageView::imageViewWithImage(&image, mtm);
        let origin = NSPoint::new(((bounds.size.width - MARK_PT) / 2.0).round(), ((bounds.size.height - MARK_PT) / 2.0).round());
        mark.setFrame(NSRect::new(origin, NSSize::new(MARK_PT, MARK_PT)));
        mark.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewMinXMargin | NSAutoresizingMaskOptions::ViewMaxXMargin | NSAutoresizingMaskOptions::ViewMinYMargin | NSAutoresizingMaskOptions::ViewMaxYMargin,
        );
        cover.addSubview(&mark);
    }
    content.addSubview_positioned_relativeTo(&cover, NSWindowOrderingMode::Above, None);
}

pub fn lift(window: &NSWindow) {
    if let Some(content) = window.contentView() {
        if let Some(cover) = find(&content) {
            content.addSubview_positioned_relativeTo(&cover, NSWindowOrderingMode::Above, None);
        }
    }
}

pub fn uncover(window: &NSWindow) {
    if let Some(cover) = window.contentView().as_deref().and_then(find) {
        cover.removeFromSuperview();
    }
}

fn find(content: &NSView) -> Option<Retained<NSView>> {
    content.subviews().iter().find(|v| v.identifier().is_some_and(|id| &*id == ns_string!("tomo.splash")))
}
