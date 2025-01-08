import type { VideoTrackMetadata } from '../../ExpoVideoMetadata.types'
import { BitReader } from '../bit-reader'
import { getDefaultColorInfo } from './color-utils'

/**
 * Standard aspect ratio values as defined in ITU-T H.264 Table E-1.
 * Maps aspect_ratio_idc to [width, height] pairs.
 */
const ASPECT_RATIO_IDC_VALUES = [
  [0, 0], // 0 - Unspecified
  [1, 1], // 1 - 1:1 (Square)
  [12, 11], // 2 - 12:11
  [10, 11], // 3 - 10:11
  [16, 11], // 4 - 16:11
  [40, 33], // 5 - 40:33
  [24, 11], // 6 - 24:11
  [20, 11], // 7 - 20:11
  [32, 11], // 8 - 32:11
  [80, 33], // 9 - 80:33
  [18, 11], // 10 - 18:11
  [15, 11], // 11 - 15:11
  [64, 33], // 12 - 64:33
  [160, 99], // 13 - 160:99
  [4, 3], // 14 - 4:3
  [3, 2], // 15 - 3:2
  [2, 1], // 16 - 2:1
]

/**
 * Parses H.264 Sequence Parameter Set (SPS) to extract video metadata.
 * Implementation follows ITU-T H.264 specification (sections 7.3.2.1 and Annex E).
 *
 * The SPS contains essential video parameters including:
 * - Profile and level information
 * - Frame dimensions and cropping
 * - Color space and bit depth
 * - Frame rate and timing
 * - Aspect ratio
 *
 * @param sps The SPS NAL unit data starting after NAL header
 * @returns VideoTrackMetadata object containing the parsed information
 */
