import type { VideoColorInfo, VideoTrackMetadata } from '../../ExpoVideoMetadata.types'
import { BitReader } from '../bit-reader'
import {
  getDefaultColorInfo,
  mapColorPrimaries,
  mapMatrixCoefficients,
  mapTransferCharacteristics,
} from './color-utils'

/**
 * Parses HEVC (H.265) Sequence Parameter Set (SPS) to extract video metadata.
 * Implementation follows ITU-T H.265 specification (sections 7.3.2.2 and Annex E).
 *
 * The SPS contains essential video parameters including:
 * - Profile, tier, and level information
 * - Frame dimensions and conformance window
 * - Color space and bit depth
 * - Frame rate and timing
 * - Aspect ratio
 *
 * HEVC NAL unit header structure (2 bytes):
 * Byte 1: forbidden_zero_bit (1) + nal_unit_type (6) + nuh_layer_id (6)
 * Byte 2: nuh_temporal_id_plus1 (3) + reserved_zero_5bits (5)
 *
 * @param sps The SPS NAL unit data including NAL header
 * @returns VideoTrackMetadata object containing the parsed information
 */
export function parseHEVCSPS(sps: Uint8Array): VideoTrackMetadata {
  // Log the raw SPS data for debugging
  console.debug(
    'Raw HEVC SPS data:',
    Array.from(sps)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
  )

  // Create a bit reader starting after the NAL header
  // For HEVC, first byte contains:
  // forbidden_zero_bit (1) + nal_unit_type (6) + nuh_layer_id (6)
  // Second byte contains:
  // nuh_temporal_id_plus1 (3) + reserved_zero_5bits (5)
  const reader = new BitReader(sps.slice(2))

  // Parse SPS header fields (section 7.3.2.2.1)
  const vpsId = reader.readBits(4) // sps_video_parameter_set_id
  const maxSubLayersMinus1 = reader.readBits(3) // sps_max_sub_layers_minus1
  const temporalIdNestingFlag = reader.readBit() // sps_temporal_id_nesting_flag

  console.debug('HEVC SPS header:', {
    vpsId,
    maxSubLayersMinus1,
    temporalIdNestingFlag,
    remainingBits: reader.remainingBits(),
    currentByte: reader.currentByte().toString(16),
  })

  // Parse profile, tier, and level information
  parseProfileTierLevel(reader, maxSubLayersMinus1)

  console.debug('After profile_tier_level:', {
    remainingBits: reader.remainingBits(),
    currentByte: reader.currentByte().toString(16),
  })

  // Parse sequence parameter set ID
  const spsId = reader.readUEV() // sps_seq_parameter_set_id
  console.debug('SPS ID:', spsId, {
    remainingBits: reader.remainingBits(),
    currentByte: reader.currentByte().toString(16),
  })

  // Parse chroma format information
  const chromaFormatIdc = reader.readUEV() // chroma_format_idc
  let separateColourPlaneFlag = false
  if (chromaFormatIdc === 3) {
    // separate_colour_plane_flag
    separateColourPlaneFlag = reader.readBit() === 1
  }

  // Parse frame dimensions in luma samples
  const width = reader.readUEV() // pic_width_in_luma_samples
  const height = reader.readUEV() // pic_height_in_luma_samples

  console.debug('HEVC dimensions:', {
    width,
    height,
    chromaFormatIdc,
    separateColourPlaneFlag,
    remainingBits: reader.remainingBits(),
    currentByte: reader.currentByte().toString(16),
  })

  // Parse conformance window parameters
  const conformanceWindowFlag = reader.readBit() === 1 // conformance_window_flag
  let confWinLeft = 0
  let confWinRight = 0
  let confWinTop = 0
  let confWinBottom = 0

  if (conformanceWindowFlag) {
    confWinLeft = reader.readUEV() // conf_win_left_offset
    confWinRight = reader.readUEV() // conf_win_right_offset
    confWinTop = reader.readUEV() // conf_win_top_offset
    confWinBottom = reader.readUEV() // conf_win_bottom_offset
    console.debug('HEVC conformance window:', {
      left: confWinLeft,
      right: confWinRight,
      top: confWinTop,
      bottom: confWinBottom,
    })
  }

  // Parse bit depth information
  const bitDepthLuma = reader.readUEV() + 8 // bit_depth_luma_minus8
  const bitDepthChroma = reader.readUEV() + 8 // bit_depth_chroma_minus8

  console.debug('HEVC bit depth:', {
    luma: bitDepthLuma,
    chroma: bitDepthChroma,
    remainingBits: reader.remainingBits(),
    currentByte: reader.currentByte().toString(16),
  })

  // Parse picture order count parameters
  const log2MaxPicOrderCntLsbMinus4 = reader.readUEV() // log2_max_pic_order_cnt_lsb_minus4
  console.debug('log2_max_pic_order_cnt_lsb_minus4:', log2MaxPicOrderCntLsbMinus4)

  // Parse sub-layer ordering info
  const subLayerOrderingInfoPresentFlag = reader.readBit() === 1 // sps_sub_layer_ordering_info_present_flag
  console.debug('sps_sub_layer_ordering_info_present_flag:', subLayerOrderingInfoPresentFlag)

  // Parse sub-layer ordering parameters
  const startLayer = subLayerOrderingInfoPresentFlag ? 0 : maxSubLayersMinus1
  for (let i = startLayer; i <= maxSubLayersMinus1; i++) {
    reader.readUEV() // sps_max_dec_pic_buffering_minus1
    reader.readUEV() // sps_max_num_reorder_pics
    reader.readUEV() // sps_max_latency_increase_plus1
  }

  // Parse coding tree unit (CTU) and transform unit (TU) parameters
  reader.readUEV() // log2_min_luma_coding_block_size_minus3
  reader.readUEV() // log2_diff_max_min_luma_coding_block_size
  reader.readUEV() // log2_min_luma_transform_block_size_minus2
  reader.readUEV() // log2_diff_max_min_luma_transform_block_size
  reader.readUEV() // max_transform_hierarchy_depth_inter
  reader.readUEV() // max_transform_hierarchy_depth_intra

  // Calculate final dimensions considering conformance window
  let finalWidth = width
  let finalHeight = height

  if (conformanceWindowFlag) {
    // Apply conformance window cropping
    // The formula depends on chroma format
    const subWidthC = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1
    const subHeightC = chromaFormatIdc === 1 ? 2 : 1

    finalWidth -= (confWinLeft + confWinRight) * subWidthC
    finalHeight -= (confWinTop + confWinBottom) * subHeightC
  }

  // Initialize color info and frame rate
  let colorInfo = getDefaultColorInfo()
  let fps = 0

  // Parse scaling list parameters
  const scalingListEnabledFlag = reader.readBit() === 1 // scaling_list_enabled_flag
  if (scalingListEnabledFlag) {
    // sps_scaling_list_data_present_flag
    if (reader.readBit() === 1) {
      // Skip scaling list data
      skipScalingListData(reader)
    }
  }

  // Parse additional coding parameters
  reader.readBit() // amp_enabled_flag
  reader.readBit() // sample_adaptive_offset_enabled_flag

  // Parse PCM (Pulse Code Modulation) parameters
  if (reader.readBit() === 1) {
    // pcm_enabled_flag
    reader.readBits(4) // pcm_sample_bit_depth_luma_minus1
    reader.readBits(4) // pcm_sample_bit_depth_chroma_minus1
    reader.readUEV() // log2_min_pcm_luma_coding_block_size_minus3
    reader.readUEV() // log2_diff_max_min_pcm_luma_coding_block_size
    reader.readBit() // pcm_loop_filter_disabled_flag
  }

  // Parse reference picture set parameters
  const numShortTermRefPicSets = reader.readUEV() // num_short_term_ref_pic_sets
  // Skip short term ref pic sets
  for (let i = 0; i < numShortTermRefPicSets; i++) {
    skipShortTermRefPicSet(reader, i, numShortTermRefPicSets)
  }

  // Parse long-term reference picture parameters
  if (reader.readBit() === 1) {
    // long_term_ref_pics_present_flag
    const numLongTermRefPicsSps = reader.readUEV() // num_long_term_ref_pics_sps
    for (let i = 0; i < numLongTermRefPicsSps; i++) {
      // Skip lt_ref_pic_poc_lsb_sps and used_by_curr_pic_lt_sps_flag
      reader.readBits(log2MaxPicOrderCntLsbMinus4 + 4)
      reader.readBit()
    }
  }

  // Parse temporal motion vector prediction and intra smoothing flags
  reader.readBit() // sps_temporal_mvp_enabled_flag
  reader.readBit() // strong_intra_smoothing_enabled_flag

  // Parse VUI parameters if present
  const vuiParametersPresent = reader.readBit() === 1 // vui_parameters_present_flag
  console.debug('VUI parameters present flag:', vuiParametersPresent, {
    remainingBits: reader.remainingBits(),
    currentByte: reader.currentByte().toString(16),
    nextBytes: Array.from(sps.slice(reader.currentPosition(), reader.currentPosition() + 4))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' '),
  })

  if (vuiParametersPresent) {
    const vuiParams = parseHEVCVUIParameters(reader)
    colorInfo = {
      matrixCoefficients: vuiParams.matrixCoefficients,
      transferCharacteristics: vuiParams.transferCharacteristics,
      primaries: vuiParams.primaries,
      fullRange: vuiParams.fullRange,
    }
    fps = vuiParams.fps || 0
  }

  console.debug('Final HEVC SPS parsing results:', {
    dimensions: `${finalWidth}x${finalHeight}`,
    fps,
    colorInfo,
    remainingBits: reader.remainingBits(),
  })

  return {
    width: finalWidth,
    height: finalHeight,
    rotation: 0,
    displayAspectWidth: finalWidth,
    displayAspectHeight: finalHeight,
    colorInfo,
    fps,
    codec: 'hev1',
  }
}

