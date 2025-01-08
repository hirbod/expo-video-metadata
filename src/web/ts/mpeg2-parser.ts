import type { VideoTrackMetadata } from '../../ExpoVideoMetadata.types'
import { getDefaultColorInfo } from './color-utils'

/**
 * Parses an MPEG-2 sequence header to extract video metadata.
 * @param seqHeader The sequence header data starting with the start code (0x000001B3)
 * @returns VideoTrackMetadata object containing the parsed information
 */
export function parseMPEG2SequenceHeader(seqHeader: Uint8Array): VideoTrackMetadata {
  // Skip start code (4 bytes: 00 00 01 B3)
  const data = seqHeader.slice(4)

  // MPEG-2 sequence header format:
  // 12 bits - horizontal_size_value
  // 12 bits - vertical_size_value
  //  4 bits - aspect_ratio_information
  //  4 bits - frame_rate_code
  // 18 bits - bit_rate_value
  //  1 bit  - marker_bit
  // 10 bits - vbv_buffer_size_value
  //  1 bit  - constrained_parameters_flag
  //  1 bit  - load_intra_quantiser_matrix
  // ...

  // Read dimensions (12 bits each)
  const width = (data[0] << 4) | ((data[1] & 0xf0) >> 4)
  const height = ((data[1] & 0x0f) << 8) | data[2]

  // Read aspect ratio code (4 bits) and frame rate code (4 bits)
  const aspectRatioCode = (data[3] >> 4) & 0x0f
  const frameRateCode = data[3] & 0x0f

  // Map frame rate code to actual frame rate
  // According to ISO/IEC 13818-2 Table 6-4
  const frameRates = [
    0, // 0 - forbidden
    24000 / 1001, // 1 - 23.976 fps
    24, // 2 - 24 fps
    25, // 3 - 25 fps
    30000 / 1001, // 4 - 29.97 fps
    30, // 5 - 30 fps
    50, // 6 - 50 fps
    60000 / 1001, // 7 - 59.94 fps
    60, // 8 - 60 fps
    // 9-15 reserved
  ]

  const fps = frameRateCode < frameRates.length ? frameRates[frameRateCode] : 0

  // Map aspect ratio code to pixel aspect ratio (PAR)
  // According to ISO/IEC 13818-2 Table 6-3
  let pixelAspectRatioWidth = 1
  let pixelAspectRatioHeight = 1

  switch (aspectRatioCode) {
    case 2: // 4:3 Display AR
      pixelAspectRatioWidth = 4 * height
      pixelAspectRatioHeight = 3 * width
      break
    case 3: // 16:9 Display AR
      pixelAspectRatioWidth = 16 * height
      pixelAspectRatioHeight = 9 * width
      break
    case 4: // 2.21:1 Display AR
      pixelAspectRatioWidth = 221 * height
      pixelAspectRatioHeight = 100 * width
      break
    // case 1 is square pixels (1:1)
    default:
      // Keep default 1:1 PAR
      break
  }

  // Simplify the PAR fraction
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
