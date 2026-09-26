//! Minimal JPEG XL bindings for pixmix, on top of jxl-oxide:
//! - `decode`: first frame as interleaved 8- or 16-bit samples (orientation applied),
//!   optionally converted to sRGB, plus the ICC profile of the returned pixels, the
//!   orientation, and the enum colour encoding when the image has one instead of an ICC
//!   profile (so an encoder can write it again as it was);
//! - `decode_animation`: every keyframe, with durations in ticks, the tick rate and the
//!   loop count;
//! - `reconstruct_jpeg`: the original JPEG from a losslessly recompressed JPEG XL.
//!
//! Every call takes resource limits (see pixmix's core/limits.js): the image size and frame
//! count are checked from the headers before anything is rendered, and jxl-oxide's own
//! allocation tracker caps what its buffers may use. Errors caused by a limit start with
//! "LIMIT: " so JS can tell them apart.

use std::cell::RefCell;
use std::io::Cursor;

use jxl_oxide::color::{ColourEncoding, ColourSpace, Primaries, TransferFunction, WhitePoint};
use jxl_oxide::{AllocTracker, EnumColourEncoding, JpegReconstructionStatus, JxlImage, PixelFormat, RenderingIntent};
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
    orientation: u32,
    colour: Vec<f64>,
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
    /// The codestream's orientation (1-8, as in EXIF), which the pixels have applied.
    #[wasm_bindgen(getter)]
    pub fn orientation(&self) -> u32 { self.orientation }
    /// The enum colour encoding of the returned pixels (see `colour_of`); empty when the
    /// image has an ICC profile or the pixels were converted to sRGB.
    #[wasm_bindgen(getter)]
    pub fn colour(&self) -> Vec<f64> { self.colour.clone() }
}

/// The image's enum colour encoding as numbers, in libjxl's JxlColorEncoding terms (the
/// same values as the JPEG XL spec): colour space, white point, primaries, transfer
/// function, gamma, rendering intent, then the white point's and the red, green and blue
/// primaries' xy (0 unless custom). Empty for an ICC profile, or XYB/unknown colour spaces.
fn colour_of(image: &JxlImage) -> Vec<f64> {
    let ColourEncoding::Enum(e) = &image.image_header().metadata.colour_encoding else {
        return Vec::new();
    };
    let space = match e.colour_space {
        ColourSpace::Rgb => 0.0,
        ColourSpace::Grey => 1.0,
        ColourSpace::Xyb | ColourSpace::Unknown => return Vec::new(),
    };
    let xy = |c: jxl_oxide::color::Customxy| [c.x as f64 / 1e6, c.y as f64 / 1e6];
    let (white, wxy) = match e.white_point {
        WhitePoint::D65 => (1.0, [0.0; 2]),
        WhitePoint::Custom(c) => (2.0, xy(c)),
        WhitePoint::E => (10.0, [0.0; 2]),
        WhitePoint::Dci => (11.0, [0.0; 2]),
    };
    let (primaries, pxy) = match e.primaries {
        Primaries::Srgb => (1.0, [0.0; 6]),
        Primaries::Custom { red, green, blue } => {
            let (r, g, b) = (xy(red), xy(green), xy(blue));
            (2.0, [r[0], r[1], g[0], g[1], b[0], b[1]])
        }
        Primaries::Bt2100 => (9.0, [0.0; 6]),
        Primaries::P3 => (11.0, [0.0; 6]),
    };
    let (tf, gamma) = match e.tf {
        TransferFunction::Gamma { g, .. } => (65535.0, g as f64 / 1e7),
        TransferFunction::Bt709 => (1.0, 0.0),
        TransferFunction::Unknown => (2.0, 0.0),
        TransferFunction::Linear => (8.0, 0.0),
        TransferFunction::Srgb => (13.0, 0.0),
        TransferFunction::Pq => (16.0, 0.0),
        TransferFunction::Dci => (17.0, 0.0),
        TransferFunction::Hlg => (18.0, 0.0),
    };
    let intent = match e.rendering_intent {
        RenderingIntent::Perceptual => 0.0,
        RenderingIntent::Relative => 1.0,
        RenderingIntent::Saturation => 2.0,
        RenderingIntent::Absolute => 3.0,
    };
    let mut out = vec![space, white, primaries, tf, gamma, intent];
    out.extend_from_slice(&wxy);
    out.extend_from_slice(&pxy);
    out
}

/// Numbers from JS, so Infinity means no limit.
fn open(bytes: &[u8], max_pixels: f64, alloc_bytes: f64) -> Result<JxlImage, String> {
    let mut builder = JxlImage::builder();
    if alloc_bytes.is_finite() {
        builder = builder.alloc_tracker(AllocTracker::with_limit(alloc_bytes.clamp(0.0, usize::MAX as f64) as usize));
    }
    let mut image = builder.read(Cursor::new(bytes)).map_err(error)?;
    let (w, h) = (image.width(), image.height());
    if w as f64 * h as f64 > max_pixels {
        return Err(format!(
            "LIMIT: Image is {w}x{h} ({} megapixels), over the limit of {} megapixels (limits.maxPixels)",
            mp(w as f64 * h as f64),
            mp(max_pixels)
        ));
    }
    image.set_cms(jxl_oxide::Moxcms);
    Ok(image)
}

fn mp(n: f64) -> String {
    format!("{}", (n / 1e4).round() / 100.0)
}

