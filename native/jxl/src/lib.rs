//! Minimal JPEG XL bindings for pixmix, on top of jxl-oxide:
//! - `decode`: first frame as interleaved 8- or 16-bit samples (orientation applied),
//!   optionally converted to sRGB, plus the ICC profile of the returned pixels;
//! - `decode_animation`: every keyframe, with durations in milliseconds and the loop count;
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
    pixels16: Vec<u16>,
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
    /// Moves the 8-bit pixels out (call once; empty when decoded with `high`).
    #[wasm_bindgen(js_name = takePixels)]
    pub fn take_pixels(&mut self) -> Vec<u8> { std::mem::take(&mut self.pixels) }
    /// Moves the 16-bit pixels out (call once; empty unless decoded with `high`).
    #[wasm_bindgen(js_name = takePixels16)]
    pub fn take_pixels16(&mut self) -> Vec<u16> { std::mem::take(&mut self.pixels16) }
    /// ICC profile of the returned pixels; empty when they are sRGB.
    #[wasm_bindgen(getter)]
    pub fn icc(&self) -> Vec<u8> { self.icc.clone() }
}

fn open(bytes: &[u8]) -> Result<JxlImage, String> {
    let mut image = JxlImage::builder().read(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    image.set_cms(jxl_oxide::Moxcms);
    Ok(image)
}

/// `high`: 16-bit samples instead of 8-bit (for images with more than 8 bits).
#[wasm_bindgen]
pub fn decode(bytes: &[u8], srgb: bool, high: bool) -> Result<Decoded, String> {
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
    let n = (width * height * stream.channels()) as usize;
    let (mut pixels, mut pixels16) = (Vec::new(), Vec::new());
    if high {
        pixels16 = vec![0u16; n];
        stream.write_to_buffer(&mut pixels16);
    } else {
        pixels = vec![0u8; n];
        stream.write_to_buffer(&mut pixels);
    }
    Ok(Decoded { width, height, channels, pixels, pixels16, icc })
}

#[wasm_bindgen]
pub struct Animation {
    width: u32,
    height: u32,
    channels: u32,
    count: u32,
    pixels: Vec<u8>,
    durations_ms: Vec<u32>,
    loops: u32,
}

#[wasm_bindgen]
impl Animation {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 { self.width }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 { self.height }
    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 { self.channels }
    /// Number of frames; `takePixels` holds them one after another.
    #[wasm_bindgen(getter)]
    pub fn count(&self) -> u32 { self.count }
    #[wasm_bindgen(js_name = takePixels)]
    pub fn take_pixels(&mut self) -> Vec<u8> { std::mem::take(&mut self.pixels) }
    #[wasm_bindgen(getter, js_name = durationsMs)]
    pub fn durations_ms(&self) -> Vec<u32> { self.durations_ms.clone() }
    /// 0 = forever.
    #[wasm_bindgen(getter)]
    pub fn loops(&self) -> u32 { self.loops }
}

/// All keyframes (composited, orientation applied), like `decode` but for animations.
#[wasm_bindgen(js_name = decodeAnimation)]
pub fn decode_animation(bytes: &[u8], srgb: bool) -> Result<Animation, String> {
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
    let (tps_num, tps_den, loops) = match &image.image_header().metadata.animation {
        Some(a) => (a.tps_numerator.max(1) as u64, a.tps_denominator as u64, a.num_loops),
        None => (1, 0, 0),
    };
    let count = image.num_loaded_keyframes();
    let (mut width, mut height) = (0, 0);
    let mut pixels = Vec::new();
    let mut durations_ms = Vec::with_capacity(count);
    for i in 0..count {
        let frame = image.render_frame(i).map_err(|e| e.to_string())?;
        let ticks = frame.duration() as u64;
        durations_ms.push(((ticks * 1000 * tps_den + tps_num / 2) / tps_num).min(u32::MAX as u64) as u32);
        let mut stream = frame.stream();
        width = stream.width();
        height = stream.height();
        let start = pixels.len();
        pixels.resize(start + (width * height * stream.channels()) as usize, 0);
        stream.write_to_buffer(&mut pixels[start..]);
    }
    Ok(Animation { width, height, channels, count: count as u32, pixels, durations_ms, loops })
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
