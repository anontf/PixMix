// EXIF / TIFF tag names and types, for showing tags by name and for writing the ones a
// metadata policy sets. Only the value type and, where it is fixed, the count are needed:
// everything else is copied as it came. Tags not listed here are kept too, by number.

export const TYPES = {
  1: ['BYTE', 1], 2: ['ASCII', 1], 3: ['SHORT', 2], 4: ['LONG', 4], 5: ['RATIONAL', 8], 6: ['SBYTE', 1],
  7: ['UNDEFINED', 1], 8: ['SSHORT', 2], 9: ['SLONG', 4], 10: ['SRATIONAL', 8], 11: ['FLOAT', 4], 12: ['DOUBLE', 8],
  13: ['IFD', 4], 129: ['UTF-8', 1], // UTF-8 is EXIF 3.0
};
export const TYPE = Object.fromEntries(Object.entries(TYPES).map(([n, [name]]) => [name, Number(n)]));

// [tag, name, type, count?]. Types are what writers use; readers accept any.
const IFD0 = [
  [0x0100, 'ImageWidth', 'LONG', 1], [0x0101, 'ImageLength', 'LONG', 1], [0x0102, 'BitsPerSample', 'SHORT'],
  [0x0103, 'Compression', 'SHORT', 1], [0x0106, 'PhotometricInterpretation', 'SHORT', 1], [0x010d, 'DocumentName', 'ASCII'],
  [0x010e, 'ImageDescription', 'ASCII'], [0x010f, 'Make', 'ASCII'], [0x0110, 'Model', 'ASCII'], [0x0111, 'StripOffsets', 'LONG'],
  [0x0112, 'Orientation', 'SHORT', 1], [0x0115, 'SamplesPerPixel', 'SHORT', 1], [0x0116, 'RowsPerStrip', 'LONG', 1],
  [0x0117, 'StripByteCounts', 'LONG'], [0x011a, 'XResolution', 'RATIONAL', 1], [0x011b, 'YResolution', 'RATIONAL', 1],
  [0x011c, 'PlanarConfiguration', 'SHORT', 1], [0x0128, 'ResolutionUnit', 'SHORT', 1], [0x012d, 'TransferFunction', 'SHORT'],
  [0x0131, 'Software', 'ASCII'], [0x0132, 'DateTime', 'ASCII'], [0x013b, 'Artist', 'ASCII'], [0x013c, 'HostComputer', 'ASCII'],
  [0x013e, 'WhitePoint', 'RATIONAL', 2], [0x013f, 'PrimaryChromaticities', 'RATIONAL', 6], [0x0144, 'TileOffsets', 'LONG'],
  [0x0145, 'TileByteCounts', 'LONG'], [0x014a, 'SubIFDs', 'LONG'], [0x0201, 'JPEGInterchangeFormat', 'LONG', 1],
  [0x0202, 'JPEGInterchangeFormatLength', 'LONG', 1], [0x0211, 'YCbCrCoefficients', 'RATIONAL', 3],
  [0x0212, 'YCbCrSubSampling', 'SHORT', 2], [0x0213, 'YCbCrPositioning', 'SHORT', 1], [0x0214, 'ReferenceBlackWhite', 'RATIONAL', 6],
  [0x02bc, 'ApplicationNotes', 'BYTE'], [0x4746, 'Rating', 'SHORT', 1], [0x4749, 'RatingPercent', 'SHORT', 1],
  [0x8298, 'Copyright', 'ASCII'], [0x83bb, 'IPTC-NAA', 'LONG'], [0x8769, 'ExifIFDPointer', 'LONG', 1],
  [0x8773, 'InterColorProfile', 'UNDEFINED'], [0x8825, 'GPSInfoIFDPointer', 'LONG', 1], [0x9c9b, 'XPTitle', 'BYTE'],
  [0x9c9c, 'XPComment', 'BYTE'], [0x9c9d, 'XPAuthor', 'BYTE'], [0x9c9e, 'XPKeywords', 'BYTE'], [0x9c9f, 'XPSubject', 'BYTE'],
  [0xc4a5, 'PrintImageMatching', 'UNDEFINED'], [0xc612, 'DNGVersion', 'BYTE', 4], [0xc614, 'UniqueCameraModel', 'ASCII'],
  [0xc62f, 'CameraSerialNumber', 'ASCII'], [0xc634, 'DNGPrivateData', 'BYTE'], [0xea1c, 'Padding', 'UNDEFINED'],
  [0xea1d, 'OffsetSchema', 'SLONG', 1],
];
const EXIF = [
  [0x829a, 'ExposureTime', 'RATIONAL', 1], [0x829d, 'FNumber', 'RATIONAL', 1], [0x8822, 'ExposureProgram', 'SHORT', 1],
  [0x8824, 'SpectralSensitivity', 'ASCII'], [0x8827, 'ISOSpeedRatings', 'SHORT'], [0x8828, 'OECF', 'UNDEFINED'],
  [0x8830, 'SensitivityType', 'SHORT', 1], [0x8831, 'StandardOutputSensitivity', 'LONG', 1],
  [0x8832, 'RecommendedExposureIndex', 'LONG', 1], [0x8833, 'ISOSpeed', 'LONG', 1], [0x9000, 'ExifVersion', 'UNDEFINED', 4],
  [0x9003, 'DateTimeOriginal', 'ASCII', 20], [0x9004, 'DateTimeDigitized', 'ASCII', 20], [0x9010, 'OffsetTime', 'ASCII'],
  [0x9011, 'OffsetTimeOriginal', 'ASCII'], [0x9012, 'OffsetTimeDigitized', 'ASCII'], [0x9101, 'ComponentsConfiguration', 'UNDEFINED', 4],
  [0x9102, 'CompressedBitsPerPixel', 'RATIONAL', 1], [0x9201, 'ShutterSpeedValue', 'SRATIONAL', 1],
  [0x9202, 'ApertureValue', 'RATIONAL', 1], [0x9203, 'BrightnessValue', 'SRATIONAL', 1], [0x9204, 'ExposureBiasValue', 'SRATIONAL', 1],
  [0x9205, 'MaxApertureValue', 'RATIONAL', 1], [0x9206, 'SubjectDistance', 'RATIONAL', 1], [0x9207, 'MeteringMode', 'SHORT', 1],
  [0x9208, 'LightSource', 'SHORT', 1], [0x9209, 'Flash', 'SHORT', 1], [0x920a, 'FocalLength', 'RATIONAL', 1],
  [0x9214, 'SubjectArea', 'SHORT'], [0x927c, 'MakerNote', 'UNDEFINED'], [0x9286, 'UserComment', 'UNDEFINED'],
  [0x9290, 'SubSecTime', 'ASCII'], [0x9291, 'SubSecTimeOriginal', 'ASCII'], [0x9292, 'SubSecTimeDigitized', 'ASCII'],
  [0x9400, 'Temperature', 'SRATIONAL', 1], [0x9401, 'Humidity', 'RATIONAL', 1], [0x9402, 'Pressure', 'RATIONAL', 1],
  [0x9403, 'WaterDepth', 'SRATIONAL', 1], [0x9404, 'Acceleration', 'RATIONAL', 1], [0x9405, 'CameraElevationAngle', 'SRATIONAL', 1],
  [0xa000, 'FlashpixVersion', 'UNDEFINED', 4], [0xa001, 'ColorSpace', 'SHORT', 1], [0xa002, 'PixelXDimension', 'LONG', 1],
  [0xa003, 'PixelYDimension', 'LONG', 1], [0xa004, 'RelatedSoundFile', 'ASCII', 13], [0xa005, 'InteropIFDPointer', 'LONG', 1],
  [0xa20b, 'FlashEnergy', 'RATIONAL', 1], [0xa20e, 'FocalPlaneXResolution', 'RATIONAL', 1],
  [0xa20f, 'FocalPlaneYResolution', 'RATIONAL', 1], [0xa210, 'FocalPlaneResolutionUnit', 'SHORT', 1],
  [0xa214, 'SubjectLocation', 'SHORT', 2], [0xa215, 'ExposureIndex', 'RATIONAL', 1], [0xa217, 'SensingMethod', 'SHORT', 1],
  [0xa300, 'FileSource', 'UNDEFINED', 1], [0xa301, 'SceneType', 'UNDEFINED', 1], [0xa302, 'CFAPattern', 'UNDEFINED'],
  [0xa401, 'CustomRendered', 'SHORT', 1], [0xa402, 'ExposureMode', 'SHORT', 1], [0xa403, 'WhiteBalance', 'SHORT', 1],
  [0xa404, 'DigitalZoomRatio', 'RATIONAL', 1], [0xa405, 'FocalLengthIn35mmFilm', 'SHORT', 1], [0xa406, 'SceneCaptureType', 'SHORT', 1],
  [0xa407, 'GainControl', 'SHORT', 1], [0xa408, 'Contrast', 'SHORT', 1], [0xa409, 'Saturation', 'SHORT', 1],
  [0xa40a, 'Sharpness', 'SHORT', 1], [0xa40b, 'DeviceSettingDescription', 'UNDEFINED'], [0xa40c, 'SubjectDistanceRange', 'SHORT', 1],
  [0xa420, 'ImageUniqueID', 'ASCII', 33], [0xa430, 'CameraOwnerName', 'ASCII'], [0xa431, 'BodySerialNumber', 'ASCII'],
  [0xa432, 'LensSpecification', 'RATIONAL', 4], [0xa433, 'LensMake', 'ASCII'], [0xa434, 'LensModel', 'ASCII'],
  [0xa435, 'LensSerialNumber', 'ASCII'], [0xa436, 'ImageTitle', 'ASCII'], [0xa437, 'Photographer', 'ASCII'],
  [0xa438, 'ImageEditor', 'ASCII'], [0xa439, 'CameraFirmware', 'ASCII'], [0xa43a, 'RAWDevelopingSoftware', 'ASCII'],
  [0xa43b, 'ImageEditingSoftware', 'ASCII'], [0xa43c, 'MetadataEditingSoftware', 'ASCII'], [0xa460, 'CompositeImage', 'SHORT', 1],
  [0xa461, 'SourceImageNumberOfCompositeImage', 'SHORT', 2], [0xa462, 'SourceExposureTimesOfCompositeImage', 'UNDEFINED'],
  [0xa500, 'Gamma', 'RATIONAL', 1],
];
const GPS = [
  [0x00, 'GPSVersionID', 'BYTE', 4], [0x01, 'GPSLatitudeRef', 'ASCII', 2], [0x02, 'GPSLatitude', 'RATIONAL', 3],
  [0x03, 'GPSLongitudeRef', 'ASCII', 2], [0x04, 'GPSLongitude', 'RATIONAL', 3], [0x05, 'GPSAltitudeRef', 'BYTE', 1],
  [0x06, 'GPSAltitude', 'RATIONAL', 1], [0x07, 'GPSTimeStamp', 'RATIONAL', 3], [0x08, 'GPSSatellites', 'ASCII'],
  [0x09, 'GPSStatus', 'ASCII', 2], [0x0a, 'GPSMeasureMode', 'ASCII', 2], [0x0b, 'GPSDOP', 'RATIONAL', 1],
  [0x0c, 'GPSSpeedRef', 'ASCII', 2], [0x0d, 'GPSSpeed', 'RATIONAL', 1], [0x0e, 'GPSTrackRef', 'ASCII', 2],
  [0x0f, 'GPSTrack', 'RATIONAL', 1], [0x10, 'GPSImgDirectionRef', 'ASCII', 2], [0x11, 'GPSImgDirection', 'RATIONAL', 1],
  [0x12, 'GPSMapDatum', 'ASCII'], [0x13, 'GPSDestLatitudeRef', 'ASCII', 2], [0x14, 'GPSDestLatitude', 'RATIONAL', 3],
  [0x15, 'GPSDestLongitudeRef', 'ASCII', 2], [0x16, 'GPSDestLongitude', 'RATIONAL', 3], [0x17, 'GPSDestBearingRef', 'ASCII', 2],
  [0x18, 'GPSDestBearing', 'RATIONAL', 1], [0x19, 'GPSDestDistanceRef', 'ASCII', 2], [0x1a, 'GPSDestDistance', 'RATIONAL', 1],
  [0x1b, 'GPSProcessingMethod', 'UNDEFINED'], [0x1c, 'GPSAreaInformation', 'UNDEFINED'], [0x1d, 'GPSDateStamp', 'ASCII', 11],
  [0x1e, 'GPSDifferential', 'SHORT', 1], [0x1f, 'GPSHPositioningError', 'RATIONAL', 1],
];
const INTEROP = [
  [0x0001, 'InteropIndex', 'ASCII'], [0x0002, 'InteropVersion', 'UNDEFINED', 4], [0x1000, 'RelatedImageFileFormat', 'ASCII'],
  [0x1001, 'RelatedImageWidth', 'LONG', 1], [0x1002, 'RelatedImageLength', 'LONG', 1],
];

