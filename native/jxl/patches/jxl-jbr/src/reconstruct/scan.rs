// pixmix patch: this scan writer is rewritten as a direct port of libjxl's reference
// reconstruction (lib/jxl/jpeg/dec_jpeg_data_writer.cc: DoEncodeScan,
// EncodeDCTBlockSequential, EncodeDCTBlockProgressive, EncodeRefinementBits, Flush,
// BufferEndOfBand, JumpToByteBoundary). The upstream writer walked the interleaved MCU grid
// of the scan's own components, so it:
// - gave a non-interleaved scan of a subsampled component (every chroma AC scan of a
//   progressive 4:2:0 JPEG, every chroma scan of a non-interleaved baseline one) the block
//   count of a full-resolution one, and looked its blocks up at the wrong place (panics in
//   jxl-grid, or silently wrong coefficients);
// - never ended an EOB run after each block in a progressive scan that starts at the DC
//   (Ss = 0 < Se), and coded a progressive Ss = 0, Se = 63, Ah = Al = 0 scan as progressive
//   rather than sequential;
// - wrote extra zero runs in refinement scans, which libjxl never does;
// - wrote the padding bits of a byte boundary in reverse order.
// Blocks are now addressed per JPEG component, as libjxl's JPEGData holds them
// (width_in_blocks x height_in_blocks), and a scan covers libjxl's CalculateMcuSize grid.

use std::io::Write;

use jxl_bitstream::Bitstream;

use crate::bit_writer::BitWriter;
use crate::huffman::{self, BuiltHuffmanTable};
use crate::{Error, Result, ScanInfo, ScanMoreInfo};

/// Where a JPEG component's blocks live in the JPEG XL frame, and its JPEG sampling factors.
#[derive(Debug, Clone, Copy)]
pub(super) struct CompGeometry {
    /// Index into the [Y, Cb, Cr]-ordered per-channel data (pass groups, LF quant, shifts).
    pub idx: usize,
    pub h_samp: u32,
    pub v_samp: u32,
    pub hshift: u32,
    pub vshift: u32,
    pub width_in_blocks: u32,
    pub height_in_blocks: u32,
}

#[derive(Debug)]
pub(super) struct ScanParams<'jbrd> {
    pub si: &'jbrd ScanInfo,
    pub smi: &'jbrd ScanMoreInfo,
    /// Geometry of every JPEG component (indexed by the scan's `comp_idx`).
    pub comps: Vec<CompGeometry>,
    pub mcus_per_row: u32,
    pub mcu_rows: u32,
}

struct ScanState<'recon> {
    bit_writer: BitWriter,
    last_dc: [i16; 4],
    eob_run: u32,
    cur_ac_table: Option<&'recon BuiltHuffmanTable>,
    refinement_bits: Vec<(u64, u8)>,
    next_restart_marker: u8,
}

impl<'recon> ScanState<'recon> {
    fn new() -> Self {
        Self {
            bit_writer: BitWriter::new(),
            last_dc: [0; 4],
            eob_run: 0,
            cur_ac_table: None,
            refinement_bits: Vec::new(),
            next_restart_marker: 0,
        }
    }

    fn write_symbol(&mut self, table: &BuiltHuffmanTable, symbol: u8) -> Result<()> {
        let (len, bits) = table.lookup(symbol)?;
        self.bit_writer.write_huffman(bits, len);
        Ok(())
    }

    fn write_bits(&mut self, bits: u64, nbits: u32) {
        if nbits > 0 {
            self.bit_writer
                .write_raw(bits & ((1u64 << nbits) - 1), nbits as u8);
        }
    }

    /// libjxl `Flush`: emits the pending EOB run and the refinement bits buffered with it.
    fn flush(&mut self) -> Result<()> {
        if self.eob_run > 0 {
            let table = self.cur_ac_table.ok_or(Error::InvalidData)?;
            let nbits = 31 - self.eob_run.leading_zeros();
            self.write_symbol(table, (nbits << 4) as u8)?;
            self.write_bits(self.eob_run as u64, nbits);
            self.eob_run = 0;
        }
        for (bits, len) in std::mem::take(&mut self.refinement_bits) {
            self.write_bits(bits, len as u32);
        }
        Ok(())
    }

    /// libjxl `BufferEndOfBand`.
    fn buffer_end_of_band(
        &mut self,
        ac_table: &'recon BuiltHuffmanTable,
        new_bits: &[u8],
    ) -> Result<()> {
        if self.eob_run == 0 {
            self.cur_ac_table = Some(ac_table);
        }
        self.eob_run += 1;
        for chunk in new_bits.chunks(32) {
            let mut bits = 0u64;
            for &b in chunk {
                bits = (bits << 1) | b as u64;
            }
            self.refinement_bits.push((bits, chunk.len() as u8));
        }
        if self.eob_run == 0x7fff {
            self.flush()?;
        }
        Ok(())
    }