/// An allocation the tracker refused becomes a limit error.
fn error(e: impl std::fmt::Display) -> String {
    let msg = e.to_string();
    let lower = msg.to_ascii_lowercase();
    if lower.contains("out of memory") || lower.contains("failed to allocate") {
        format!("LIMIT: Decoding needs more memory than allowed ({msg})")
    } else {
        msg
    }
}

fn channels_of(image: &JxlImage) -> Result<u32, String> {
    match image.pixel_format() {
        PixelFormat::Gray => Ok(1),
        PixelFormat::Graya => Ok(2),
        PixelFormat::Rgb => Ok(3),
        PixelFormat::Rgba => Ok(4),
        PixelFormat::Cmyk | PixelFormat::Cmyka => Err("CMYK JPEG XL is not supported".into()),
    }
}

/// `high`: 16-bit samples instead of 8-bit (for images with more than 8 bits).
#[wasm_bindgen]
pub fn decode(bytes: &[u8], srgb: bool, high: bool, max_pixels: f64, alloc_bytes: f64) -> Result<Decoded, String> {
    let mut image = open(bytes, max_pixels, alloc_bytes)?;
    if srgb {
        image.request_color_encoding(EnumColourEncoding::srgb(RenderingIntent::Relative));
    }
    let channels = channels_of(&image)?;
    let icc = if srgb { Vec::new() } else { image.rendered_icc() };
    let colour = if srgb { Vec::new() } else { colour_of(&image) };
    let orientation = image.image_header().metadata.orientation;
    let frame = image.render_frame(0).map_err(error)?;
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
    Ok(Decoded { width, height, channels, pixels, pixels16, icc, orientation, colour })
}

#[wasm_bindgen]
pub struct Animation {
    width: u32,
    height: u32,
    channels: u32,
    count: u32,
    pixels: Vec<u8>,
    ticks: Vec<u32>,
    tps_numerator: u32,
    tps_denominator: u32,
    loops: u32,
    orientation: u32,
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
    /// Each frame's duration in ticks; a tick is `tpsDenominator / tpsNumerator` seconds.
    #[wasm_bindgen(getter)]
    pub fn ticks(&self) -> Vec<u32> { self.ticks.clone() }
    #[wasm_bindgen(getter, js_name = tpsNumerator)]
    pub fn tps_numerator(&self) -> u32 { self.tps_numerator }
    #[wasm_bindgen(getter, js_name = tpsDenominator)]
    pub fn tps_denominator(&self) -> u32 { self.tps_denominator }
    /// 0 = forever.
    #[wasm_bindgen(getter)]
    pub fn loops(&self) -> u32 { self.loops }
    /// The codestream's orientation (1-8), which the frames have applied.
    #[wasm_bindgen(getter)]
    pub fn orientation(&self) -> u32 { self.orientation }
}

/// All keyframes (composited, orientation applied), like `decode` but for animations.
#[wasm_bindgen(js_name = decodeAnimation)]
pub fn decode_animation(
    bytes: &[u8],
    srgb: bool,
    max_pixels: f64,
    max_frames: f64,
    max_total_pixels: f64,
    alloc_bytes: f64,
) -> Result<Animation, String> {
    let mut image = open(bytes, max_pixels, alloc_bytes)?;
    if srgb {
        image.request_color_encoding(EnumColourEncoding::srgb(RenderingIntent::Relative));
    }
    let channels = channels_of(&image)?;
    let (tps_numerator, tps_denominator, loops) = match &image.image_header().metadata.animation {
        Some(a) => (a.tps_numerator.max(1), a.tps_denominator.max(1), a.num_loops),
        None => (1, 1, 0),
    };
    let orientation = image.image_header().metadata.orientation;
    let count = image.num_loaded_keyframes();
    if count as f64 > max_frames {
        return Err(format!("LIMIT: Animation has {count} frames, over the limit of {max_frames} (limits.maxFrames)"));
    }
    let total = count as f64 * image.width() as f64 * image.height() as f64;
    if total > max_total_pixels {
        return Err(format!(
            "LIMIT: Animation frames add up to {} megapixels, over the limit of {} megapixels (limits.maxTotalPixels)",
            mp(total),
            mp(max_total_pixels)
        ));
    }
    let (mut width, mut height) = (0, 0);
    let mut pixels = Vec::new();
    let mut ticks = Vec::with_capacity(count);
    for i in 0..count {
        let frame = image.render_frame(i).map_err(error)?;
        ticks.push(frame.duration());
        let mut stream = frame.stream();
        width = stream.width();
        height = stream.height();
        let start = pixels.len();
        pixels.resize(start + (width * height * stream.channels()) as usize, 0);
        stream.write_to_buffer(&mut pixels[start..]);
    }
    Ok(Animation { width, height, channels, count: count as u32, pixels, ticks, tps_numerator, tps_denominator, loops, orientation })
}

/// `None` when the file carries no JPEG reconstruction data.
#[wasm_bindgen(js_name = reconstructJpeg)]
pub fn reconstruct_jpeg(bytes: &[u8], max_pixels: f64, alloc_bytes: f64) -> Result<Option<Vec<u8>>, String> {
    let image = open(bytes, max_pixels, alloc_bytes)?;
    match image.jpeg_reconstruction_status() {
        JpegReconstructionStatus::Unavailable => Ok(None),
        JpegReconstructionStatus::Available => {
            let mut out = Vec::new();
            image.reconstruct_jpeg(&mut out).map_err(error)?;
            Ok(Some(out))
        }
        JpegReconstructionStatus::Invalid => Err("JPEG reconstruction data is invalid".into()),
        JpegReconstructionStatus::NeedMoreData => Err("JPEG XL file is truncated".into()),
    }
}