/**
 * Skips scaling list data in HEVC SPS.
 * Scaling lists are used for transform coefficient scaling.
 * Implementation follows ITU-T H.265 section 7.3.4.
 *
 * @param reader BitReader positioned at start of scaling list data
 */
function skipScalingListData(reader: BitReader): void {
  for (let sizeId = 0; sizeId < 4; sizeId++) {
    for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
      if (reader.readBit() === 0) continue // scaling_list_pred_mode_flag
      // scaling_list_pred_matrix_id_delta
      reader.readUEV()
      const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)))
      if (sizeId > 1) {
        reader.readSEV() // scaling_list_dc_coef_minus8
      }
      for (let i = 0; i < coefNum; i++) {
        reader.readSEV() // scaling_list_delta_coef
      }
    }
  }
}

/**
 * Skips short-term reference picture set data in HEVC SPS.
 * Reference picture sets define which pictures are used for inter prediction.
 * Implementation follows ITU-T H.265 section 7.3.7.
 *
 * @param reader BitReader positioned at start of short-term ref pic set
 * @param stRpsIdx Current RPS index being parsed
 * @param numShortTermRefPicSets Total number of short-term ref pic sets
 */
function skipShortTermRefPicSet(
  reader: BitReader,
  stRpsIdx: number,
  numShortTermRefPicSets: number
): void {
  if (stRpsIdx !== 0) {
    // inter_ref_pic_set_prediction_flag
    if (reader.readBit() === 1) {
      if (stRpsIdx === numShortTermRefPicSets) {
        reader.readUEV() // delta_idx_minus1
      }
      reader.readBit() // delta_rps_sign
      reader.readUEV() // abs_delta_rps_minus1
      const refRpsIdx = stRpsIdx - (reader.readUEV() + 1)
      const numDeltaPocs = 0 // This should be calculated from the reference RPS
      for (let j = 0; j <= numDeltaPocs; j++) {
        if (reader.readBit() === 1) {
          // used_by_curr_pic_flag[j]
          reader.readBit() // use_delta_flag[j]
        }
      }
    } else {
      const numNegativePics = reader.readUEV()
      const numPositivePics = reader.readUEV()
      for (let i = 0; i < numNegativePics; i++) {
        reader.readUEV() // delta_poc_s0_minus1
        reader.readBit() // used_by_curr_pic_s0_flag
      }
      for (let i = 0; i < numPositivePics; i++) {
        reader.readUEV() // delta_poc_s1_minus1
        reader.readBit() // used_by_curr_pic_s1_flag
      }
    }
  }
}