    /// libjxl `JumpToByteBoundary` followed by writing out the finished bytes.
    fn jump_to_byte_boundary(
        &mut self,
        padding_bitstream: Option<&mut Bitstream>,
        mut writer: impl Write,
    ) -> Result<()> {
        let mut bit_writer = std::mem::replace(&mut self.bit_writer, BitWriter::new());
        let n_bits = bit_writer.padding_bits();
        if n_bits != 0 {
            let pattern = if let Some(padding_bitstream) = padding_bitstream {
                // The stored padding bits are in bitstream order; the first one is the most
                // significant bit of the pattern.
                let mut pattern = 0u64;
                for _ in 0..n_bits {
                    let bit = padding_bitstream
                        .read_bits(1)
                        .map_err(|_| Error::InvalidData)?;
                    pattern = (pattern << 1) | bit as u64;
                }
                pattern
            } else {
                (1u64 << n_bits) - 1
            };
            bit_writer.write_raw(pattern, n_bits as u8);
        }
        writer
            .write_all(&bit_writer.finalize())
            .map_err(Error::ReconstructionWrite)
    }
}

/// Magnitude category and the raw bits JPEG writes for a (DC difference or AC) value.
#[inline]
fn value_bits(v: i32) -> (u32, u64) {
    let a = v.unsigned_abs();
    let nbits = 32 - a.leading_zeros();
    let bits = if v < 0 { (v - 1) as u32 } else { v as u32 };
    (nbits, bits as u64)
}

/// libjxl `EncodeDCTBlockSequential`. `z` is the block in zigzag order.
fn encode_block_sequential(
    state: &mut ScanState,
    z: &[i16; 64],
    dc_table: &BuiltHuffmanTable,
    ac_table: &BuiltHuffmanTable,
    num_zero_runs: u32,
    last_dc: &mut i16,
) -> Result<()> {
    let diff = z[0].wrapping_sub(*last_dc);
    *last_dc = z[0];
    let (nbits, bits) = value_bits(diff as i32);
    state.write_symbol(dc_table, nbits as u8)?;
    state.write_bits(bits, nbits);

    let mut r = 0i32;
    for &v in &z[1..] {
        if v == 0 {
            r += 1;
            continue;
        }
        while r > 15 {
            state.write_symbol(ac_table, 0xf0)?;
            r -= 16;
        }
        let (nbits, bits) = value_bits(v as i32);
        state.write_symbol(ac_table, ((r as u32) << 4 | nbits) as u8)?;
        state.write_bits(bits, nbits);
        r = 0;
    }
    for _ in 0..num_zero_runs {
        state.write_symbol(ac_table, 0xf0)?;
        r -= 16;
    }
    if r > 0 {
        state.write_symbol(ac_table, 0)?;
    }
    Ok(())
}

/// libjxl `EncodeDCTBlockProgressive` (first scan of a band, Ah = 0).
#[allow(clippy::too_many_arguments)]
fn encode_block_progressive<'recon>(
    state: &mut ScanState<'recon>,
    z: &[i16; 64],
    dc_table: &BuiltHuffmanTable,
    ac_table: &'recon BuiltHuffmanTable,
    mut ss: usize,
    se: usize,
    al: u32,
    num_zero_runs: u32,
    last_dc: &mut i16,
) -> Result<()> {
    let eob_run_allowed = ss > 0;
    if ss == 0 {
        let dc = z[0] >> al;
        let diff = dc.wrapping_sub(*last_dc);
        *last_dc = dc;
        let (nbits, bits) = value_bits(diff as i32);
        state.write_symbol(dc_table, nbits as u8)?;
        state.write_bits(bits, nbits);
        ss += 1;
    }
    if ss > se {
        return Ok(());
    }
    let mut r = 0i32;
    for &v in &z[ss..=se] {
        if v == 0 {
            r += 1;
            continue;
        }
        let a = (v as i32).unsigned_abs() >> al;
        if a == 0 {
            r += 1;
            continue;
        }
        let bits = if v < 0 { !a } else { a };
        state.flush()?;
        while r > 15 {
            state.write_symbol(ac_table, 0xf0)?;
            r -= 16;
        }
        let nbits = 32 - a.leading_zeros();
        state.write_symbol(ac_table, ((r as u32) << 4 | nbits) as u8)?;
        state.write_bits(bits as u64, nbits);
        r = 0;
    }
    if num_zero_runs > 0 {
        state.flush()?;
        for _ in 0..num_zero_runs {
            state.write_symbol(ac_table, 0xf0)?;
            r -= 16;
        }
    }
    if r > 0 {
        state.buffer_end_of_band(ac_table, &[])?;
        if !eob_run_allowed {
            state.flush()?;
        }
    }
    Ok(())
}

