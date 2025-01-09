import type { VideoTrackMetadata } from '../../../ExpoVideoMetadata.types'
import { getDefaultColorInfo } from './color-utils'

/**
 * Parses an MPEG-2 sequence header to extract video metadata.
 * Implementation follows ISO/IEC 13818-2 specification for sequence header syntax.
 *
 * The sequence header contains essential video parameters including:
 * - Frame dimensions (horizontal and vertical size)
 * - Display aspect ratio (4:3, 16:9, etc.)
 * - Frame rate (23.976, 24, 25, 29.97, etc.)
 * - Bit rate and buffer size constraints
 * - Optional quantization matrices
 *
 * Note: The sequence header is identified by start code 0x000001B3 as defined
 * in ISO/IEC 13818-2 section 6.2.1
 *
 * @param seqHeader The sequence header data starting with the start code (0x000001B3)
 * @returns VideoTrackMetadata object containing the parsed information
 */
export function parseMPEG2SequenceHeader(seqHeader: Uint8Array): VideoTrackMetadata {
  // Skip start code (4 bytes: 00 00 01 B3)
  const data = seqHeader.slice(4)

  // MPEG-2 sequence header format (ISO/IEC 13818-2 section 6.2.2.1):
  // 12 bits - horizontal_size_value    : Frame width in pixels
  // 12 bits - vertical_size_value      : Frame height in pixels
  //  4 bits - aspect_ratio_information : Display aspect ratio code (Table 6-3)
  //  4 bits - frame_rate_code          : Frame rate code (Table 6-4)
  // 18 bits - bit_rate_value          : Bit rate in units of 400 bits/sec
  //  1 bit  - marker_bit              : Always 1 for byte alignment
  // 10 bits - vbv_buffer_size_value   : Video buffer size in units of 16768 bits
  //  1 bit  - constrained_parameters_flag : Indicates constrained bitstream
  //  1 bit  - load_intra_quantiser_matrix : Presence of custom quant matrix
  // ...

  // Read dimensions (12 bits each)
  // Width: 8 bits from first byte + upper 4 bits from second byte
  // Height: lower 4 bits from second byte + 8 bits from third byte
  const width = (data[0] << 4) | ((data[1] & 0xf0) >> 4)
  const height = ((data[1] & 0x0f) << 8) | data[2]

  // Read aspect ratio code (4 bits) and frame rate code (4 bits)
  // Both codes are packed into the fourth byte (data[3])
  const aspectRatioCode = (data[3] >> 4) & 0x0f
  const frameRateCode = data[3] & 0x0f

  // Map frame rate code to actual frame rate
  // According to ISO/IEC 13818-2 Table 6-4
  // Note: NTSC rates use 1000/1001 factor for historical compatibility
  const frameRates = [
    0, // 0 - forbidden
    24000 / 1001, // 1 - 23.976 fps (exact: 24 * 1000/1001)
    24, // 2 - 24 fps (film)
    25, // 3 - 25 fps (PAL/SECAM video)
    30000 / 1001, // 4 - 29.97 fps (NTSC video)
    30, // 5 - 30 fps
    50, // 6 - 50 fps (high-frame-rate PAL)
    60000 / 1001, // 7 - 59.94 fps (high-frame-rate NTSC)
    60, // 8 - 60 fps
    // 9-15 reserved
  ]

  const fps = frameRateCode < frameRates.length ? frameRates[frameRateCode] : 0

  // Map aspect ratio code to pixel aspect ratio (PAR)
  // According to ISO/IEC 13818-2 Table 6-3
  // PAR is calculated to maintain correct display aspect ratio (DAR)
  // Formula: DAR = (width * PAR_width) / (height * PAR_height)
  let pixelAspectRatioWidth = 1
  let pixelAspectRatioHeight = 1

  switch (aspectRatioCode) {
    case 2: // 4:3 Display AR
      // For 4:3 DAR: width * parW / (height * parH) = 4/3
      // Solving for PAR: parW/parH = 4*height/(3*width)
      pixelAspectRatioWidth = 4 * height
      pixelAspectRatioHeight = 3 * width
      break
    case 3: // 16:9 Display AR
      // For 16:9 DAR: width * parW / (height * parH) = 16/9
      pixelAspectRatioWidth = 16 * height
      pixelAspectRatioHeight = 9 * width
      break
    case 4: // 2.21:1 Display AR
      // For 2.21:1 DAR: width * parW / (height * parH) = 221/100
      pixelAspectRatioWidth = 221 * height
      pixelAspectRatioHeight = 100 * width
      break
    // case 1 is square pixels (1:1)
    default:
      // Keep default 1:1 PAR
      break
  }

  // Simplify the PAR fraction
  // Uses Euclidean algorithm to find greatest common divisor
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  const parGcd = gcd(pixelAspectRatioWidth, pixelAspectRatioHeight)
  pixelAspectRatioWidth = pixelAspectRatioWidth / parGcd
  pixelAspectRatioHeight = pixelAspectRatioHeight / parGcd

  // Calculate display dimensions by applying PAR
  const displayWidth = Math.round(width * (pixelAspectRatioWidth / pixelAspectRatioHeight))
  const displayHeight = height

  // MPEG-2 elementary streams do not contain rotation metadata
  // Rotation is typically handled at the container/presentation level
  // For TS files, we always return 0 as there's no standard way to store rotation
  return {
    width,
    height,
    rotation: 0,
    displayAspectWidth: width,
    displayAspectHeight: height,
    codec: 'mp2v',
    colorInfo: getDefaultColorInfo(),
    fps,
  }
}