/**
 * Parses profile, tier, and level information from HEVC SPS.
 * This information defines the decoder capabilities required to decode the stream.
 * Implementation follows ITU-T H.265 section 7.3.3.
 *
 * @param reader BitReader positioned at start of profile_tier_level syntax
 * @param maxSubLayersMinus1 Number of temporal sub-layers minus 1
 */
function parseProfileTierLevel(reader: BitReader, maxSubLayersMinus1: number): void {
  console.debug('Starting profile_tier_level parsing')
  // general_profile_space (2 bits)
  const profileSpace = reader.readBits(2)
  // general_tier_flag (1 bit)
  const tierFlag = reader.readBit()
  // general_profile_idc (5 bits)
  const profileIdc = reader.readBits(5)

  console.debug('Profile info:', { profileSpace, tierFlag, profileIdc })

  // general_profile_compatibility_flags (32 bits)
  const compatibilityFlags = reader.readBits(32)

  // general_constraint_indicator_flags (48 bits)
  // In some versions it's split into multiple fields, but we can read it as one
  const constraintFlags = reader.readBits(48)

  // general_level_idc (8 bits)
  const levelIdc = reader.readBits(8)

  console.debug('Level and constraints:', {
    compatibilityFlags: `0x${compatibilityFlags.toString(16)}`,
    constraintFlags: `0x${constraintFlags.toString(16)}`,
    levelIdc,
  })

  // Parse sub-layer profile and level flags
  const subLayerFlags: Array<{ profilePresent: boolean; levelPresent: boolean }> = []
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    subLayerFlags.push({
      profilePresent: reader.readBit() === 1,
      levelPresent: reader.readBit() === 1,
    })
  }

  // Skip reserved_zero_2bits padding
  if (maxSubLayersMinus1 > 0) {
    for (let i = maxSubLayersMinus1; i < 8; i++) {
      reader.readBits(2)
    }
  }

  // Parse sub-layer profile and level data if present
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (subLayerFlags[i].profilePresent) {
      // sub_layer_profile_space + tier_flag + profile_idc (8 bits)
      reader.readBits(8)
      // profile_compatibility_flags (32 bits)
      reader.readBits(32)
      // constraint_flags (48 bits)
      reader.readBits(48)
    }
    if (subLayerFlags[i].levelPresent) {
      // sub_layer_level_idc (8 bits)
      reader.readBits(8)
    }
  }

  console.debug('Finished profile_tier_level parsing, remaining bits:', reader.remainingBits())
}