/// libjxl `EncodeRefinementBits` (Ah > 0). libjxl ignores extra zero runs here.
fn encode_block_refinement<'recon>(
    state: &mut ScanState<'recon>,
    z: &[i16; 64],
    ac_table: &'recon BuiltHuffmanTable,
    mut ss: usize,
    se: usize,
    al: u32,
) -> Result<()> {
    let eob_run_allowed = ss > 0;
    if ss == 0 {
        state.write_bits(((z[0] >> al) & 1) as u64, 1);
        ss += 1;
    }
    if ss > se {
        return Ok(());
    }
    let mut abs_values = [0u32; 64];
    let mut eob = 0usize;
    for k in ss..=se {
        abs_values[k] = (z[k] as i32).unsigned_abs() >> al;
        if abs_values[k] == 1 {
            eob = k;
        }
    }
    let mut r = 0i32;
    let mut refinement_bits = [0u8; 64];
    let mut refinement_bits_count = 0usize;
    for k in ss..=se {
        if abs_values[k] == 0 {
            r += 1;
            continue;
        }
        while r > 15 && k <= eob {
            state.flush()?;
            state.write_symbol(ac_table, 0xf0)?;
            r -= 16;
            for &bit in &refinement_bits[..refinement_bits_count] {
                state.write_bits(bit as u64, 1);
            }
            refinement_bits_count = 0;
        }
        if abs_values[k] > 1 {
            refinement_bits[refinement_bits_count] = (abs_values[k] & 1) as u8;
            refinement_bits_count += 1;
            continue;
        }
        state.flush()?;
        let new_non_zero_bit = if z[k] < 0 { 0 } else { 1 };
        state.write_symbol(ac_table, ((r as u32) << 4 | 1) as u8)?;
        state.write_bits(new_non_zero_bit, 1);
        for &bit in &refinement_bits[..refinement_bits_count] {
            state.write_bits(bit as u64, 1);
        }
        refinement_bits_count = 0;
        r = 0;
    }
    if r > 0 || refinement_bits_count > 0 {
        state.buffer_end_of_band(ac_table, &refinement_bits[..refinement_bits_count])?;
        if !eob_run_allowed {
            state.flush()?;
        }
    }
    Ok(())
}

/// Reads block (`bx`, `by`) of a JPEG component, in zigzag order, as libjxl's decoder stores
/// it in JPEGData.
fn read_block(
    frame_header: &jxl_frame::FrameHeader,
    parsed: &super::ParsedFrameData,
    g: &CompGeometry,
    bx: u32,
    by: u32,
    out: &mut [i16; 64],
) -> Result<()> {
    let group_dim = frame_header.group_dim();
    let px = (bx << g.hshift) * 8;
    let py = (by << g.vshift) * 8;
    let group_idx = frame_header
        .group_idx_from_coord(px, py)
        .ok_or(Error::InvalidData)?;
    let lf_group_idx = frame_header.lf_group_idx_from_group_idx(group_idx);

    // In this channel, a group spans group_dim >> shift samples, and an LF group
    // (8 groups across) group_dim >> shift blocks.
    let group_w = group_dim >> g.hshift;
    let group_h = group_dim >> g.vshift;
    let x_dc = (bx % group_w) as usize;
    let y_dc = (by % group_h) as usize;
    let x_ac = ((bx * 8) % group_w) as usize;
    let y_ac = ((by * 8) % group_h) as usize;

    let lf_quant = &parsed.lf_quant(lf_group_idx)[g.idx];
    let hf_coeff = parsed.hf_coeff(group_idx)[g.idx];
    if x_dc >= lf_quant.width()
        || y_dc >= lf_quant.height()
        || x_ac + 8 > hf_coeff.width()
        || y_ac + 8 > hf_coeff.height()
    {
        tracing::error!(bx, by, "JPEG block outside the JPEG XL frame data");
        return Err(Error::InvalidData);
    }

    let dc_offset = parsed.dc_offset[g.idx];
    out[0] = lf_quant
        .get(x_dc, y_dc)
        .saturating_sub(dc_offset)
        .clamp(-2047, 2047);
    for (k, &(x, y)) in jxl_vardct::DCT8_NATURAL_ORDER.iter().enumerate().skip(1) {
        out[k] = hf_coeff.get(x_ac + x as usize, y_ac + y as usize) as i16;
    }
    Ok(())
}