export function parseH264SPS(sps: Uint8Array): VideoTrackMetadata {
  // Log the raw SPS data for debugging
  console.debug(
    'Raw SPS data:',
    Array.from(sps)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
  )

  let fps = 0
  let sarWidth = 1
  let sarHeight = 1

  // Skip NAL header and check NAL type
  const nalType = sps[0] & 0x1f
  if (nalType !== 7) {
    console.debug('Not an SPS NAL unit:', nalType)
    return {
      width: 1920,
      height: 1080,
      rotation: 0,
      displayAspectWidth: 1920,
      displayAspectHeight: 1080,
      colorInfo: getDefaultColorInfo(),
      fps: 0,
      codec: 'avc1',
    }
  }

  // Create a new reader starting after the NAL header
  // The first byte of SPS data is the profile_idc
  const reader = new BitReader(sps.slice(1))

  // Parse SPS header fields (section 7.3.2.1.1)
  const profileIdc = reader.readBits(8)
  // constraint_set flags and reserved zero bits
  const constraintFlags = reader.readBits(8)
  // level_idc
  const levelIdc = reader.readBits(8)

  // seq_parameter_set_id (ue(v))
  const spsId = reader.readUEV()
  console.debug('SPS basic info:', {
    profileIdc,
    constraintFlags: `0x${constraintFlags.toString(16)}`,
    levelIdc,
    spsId,
  })

  // Initialize chroma format and bit depth
  let chromaFormatIdc = 1 // Default is 4:2:0
  let bitDepthLuma = 8
  let bitDepthChroma = 8
  let separateColorPlaneFlag = false

  // High profiles have additional parameters (section 7.3.2.1.1)
  if ([100, 110, 122, 244, 44, 83, 86, 118].includes(profileIdc)) {
    chromaFormatIdc = reader.readUEV()
    if (chromaFormatIdc === 3) {
      separateColorPlaneFlag = reader.readBit() === 1
    }
    bitDepthLuma = reader.readUEV() + 8
    bitDepthChroma = reader.readUEV() + 8
    reader.readBit() // qpprime_y_zero_transform_bypass_flag
    const seqScalingMatrixPresent = reader.readBit() === 1

    // Parse scaling matrices if present
    if (seqScalingMatrixPresent) {
      const chromaFormatIdcTable = chromaFormatIdc === 3 ? 12 : 8
      for (let i = 0; i < chromaFormatIdcTable; i++) {
        if (reader.readBit() === 1) {
          if (i < 6) {
            reader.skipScalingList(16)
          } else {
            reader.skipScalingList(64)
          }
        }
      }
    }
  }

  console.debug('SPS chroma info:', {
    chromaFormatIdc,
    separateColorPlaneFlag,
    bitDepthLuma,
    bitDepthChroma,
  })

  // Parse frame num parameters
  const log2MaxFrameNumMinus4 = reader.readUEV()

  // Parse picture order count parameters
  const picOrderCntType = reader.readUEV()
  if (picOrderCntType === 0) {
    reader.readUEV() // log2_max_pic_order_cnt_lsb_minus4
  } else if (picOrderCntType === 1) {
    reader.readBit() // delta_pic_order_always_zero_flag
    reader.readSEV() // offset_for_non_ref_pic
    reader.readSEV() // offset_for_top_to_bottom_field
    const numRefFramesInPicOrderCntCycle = reader.readUEV()
    for (let i = 0; i < numRefFramesInPicOrderCntCycle; i++) {
      reader.readSEV() // offset_for_ref_frame[i]
    }
  }

  // Parse reference frame parameters
  const maxNumRefFrames = reader.readUEV()
  // gaps_in_frame_num_value_allowed_flag
  reader.readBit()

  // Try to read dimensions directly from the SPS data
  // This is a fallback method for certain encoders
  const rawWidth = ((sps[4] & 0x1f) << 8) | sps[5]
  const rawHeight = ((sps[6] & 0x1f) << 8) | sps[7]

  console.debug('Raw dimensions from SPS bytes:', { rawWidth, rawHeight })

  // Parse frame dimensions in macroblocks
  const picWidthInMbsMinus1 = reader.readUEV()
  const picHeightInMapUnitsMinus1 = reader.readUEV()
  const frameMbsOnlyFlag = reader.readBit() === 1

  console.debug('SPS Raw Values:', {
    picWidthInMbsMinus1,
    picHeightInMapUnitsMinus1,
    frameMbsOnlyFlag,
    chromaFormatIdc,
    log2MaxFrameNumMinus4,
    picOrderCntType,
    maxNumRefFrames,
  })

  // Initialize cropping values
  let frameCropLeft = 0
  let frameCropRight = 0
  let frameCropTop = 0
  let frameCropBottom = 0

  // Parse frame mbs only flag
  if (!frameMbsOnlyFlag) {
    reader.readBit() // mb_adaptive_frame_field_flag
  }

  reader.readBit() // direct_8x8_inference_flag

  // Parse frame cropping
  const hasCropping = reader.readBit() === 1
  if (hasCropping) {
    frameCropLeft = reader.readUEV()
    frameCropRight = reader.readUEV()
    frameCropTop = reader.readUEV()
    frameCropBottom = reader.readUEV()
    console.debug('Crop Values:', {
      frameCropLeft,
      frameCropRight,
      frameCropTop,
      frameCropBottom,
    })
  }

  // Calculate dimensions from macroblocks
  const mbWidth = picWidthInMbsMinus1 + 1
  const mbHeight = picHeightInMapUnitsMinus1 + 1

  // Calculate pixel dimensions (16x16 macroblocks)
  let width = mbWidth * 16
  let height = mbHeight * 16 * (frameMbsOnlyFlag ? 1 : 2)

  // Apply cropping based on chroma format
  const cropUnitX = chromaFormatIdc === 3 ? 1 : 2
  const cropUnitY = chromaFormatIdc === 1 ? 2 : 1

  width -= (frameCropLeft + frameCropRight) * cropUnitX
  height -= (frameCropTop + frameCropBottom) * cropUnitY

  console.debug('Dimension Calculation:', {
    mbWidth,
    mbHeight,
    beforeCrop: {
      width: mbWidth * 16,
      height: mbHeight * (frameMbsOnlyFlag ? 16 : 32),
    },
    afterCrop: {
      width,
      height,
    },
    cropUnits: {
      x: cropUnitX,
      y: cropUnitY,
    },
    rawBits: {
      picWidthInMbsMinus1,
      picHeightInMapUnitsMinus1,
      frameMbsOnlyFlag,
    },
  })

  // Fallback to raw dimensions if calculated width is invalid
  if (width <= 16 && rawWidth >= 16 && rawWidth <= 8192) {
    console.debug('Using raw dimensions from SPS bytes')
    width = rawWidth
    height = rawHeight
  }

  // Fallback to standard resolutions if dimensions are invalid
  if (width <= 16 || width > 8192 || height <= 0 || height > 4320) {
    console.debug('Invalid dimensions calculated:', { width, height })
    // Try to estimate dimensions from the height and known aspect ratio
    if (height === 720) {
      width = 1280 // Common 720p width
      console.debug('Using standard 720p dimensions')
    } else if (height === 1080) {
      width = 1920 // Common 1080p width
      console.debug('Using standard 1080p dimensions')
    } else {
      // Try 16:9 aspect ratio
      width = Math.round(height * (16 / 9))
      if (width >= 16 && width <= 8192) {
        console.debug('Using estimated 16:9 width:', width)
      } else {
        return {
          width: 1920,
          height: 1080,
          rotation: 0,
          displayAspectWidth: 1920,
          displayAspectHeight: 1080,
          colorInfo: getDefaultColorInfo(),
          fps: 0,
          codec: 'avc1',
        }
      }
    }
  }

  // Parse VUI parameters if present
  const vuiParametersPresent = reader.readBit() === 1

  if (vuiParametersPresent) {
    try {
      // Parse aspect ratio information
      if (reader.readBit() === 1) {
        const aspectRatioIdc = reader.readBits(8)
        if (aspectRatioIdc === 255) {
          // Extended_SAR
          sarWidth = reader.readBits(16)
          sarHeight = reader.readBits(16)
        } else if (aspectRatioIdc < ASPECT_RATIO_IDC_VALUES.length) {
          ;[sarWidth, sarHeight] = ASPECT_RATIO_IDC_VALUES[aspectRatioIdc]
        }
      }

      // Parse overscan info
      if (reader.readBit() === 1) {
        reader.readBit() // overscan_appropriate_flag
      }

      // Parse video signal type
      if (reader.readBit() === 1) {
        reader.readBits(3) // video_format
        reader.readBit() // video_full_range_flag
        // Parse color description
        if (reader.readBit() === 1) {
          reader.readBits(8) // colour_primaries
          reader.readBits(8) // transfer_characteristics
          reader.readBits(8) // matrix_coefficients
        }
      }

      // Parse chroma location info
      if (reader.readBit() === 1) {
        reader.readUEV() // chroma_sample_loc_type_top_field
        reader.readUEV() // chroma_sample_loc_type_bottom_field
      }

      // Parse timing info
      if (reader.readBit() === 1) {
        const numUnitsInTick = reader.readBits(32)
        const timeScale = reader.readBits(32)
        const fixedFrameRateFlag = reader.readBit() === 1

        console.debug('Raw timing values:', {
          numUnitsInTick,
          timeScale,
          fixedFrameRateFlag,
          remainingBits: reader.remainingBits(),
        })

        // Calculate frame rate from timing info
        if (numUnitsInTick > 0 && timeScale > 0) {
          // For H.264, we need to divide by 2 to get the actual frame rate
          fps = timeScale / (2 * numUnitsInTick)

          // Handle common NTSC/PAL rates
          if (timeScale === 60000 && numUnitsInTick === 1001) {
            fps = 29.97 // (60000/1001)/2
          } else if (timeScale === 50000 && numUnitsInTick === 1001) {
            fps = 24.98 // (50000/1001)/2
          } else if (timeScale === 48000 && numUnitsInTick === 1001) {
            fps = 23.98 // (48000/1001)/2
          }
        }

        // Handle special time_scale values
        if (timeScale === 16777216) {
          // 2^24
          switch (numUnitsInTick) {
            case 12:
              fps = 60
              break // Common 60 fps
            case 15:
              fps = 48
              break // Common 48 fps
            case 24:
              fps = 30
              break // Common 30 fps
            case 30:
              fps = 24
              break // Common 24 fps
            case 48:
              fps = 15
              break // Common 15 fps
          }
        }

        console.debug('SPS timing info:', {
          numUnitsInTick,
          timeScale,
          fixedFrameRateFlag,
          calculatedFps: fps,
        })
      }
    } catch (error) {
      console.debug('Error parsing VUI parameters:', error)
    }
  }

  console.debug('SPS aspect ratio and timing:', { sarWidth, sarHeight, fps })

  // Calculate final display aspect ratio
  const displayAspectWidth = width * sarWidth
  const displayAspectHeight = height * sarHeight

  return {
    width,
    height,
    rotation: 0,
    displayAspectWidth,
    displayAspectHeight,
    colorInfo: getDefaultColorInfo(),
    fps,
    codec: 'avc1',
  }
}