/** IFD names as pixmix reports them. IFD1 and SubIFDs use the IFD0 (TIFF) table. */
export const IFDS = ['IFD0', 'Exif', 'GPS', 'Interop', 'IFD1'];
const TABLES = { IFD0, Exif: EXIF, GPS, Interop: INTEROP };
const tableOf = (ifd) => TABLES[ifd] ?? IFD0;

const BY_TAG = Object.fromEntries(Object.entries(TABLES).map(([k, t]) => [k, new Map(t.map((d) => [d[0], d]))]));
const BY_NAME = new Map();
for (const [ifd, table] of Object.entries(TABLES)) for (const d of table) BY_NAME.set(d[1].toLowerCase(), { ifd, tag: d[0], name: d[1], type: d[2], count: d[3] });

/** @returns {{tag: number, name: string, type: string, count?: number}|null} */
export function tagInfo(ifd, tag) {
  const d = (BY_TAG[ifd] ?? BY_TAG.IFD0).get(tag) ?? null;
  return d && { tag: d[0], name: d[1], type: d[2], count: d[3] };
}

/** Name for display: the known name, or 0xNNNN. */
export const tagName = (ifd, tag) => tagInfo(ifd, tag)?.name ?? `0x${tag.toString(16).padStart(4, '0')}`;