impl super::JpegBitstreamReconstructor<'_, '_, '_> {
    pub(super) fn process_scan(&mut self, params: ScanParams, mut writer: impl Write) -> Result<()> {
        let ScanParams {
            si,
            smi,
            comps,
            mcus_per_row,
            mcu_rows,
        } = params;

        // As libjxl: a sequential JPEG ignores the scan's spectral selection, and a
        // progressive scan covering everything at full precision is coded sequentially.
        let is_progressive = self.is_progressive;
        let (mut ss, mut se, mut ah, mut al) = if is_progressive {
            (si.ss as usize, si.se as usize, si.ah as u32, si.al as u32)
        } else {
            (0, 63, 0, 0)
        };
        let need_sequential = !is_progressive || (ah == 0 && al == 0 && ss == 0 && se == 63);
        if need_sequential {
            (ss, se, ah, al) = (0, 63, 0, 0);
        }
        if se > 63 {
            tracing::error!(se, "Invalid spectral selection");
            return Err(Error::InvalidData);
        }
        let mode = if need_sequential {
            0
        } else if ah == 0 {
            1
        } else {
            2
        };

        let is_interleaved = si.component_info.len() > 1;
        let restart_interval = self.restart_interval.unwrap_or(0);

        let mut scan_comps = Vec::with_capacity(si.component_info.len());
        for c in &si.component_info {
            let g = *comps.get(c.comp_idx as usize).ok_or(Error::InvalidData)?;
            let dc_table = self.dc_tables[c.dc_tbl_idx as usize]
                .as_ref()
                .unwrap_or(&huffman::EMPTY_TABLE);
            let ac_table = self.ac_tables[c.ac_tbl_idx as usize]
                .as_ref()
                .unwrap_or(&huffman::EMPTY_TABLE);
            scan_comps.push((c.comp_idx as usize & 3, g, dc_table, ac_table));
        }

        let frame_header = self.frame.header();
        let parsed = &self.parsed;
        let padding_bitstream = &mut self.padding_bitstream;

        let mut state = ScanState::new();
        let mut restarts_to_go = restart_interval;
        let mut block_scan_index = 0u32;
        let mut z = [0i16; 64];
        for mcu_y in 0..mcu_rows {
            for mcu_x in 0..mcus_per_row {
                if restart_interval > 0 && restarts_to_go == 0 {
                    state.flush()?;
                    state.jump_to_byte_boundary(padding_bitstream.as_mut(), &mut writer)?;
                    writer
                        .write_all(&[0xff, 0xd0 + state.next_restart_marker])
                        .map_err(Error::ReconstructionWrite)?;
                    state.next_restart_marker = (state.next_restart_marker + 1) & 7;
                    restarts_to_go = restart_interval;
                    state.last_dc = [0; 4];
                }

                for &(comp_idx, g, dc_table, ac_table) in &scan_comps {
                    let n_blocks_y = if is_interleaved { g.v_samp } else { 1 };
                    let n_blocks_x = if is_interleaved { g.h_samp } else { 1 };
                    for iy in 0..n_blocks_y {
                        for ix in 0..n_blocks_x {
                            let block_y = mcu_y * n_blocks_y + iy;
                            let block_x = mcu_x * n_blocks_x + ix;
                            if block_x >= g.width_in_blocks || block_y >= g.height_in_blocks {
                                tracing::error!(block_x, block_y, "JPEG block out of range");
                                return Err(Error::InvalidData);
                            }
                            if smi.reset_points.contains(&block_scan_index) {
                                state.flush()?;
                            }
                            let num_zero_runs = smi
                                .extra_zero_runs
                                .get(&block_scan_index)
                                .copied()
                                .unwrap_or(0);
                            read_block(frame_header, parsed, &g, block_x, block_y, &mut z)?;
                            let mut last_dc = state.last_dc[comp_idx];
                            match mode {
                                0 => encode_block_sequential(
                                    &mut state,
                                    &z,
                                    dc_table,
                                    ac_table,
                                    num_zero_runs,
                                    &mut last_dc,
                                )?,
                                1 => encode_block_progressive(
                                    &mut state,
                                    &z,
                                    dc_table,
                                    ac_table,
                                    ss,
                                    se,
                                    al,
                                    num_zero_runs,
                                    &mut last_dc,
                                )?,
                                _ => encode_block_refinement(&mut state, &z, ac_table, ss, se, al)?,
                            }
                            state.last_dc[comp_idx] = last_dc;
                            block_scan_index += 1;
                        }
                    }
                }
                restarts_to_go = restarts_to_go.wrapping_sub(1);
            }
        }
        state.flush()?;
        state.jump_to_byte_boundary(padding_bitstream.as_mut(), &mut writer)
    }
}