/**
 * Parses HEVC VUI (Video Usability Information) parameters.
 * VUI parameters provide additional information about the video stream
 * including aspect ratio, color space, and timing.
 * Implementation follows ITU-T H.265 section E.3.1.
 *
 * @param reader BitReader positioned at start of VUI parameters
 * @returns Object containing color information and frame rate
 */
function parseHEVCVUIParameters(reader: BitReader): VideoColorInfo & { fps?: number } {
  let fps = 0
  let colorInfo = getDefaultColorInfo()

  console.debug('Starting HEVC VUI parameters parsing')

  // Parse aspect ratio information
  const aspectRatioPresent = reader.readBit() === 1 // aspect_ratio_info_present_flag
  console.debug('aspect_ratio_info_present_flag:', aspectRatioPresent)
  if (aspectRatioPresent) {
    const aspectRatioIdc = reader.readBits(8)
    console.debug('aspect_ratio_idc:', aspectRatioIdc)
    if (aspectRatioIdc === 255) {
      // Extended_SAR
      const sarWidth = reader.readBits(16)
      const sarHeight = reader.readBits(16)
      console.debug('Extended SAR:', { width: sarWidth, height: sarHeight })
    }
  }

  // Parse overscan information
  const overscanInfoPresent = reader.readBit() === 1 // overscan_info_present_flag
  console.debug('overscan_info_present_flag:', overscanInfoPresent)
  if (overscanInfoPresent) {
    const overscanAppropriate = reader.readBit() === 1
    console.debug('overscan_appropriate_flag:', overscanAppropriate)
  }

  // Parse video signal type
  const videoSignalTypePresent = reader.readBit() === 1 // video_signal_type_present_flag
  console.debug('video_signal_type_present_flag:', videoSignalTypePresent)
  if (videoSignalTypePresent) {
    // video_format (3 bits)
    const videoFormat = reader.readBits(3)
    // video_full_range_flag (1 bit)
    const fullRange = reader.readBit() === 1
    // colour_description_present_flag (1 bit)
    const colourDescriptionPresent = reader.readBit() === 1
    console.debug('Video signal type:', {
      videoFormat,
      fullRange,
      colourDescriptionPresent,
    })

    if (colourDescriptionPresent) {
      const colorPrimaries = reader.readBits(8)
      const transferCharacteristics = reader.readBits(8)
      const matrixCoefficients = reader.readBits(8)

      console.debug('HEVC color parameters:', {
        videoFormat,
        colorPrimaries,
        transferCharacteristics,
        matrixCoefficients,
        fullRange,
        raw: {
          primaries: `0x${colorPrimaries.toString(16)}`,
          transfer: `0x${transferCharacteristics.toString(16)}`,
          matrix: `0x${matrixCoefficients.toString(16)}`,
        },
        mapped: {
          primaries: mapColorPrimaries(colorPrimaries),
          transfer: mapTransferCharacteristics(transferCharacteristics),
          matrix: mapMatrixCoefficients(matrixCoefficients),
        },
      })

      colorInfo = {
        matrixCoefficients: mapMatrixCoefficients(matrixCoefficients),
        transferCharacteristics: mapTransferCharacteristics(transferCharacteristics),
        primaries: mapColorPrimaries(colorPrimaries),
        fullRange,
      }
    } else {
      colorInfo = {
        ...getDefaultColorInfo(),
        fullRange,
      }
    }
  }

  // Parse chroma location information
  const chromaLocInfoPresent = reader.readBit() === 1 // chroma_loc_info_present_flag
  console.debug('chroma_loc_info_present_flag:', chromaLocInfoPresent)
  if (chromaLocInfoPresent) {
    const topField = reader.readUEV()
    const bottomField = reader.readUEV()
    console.debug('Chroma location:', { topField, bottomField })
  }

  // Parse timing information
  const timingInfoPresent = reader.readBit() === 1 // timing_info_present_flag
  console.debug(
    'timing_info_present_flag:',
    timingInfoPresent,
    'remaining bits:',
    reader.remainingBits()
  )

  if (timingInfoPresent) {
    const numUnitsInTick = reader.readBits(32)
    const timeScale = reader.readBits(32)
    const fixedFrameRateFlag = reader.readBit() === 1

    console.debug('Raw timing values:', {
      numUnitsInTick,
      timeScale,
      fixedFrameRateFlag,
      remainingBits: reader.remainingBits(),
    })

    // Calculate frame rate
    if (numUnitsInTick > 0 && timeScale > 0) {
      // For HEVC, fps = timeScale / numUnitsInTick
      let calculatedFps = timeScale / numUnitsInTick

      console.debug('Initial FPS calculation:', calculatedFps)

      // Common frame rate values for rounding
      const commonFps = [
        23.976, // 24000/1001
        24,
        25,
        29.97, // 30000/1001
        30,
        48,
        50,
        59.94, // 60000/1001
        60,
        120,
      ]

      // Find the closest common frame rate
      const closestFps = commonFps.reduce((prev, curr) =>
        Math.abs(curr - calculatedFps) < Math.abs(prev - calculatedFps) ? curr : prev
      )

      console.debug('Closest standard FPS:', closestFps)

      // If calculated fps is close to a common value (within 1%), use that instead
      if (Math.abs(calculatedFps - closestFps) / closestFps < 0.01) {
        calculatedFps = closestFps
        console.debug('Using standard FPS value:', calculatedFps)
      }

      fps = calculatedFps

      // Special case handling for common time_scale values
      if (timeScale === 90000) {
        console.debug('Found common timescale 90000, checking for standard cases')
        // Common time_scale for HEVC
        switch (numUnitsInTick) {
          case 1500:
            fps = 60 // 90000/1500 = 60fps
            break
          case 1501:
            fps = 59.94 // 90000/1501 ≈ 59.94fps
            break
          case 1800:
            fps = 50 // 90000/1800 = 50fps
            break
          case 3000:
            fps = 30 // 90000/3000 = 30fps
            break
          case 3003:
            fps = 29.97 // 90000/3003 ≈ 29.97fps
            break
          case 3750:
            fps = 24 // 90000/3750 = 24fps
            break
          case 3751:
            fps = 23.976 // 90000/3751 ≈ 23.976fps
            break
        }
        console.debug('After checking standard cases, fps:', fps)
      }
    }

    console.debug('HEVC timing info:', {
      numUnitsInTick,
      timeScale,
      fixedFrameRateFlag,
      calculatedFps: fps,
      raw: {
        units: `0x${numUnitsInTick.toString(16)}`,
        scale: `0x${timeScale.toString(16)}`,
      },
    })
  } else {
    console.debug('No timing info present in VUI parameters')
  }

  // Parse HRD parameters
  const nalHrdParametersPresent = reader.readBit() === 1 // nal_hrd_parameters_present_flag
  console.debug('nal_hrd_parameters_present_flag:', nalHrdParametersPresent)
  if (nalHrdParametersPresent) {
    console.debug('Skipping NAL HRD parameters')
    skipHrdParameters(reader)
  }
  const vclHrdParametersPresent = reader.readBit() === 1 // vcl_hrd_parameters_present_flag
  console.debug('vcl_hrd_parameters_present_flag:', vclHrdParametersPresent)
  if (vclHrdParametersPresent) {
    console.debug('Skipping VCL HRD parameters')
    skipHrdParameters(reader)
  }

  console.debug('Finished parsing VUI parameters, final fps:', fps)
  return { ...colorInfo, fps }
}

/**
 * Skips HRD (Hypothetical Reference Decoder) parameters.
 * HRD parameters define buffering and timing requirements for decoders.
 * Implementation follows ITU-T H.265 section E.3.2.
 *
 * @param reader BitReader positioned at start of HRD parameters
 */
function skipHrdParameters(reader: BitReader): void {
  // Skip HRD (Hypothetical Reference Decoder) parameters
  // These are not needed for dimensions or color info
  const commonInfPresentFlag = reader.readBit() === 1
  if (commonInfPresentFlag) {
    reader.readBits(8) // bit_rate_scale
    reader.readBits(8) // cpb_size_scale
    if (reader.readBit() === 1) {
      // cpb_size_du_scale
      reader.readBits(8)
    }
    reader.readBits(5) // initial_cpb_removal_delay_length_minus1
    reader.readBits(5) // au_cpb_removal_delay_length_minus1
    reader.readBits(5) // dpb_output_delay_length_minus1
  }
}