/** A tag by name (case-insensitive), with the IFD it belongs in. */
export const tagByName = (name) => BY_NAME.get(String(name).toLowerCase()) ?? null;

// Structure, not metadata: sub-IFD pointers and the offsets of data they locate (thumbnail,
// strips, tiles). The writer rebuilds them; policies can neither set nor remove them.
export const POINTER_TAGS = { 0x8769: 'Exif', 0x8825: 'GPS', 0xa005: 'Interop' };
export const SUBIFDS_TAG = 0x014a;
export const OFFSET_PAIRS = [[0x0201, 0x0202], [0x0111, 0x0117], [0x0144, 0x0145]];
export const STRUCTURAL = new Set([0x8769, 0x8825, 0xa005, 0x014a, 0x0201, 0x0202, 0x0111, 0x0117, 0x0144, 0x0145]);
export const MAKER_NOTE = 0x927c;

// Textual UNDEFINED tags (version numbers are 4 ASCII digits).
export const VERSION_TAGS = new Set([0x9000, 0xa000, 0x0002]);
// Windows' XP* tags: UCS-2 little-endian text in a BYTE array.
export const XP_TAGS = new Set([0x9c9b, 0x9c9c, 0x9c9d, 0x9c9e, 0x9c9f]);

export { tableOf };
