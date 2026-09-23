//! Minimal JPEG XL bindings for pixmix, on top of jxl-oxide:
//! - `decode`: first frame as interleaved 8-bit samples (orientation applied), optionally
//!   converted to sRGB, plus the ICC profile of the returned pixels;
//! - `reconstruct_jpeg`: the original JPEG from a losslessly recompressed JPEG XL.

use std::cell::RefCell;
use std::io::Cursor;

use jxl_oxide::{EnumColourEncoding, JpegReconstructionStatus, JxlImage, PixelFormat, RenderingIntent};
use wasm_bindgen::prelude::*;

thread_local! {
    static LAST_PANIC: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Panics abort the WASM instance (a JS RuntimeError without a message); keep the message
/// so JS can report it.
#[wasm_bindgen(start)]
pub fn start() {
    std::panic::set_hook(Box::new(|info| {
        LAST_PANIC.with(|p| *p.borrow_mut() = info.to_string());
    }));
}

#[wasm_bindgen(js_name = lastPanic)]
pub fn last_panic() -> String {
    LAST_PANIC.with(|p| p.borrow().clone())
}

#[wasm_bindgen]
pub struct Decoded {
    width: u32,
    height: u32,
    channels: u32,
    pixels: Vec<u8>,
    icc: Vec<u8>,
}

#[wasm_bindgen]
impl Decoded {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 { self.width }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 { self.height }
    /// 1 grey, 2 grey + alpha, 3 RGB, 4 RGBA.
    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 { self.channels }
    /// Moves the pixels out (call once).
    #[wasm_bindgen(js_name = takePixels)]
    pub fn take_pixels(&mut self) -> Vec<u8> { std::mem::take(&mut self.pixels) }
    /// ICC profile of the returned pixels; empty when they are sRGB.
    #[wasm_bindgen(getter)]
    pub fn icc(&self) -> Vec<u8> { self.icc.clone() }
}

fn open(bytes: &[u8]) -> Result<JxlImage, String> {
    let mut image = JxlImage::builder().read(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    image.set_cms(jxl_oxide::Moxcms);
    Ok(image)
}

#[wasm_bindgen]
pub fn decode(bytes: &[u8], srgb: bool) -> Result<Decoded, String> {
    let mut image = open(bytes)?;
    if srgb {
        image.request_color_encoding(EnumColourEncoding::srgb(RenderingIntent::Relative));
    }
    let channels = match image.pixel_format() {
        PixelFormat::Gray => 1,
        PixelFormat::Graya => 2,
        PixelFormat::Rgb => 3,
        PixelFormat::Rgba => 4,
        PixelFormat::Cmyk | PixelFormat::Cmyka => return Err("CMYK JPEG XL is not supported".into()),
    };
    let icc = if srgb { Vec::new() } else { image.rendered_icc() };
    let frame = image.render_frame(0).map_err(|e| e.to_string())?;
    let mut stream = frame.stream();
    let (width, height) = (stream.width(), stream.height());
    let mut pixels = vec![0u8; (width * height * stream.channels()) as usize];
    stream.write_to_buffer(&mut pixels);
    Ok(Decoded { width, height, channels, pixels, icc })
}

/// `None` when the file carries no JPEG reconstruction data.
#[wasm_bindgen(js_name = reconstructJpeg)]
pub fn reconstruct_jpeg(bytes: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let image = open(bytes)?;
    match image.jpeg_reconstruction_status() {
        JpegReconstructionStatus::Unavailable => Ok(None),
        JpegReconstructionStatus::Available => {
            let mut out = Vec::new();
            image.reconstruct_jpeg(&mut out).map_err(|e| e.to_string())?;
            Ok(Some(out))
        }
        JpegReconstructionStatus::Invalid => Err("JPEG reconstruction data is invalid".into()),
        JpegReconstructionStatus::NeedMoreData => Err("JPEG XL file is truncated".into()),
    }
}
