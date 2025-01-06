import type { VideoColorInfo } from '../ExpoVideoMetadata.types'
import { BinaryReaderImpl } from './binary-reader'

/**
 * Parser for MP4/MOV color information.
 * Handles color metadata parsing for MP4 and MOV container formats.
 * Supports various color info sources including:
 * - Codec configuration (AVC/HEVC/VP9/AV1)
 * - Color info boxes (colr/nclx/nclc)
 * - HDR metadata boxes (mdcv/clli)
 * - Dolby Vision (dovi)
 * - ICC profiles
 */
export class MP4ColorParser {
  /**
   * Parses color information from MP4 container boxes.
   * Handles various color info box types and codec configurations.
   * Follows ISO/IEC 23091-2:2021 specification for color space mapping.
   *
   * @param data - Raw box data to parse
   * @returns VideoColorInfo Color space and HDR metadata
   */
  static parseColorInfo(data: Uint8Array): VideoColorInfo {
    try {
      const reader = new BinaryReaderImpl(data)
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

      // Version byte = 1 indicates codec configuration data
      if (view.getUint8(0) === 1) {
        const codecByte = view.getUint8(1)
        // Codec identification bytes:
        // 0x22: HEVC Main10 profile
        // 0x64/0x4d/0x42: AVC High/Main/Baseline profiles
        // 0x81: AV1 with HDR capabilities
        // 0x91: VP9 with extended color config
        if (codecByte === 0x22) return MP4ColorParser.parseHEVCConfig(reader)
        if (codecByte === 0x64 || codecByte === 0x4d || codecByte === 0x42)
          return MP4ColorParser.parseAVCConfig(reader)
        if (codecByte === 0x81) return MP4ColorParser.parseAV1Config(reader)
        if (codecByte === 0x91) return MP4ColorParser.parseVP9Config(reader)
      }

      const colourType = reader.readString(4)

      switch (colourType) {
        case 'nclx':
        case 'nclc': {
          const primaries = reader.readUint16()
          const transfer = reader.readUint16()
          const matrix = reader.readUint16()
          // For nclx, full range flag is in highest bit (0x80) of the flags byte
          const fullRange = colourType === 'nclx' ? (reader.readUint8() & 0x80) !== 0 : null

          return {
            matrixCoefficients: MP4ColorParser.mapMatrixCoefficients(matrix),
            transferCharacteristics: MP4ColorParser.mapTransferCharacteristics(transfer),
            primaries: MP4ColorParser.mapColorPrimaries(primaries),
            fullRange,
          }
        }
        case 'mdcv':
          return MP4ColorParser.parseMasteringDisplayColorVolume(reader)
        case 'clli':
          return MP4ColorParser.parseContentLightLevel(reader)
        case 'dovi':
          return MP4ColorParser.parseDolbyVision(reader)
        case 'rICC':
        case 'prof':
          return {
            matrixCoefficients: 'rgb',
            transferCharacteristics: null,
            primaries: null,
            fullRange: true,
          }
      }

      return MP4ColorParser.getDefaultColorInfo()
    } catch (error) {
      console.debug('Error parsing color info:', error)
      return MP4ColorParser.getDefaultColorInfo()
    }
  }

  /**
   * Parses AV1 codec configuration for HDR metadata.
   * AV1 signals HDR through:
   * - Profile (2/3 for HDR)
   * - High bit depth flag
   * - HDR metadata flag
   *
   * @param reader - Binary reader positioned at start of AV1 config
   * @returns VideoColorInfo Color space and HDR metadata
   */
  private static parseAV1Config(reader: BinaryReaderImpl): VideoColorInfo {
    try {
      const marker = reader.readUint8()
      const version = reader.readUint8()
      const profileAndLevel = reader.readUint8()
      const flags = reader.readUint8()

      // Profile is in bits 5-7 of profileAndLevel byte
      // Shift right by 5 and mask with 0x7 to get 3-bit value
      const profile = (profileAndLevel >> 5) & 0x7
      // HDR flag is bit 2 (0x4), high bit depth is bit 1 (0x2)
      const hasHDR = (flags & 0x4) !== 0
      const highBitDepth = (flags & 0x2) !== 0

      if (hasHDR || (profile >= 2 && highBitDepth)) {
        return {
          matrixCoefficients: 'bt2020nc',
          transferCharacteristics: 'smpte2084',
          primaries: 'bt2020',
          fullRange: true,
        }
      }
    } catch (error) {
      console.debug('Error parsing AV1 config:', error)
    }
    return MP4ColorParser.getDefaultColorInfo()
  }

  /**
   * Parses VP9 codec configuration for HDR metadata.
   * VP9 signals HDR through:
   * - Profile (2/3 for HDR)
   * - Bit depth (10+ for HDR)
   * - Color space (BT.2020)
   *
   * @param reader - Binary reader positioned at start of VP9 config
   * @returns VideoColorInfo Color space and HDR metadata
   */
  private static parseVP9Config(reader: BinaryReaderImpl): VideoColorInfo {
    try {
      // First 8 bytes in MP4 container are reserved/padding
      reader.skip(8)

      const profile = reader.readUint8()
      console.debug('VP9 Profile:', profile)

      const level = reader.readUint8()
      // Bit depth is in upper 4 bits, shift right by 4 and mask with 0x0f
      const bitDepth = (reader.readUint8() >> 4) & 0x0f
      console.debug('VP9 Bit Depth:', bitDepth)

      // Color config byte layout:
      // Bits 7-4: Color space (4 bits)
      // Bit 3: Color range (1 bit)
      // Bits 2-0: Chroma subsampling (3 bits)
      const colorConfig = reader.readUint8()
      const colorSpace = (colorConfig >> 4) & 0x0f // Upper 4 bits
      const colorRange = (colorConfig >> 3) & 0x01 // Bit 3
      const subsampling = colorConfig & 0x07 // Lower 3 bits

      console.debug('VP9 Color Config:', {
        colorSpace,
        colorRange,
        subsampling,
        profile,
        level,
        bitDepth,
      })

      // Check for HDR characteristics:
      // - Profile 2/3 with 10+ bit depth indicates HDR capability
      // - Color space 9 or 10 indicates BT.2020
      const isHdrCapable = (profile >= 2 && bitDepth >= 10) || colorSpace >= 9

      if (isHdrCapable) {
        return {
          matrixCoefficients: 'bt2020nc',
          transferCharacteristics: 'smpte2084',
          primaries: 'bt2020',
          fullRange: colorRange === 1,
        }
      }

      // SDR defaults
      return {
        matrixCoefficients: 'bt709',
        transferCharacteristics: 'bt709',
        primaries: 'bt709',
        fullRange: colorRange === 1,
      }
    } catch (error) {
      console.debug('Error parsing VP9 config:', error)
      return MP4ColorParser.getDefaultColorInfo()
    }
  }

  /**
   * Parses content light level information.
   * Contains MaxCLL (Maximum Content Light Level) and MaxFALL.
   * MaxCLL > 1000 nits typically indicates HDR content.
   *
   * @param reader - Binary reader positioned at start of content light level data
   * @returns VideoColorInfo Color space and HDR metadata
   */
  private static parseContentLightLevel(reader: BinaryReaderImpl): VideoColorInfo {
    try {
      // MaxCLL (Maximum Content Light Level) in nits
      const maxCLL = reader.readUint16()
      // MaxFALL (Frame-Average Light Level) in nits
      const maxFALL = reader.readUint16()

      // 1000 nits is typical HDR threshold for MaxCLL
      const isHDR = maxCLL > 1000

      if (isHDR) {
        return {
          matrixCoefficients: 'bt2020nc',
          transferCharacteristics: 'smpte2084',
          primaries: 'bt2020',
          fullRange: true,
        }
      }
    } catch (error) {
      console.debug('Error parsing content light level:', error)
    }
    return MP4ColorParser.getDefaultColorInfo()
  }

  /**
   * Parses AVC/H.264 codec configuration for color information.
   * Extracts color data from Sequence Parameter Set (SPS) NAL unit,
   * specifically from the VUI (Video Usability Information) parameters.
   * Follows ITU-T H.264 specification for bit-level parsing.
   *
   * @param reader - Binary reader positioned at start of AVC config
   * @returns VideoColorInfo Color space and HDR metadata
   */
  private static parseAVCConfig(reader: BinaryReaderImpl): VideoColorInfo {
    try {
      const configurationVersion = reader.readUint8()
      const profileIdc = reader.readUint8()
      const profileCompatibility = reader.readUint8()
      const levelIdc = reader.readUint8()

      // Length of SPS NAL units array
      const lengthSizeMinusOne = reader.readUint8() & 0x03
      const numOfSequenceParameterSets = reader.readUint8() & 0x1f
      console.debug('AVC config details:', {
        configurationVersion,
        profileIdc,
        profileCompatibility: `0x${profileCompatibility.toString(16)}`,
        levelIdc,
        lengthSizeMinusOne,
        numOfSequenceParameterSets,
      })

      // Read SPS
      if (numOfSequenceParameterSets > 0) {
        const spsLength = reader.readUint16()
        console.debug('SPS length:', spsLength)

        if (spsLength > 4) {
          // Must be at least 4 bytes for NAL header
          const startOffset = reader.offset
          const spsData = Array.from(reader.data.slice(startOffset, startOffset + spsLength))
          console.debug('SPS data:', {
            nalHeader: spsData.slice(0, 4).map((b) => `0x${b.toString(16)}`),
            fullData: spsData.map((b) => `0x${b.toString(16)}`),
            rawBytes: Array.from(spsData)
              .map((b) => b.toString(2).padStart(8, '0'))
              .join(' '),
          })

          // Skip NAL header (4 bytes)
          reader.skip(4)

          // Create a bit reader for the remaining SPS data
          const spsReader = new BitReader(
            reader.data.slice(reader.offset, reader.offset + spsLength - 4)
          )

          // seq_parameter_set_id
          const spsId = spsReader.readUEV()
          console.debug('SPS ID:', spsId)
          spsReader.debugState()

          if (
            profileIdc === 100 ||
            profileIdc === 110 ||
            profileIdc === 122 ||
            profileIdc === 244 ||
            profileIdc === 44 ||
            profileIdc === 83 ||
            profileIdc === 86 ||
            profileIdc === 118 ||
            profileIdc === 128 ||
            profileIdc === 138 ||
            profileIdc === 139 ||
            profileIdc === 134
          ) {
            const chromaFormatIdc = spsReader.readUEV()
            console.debug('Chroma format:', chromaFormatIdc)
            spsReader.debugState()

            if (chromaFormatIdc === 3) {
              spsReader.readBits(1) // separate_colour_plane_flag
            }

            const bitDepthLumaMinus8 = spsReader.readUEV()
            const bitDepthChromaMinus8 = spsReader.readUEV()
            console.debug('Bit depth:', {
              luma: bitDepthLumaMinus8 + 8,
              chroma: bitDepthChromaMinus8 + 8,
            })

            spsReader.readBits(1) // qpprime_y_zero_transform_bypass_flag

            const seqScalingMatrixPresent = spsReader.readBits(1)
            if (seqScalingMatrixPresent) {
              const chromaFormatIdcValue = chromaFormatIdc === 3 ? 12 : 8
              for (let i = 0; i < chromaFormatIdcValue; i++) {
                const seqScalingListPresentFlag = spsReader.readBits(1)
                if (seqScalingListPresentFlag) {
                  if (i < 6) {
                    spsReader.skipScalingList(16)
                  } else {
                    spsReader.skipScalingList(64)
                  }
                }
              }
            }
          }

          // Continue parsing until vui_parameters_present_flag
          const log2MaxFrameNumMinus4 = spsReader.readUEV()
          console.debug('log2_max_frame_num_minus4:', log2MaxFrameNumMinus4)

          const picOrderCntType = spsReader.readUEV()
          console.debug('Pic order count type:', picOrderCntType)
          spsReader.debugState()

          if (picOrderCntType === 0) {
            const log2MaxPicOrderCntLsbMinus4 = spsReader.readUEV()
            console.debug('log2_max_pic_order_cnt_lsb_minus4:', log2MaxPicOrderCntLsbMinus4)
          } else if (picOrderCntType === 1) {
            spsReader.readBits(1) // delta_pic_order_always_zero_flag
            spsReader.readSEV() // offset_for_non_ref_pic
            spsReader.readSEV() // offset_for_top_to_bottom_field
            const numRefFramesInPicOrderCntCycle = spsReader.readUEV()
            for (let i = 0; i < numRefFramesInPicOrderCntCycle; i++) {
              spsReader.readSEV() // offset_for_ref_frame[i]
            }
          }

          const maxNumRefFrames = spsReader.readUEV()
          console.debug('max_num_ref_frames:', maxNumRefFrames)

          spsReader.readBits(1) // gaps_in_frame_num_value_allowed_flag

          const picWidthInMbsMinus1 = spsReader.readUEV()
          const picHeightInMapUnitsMinus1 = spsReader.readUEV()
          console.debug('Picture size in macroblocks:', {
            width: picWidthInMbsMinus1 + 1,
            height: picHeightInMapUnitsMinus1 + 1,
          })

          const frameMbsOnlyFlag = spsReader.readBits(1)
          console.debug('frame_mbs_only_flag:', frameMbsOnlyFlag)

          if (!frameMbsOnlyFlag) {
            spsReader.readBits(1) // mb_adaptive_frame_field_flag
          }

          spsReader.readBits(1) // direct_8x8_inference_flag

          const frameCroppingFlag = spsReader.readBits(1)
          if (frameCroppingFlag) {
            spsReader.readUEV() // frame_crop_left_offset
            spsReader.readUEV() // frame_crop_right_offset
            spsReader.readUEV() // frame_crop_top_offset
            spsReader.readUEV() // frame_crop_bottom_offset
          }

          // Finally at VUI parameters
          const vuiParametersPresentFlag = spsReader.readBits(1)
          console.debug('VUI parameters present:', vuiParametersPresentFlag)
          spsReader.debugState()

          if (vuiParametersPresentFlag === 1) {
            const aspectRatioInfoPresentFlag = spsReader.readBits(1)
            if (aspectRatioInfoPresentFlag === 1) {
              const aspectRatioIdc = spsReader.readBits(8)
              if (aspectRatioIdc === 255) {
                spsReader.readBits(16) // sar_width
                spsReader.readBits(16) // sar_height
              }
            }

            const overscanInfoPresentFlag = spsReader.readBits(1)
            if (overscanInfoPresentFlag === 1) {
              spsReader.readBits(1) // overscan_appropriate_flag
            }

            const videoSignalTypePresentFlag = spsReader.readBits(1)
            console.debug('Video signal type present:', videoSignalTypePresentFlag)
            spsReader.debugState()

            if (videoSignalTypePresentFlag === 1) {
              spsReader.readBits(3) // video_format
              const fullRange = spsReader.readBits(1) === 1 // video_full_range_flag
              const colourDescriptionPresentFlag = spsReader.readBits(1)
              console.debug('Colour description present:', colourDescriptionPresentFlag)
              spsReader.debugState()

              if (colourDescriptionPresentFlag === 1) {
                const colourPrimaries = spsReader.readBits(8)
                const transferCharacteristics = spsReader.readBits(8)
                const matrixCoefficients = spsReader.readBits(8)

                console.debug('Found color info in VUI:', {
                  colourPrimaries,
                  transferCharacteristics,
                  matrixCoefficients,
                  fullRange,
                })

                return {
                  matrixCoefficients: MP4ColorParser.mapMatrixCoefficients(matrixCoefficients),
                  transferCharacteristics:
                    MP4ColorParser.mapTransferCharacteristics(transferCharacteristics),
                  primaries: MP4ColorParser.mapColorPrimaries(colourPrimaries),
                  fullRange,
                }
              }
            }
          }

          // Skip to end of SPS
          reader.skip(spsLength - 4)
        }
      }

      return MP4ColorParser.getDefaultColorInfo()
    } catch (error) {
      console.debug('Error parsing AVC config:', error)
      return MP4ColorParser.getDefaultColorInfo()
    }
  }

  /**
   * Parses HEVC/H.265 codec configuration for HDR metadata.
   * HEVC signals HDR through:
   * - Profile (Main10 or higher)
   * - HDR metadata flags
   * - Constraint flags
   *
   * @param reader - Binary reader positioned at start of HEVC config
   * @returns VideoColorInfo Color space and HDR metadata
   */
  private static parseHEVCConfig(reader: BinaryReaderImpl): VideoColorInfo {
    try {
      const configVersion = reader.readUint8()
      console.debug('HEVC config version:', configVersion)

      const generalProfileSpace = reader.readUint8()
      console.debug('General profile space:', generalProfileSpace)

      // Profile IDC is in lower 5 bits (0x1f mask)
      const profileIdc = generalProfileSpace & 0x1f
      console.debug('Profile IDC:', profileIdc)

      // 6 bytes of constraint flags:
      // - Byte 1 bit 6 (0x40) indicates HDR capability
      const constraintFlags: number[] = []
      for (let i = 0; i < 6; i++) {
        constraintFlags.push(reader.readUint8())
      }

      // Profile 2 is Main10 (HDR capable)
      // Or check constraint flag bit 6 in second byte
      if (profileIdc === 2 || constraintFlags[1] & 0x40) {
        return {
          matrixCoefficients: 'bt2020nc',
          transferCharacteristics: 'smpte2084',
          primaries: 'bt2020',
          fullRange: true,
        }
      }
    } catch (error) {
      console.debug('Error parsing HEVC config:', error)
    }
    return MP4ColorParser.getDefaultColorInfo()
  }

  /**
   * Parses VP9 color information from raw data.
   * Extracts:
   * - Profile and level
   * - Bit depth
   * - Color space and range
   * - Chroma subsampling
   *
   * @param data - Raw VP9 configuration data
   * @param offset - Offset to start reading from (default: 78)
   * @returns VideoColorInfo Color space and HDR metadata
   */
  static parseVP9ColorInfo(data: Uint8Array, offset = 78): VideoColorInfo {
    try {
      const reader = new BinaryReaderImpl(data)
      // Offset 78 is standard for VP9 in MP4:
      // - First 78 bytes contain standard sample entry fields
      // - After that comes VP9 specific config
      reader.skip(offset)

      const profile = reader.readUint8()
      const level = reader.readUint8()
      // Bit depth in upper 4 bits, color space in lower 4 bits
      const bitDepthAndColorSpace = reader.readUint8()
      // Chroma subsampling and range flags
      const chromaAndRange = reader.readUint8()

      // Extract individual fields using bit masks
      const bitDepth = (bitDepthAndColorSpace >> 4) & 0x0f // Upper 4 bits
      const colorSpace = bitDepthAndColorSpace & 0x0f // Lower 4 bits
      const colorRange = (chromaAndRange >> 7) & 0x01 // Highest bit
      const subsampling = (chromaAndRange >> 4) & 0x07 // Bits 6-4

      console.debug('VP9 Config:', {
        profile,
        level,
        bitDepth,
        colorSpace,
        colorRange,
        subsampling,
        rawBitDepthAndColorSpace: bitDepthAndColorSpace.toString(16),
        rawChromaAndRange: chromaAndRange.toString(16),
      })

      // Map VP9 color space values according to VP9 spec:
      // CS: 0=unknown, 1=BT.601, 2=BT.709, 3=SMPTE-170, 4=SMPTE-240, 5=BT.2020, 6=Reserved, 7=sRGB
      const matrixCoefficients = MP4ColorParser.mapVP9ColorSpace(colorSpace)
      const primaries = MP4ColorParser.mapVP9Primaries(colorSpace)
      const transferCharacteristics = MP4ColorParser.mapVP9Transfer(colorSpace, profile, bitDepth)

      return {
        matrixCoefficients,
        transferCharacteristics,
        primaries,
        fullRange: colorRange === 1,
      }
    } catch (error) {
      console.debug('Error parsing VP9 color info:', error)
      return MP4ColorParser.getDefaultColorInfo()
    }
  }

  /**
   * Maps VP9 color space values to standard strings.
   * VP9 color spaces:
   * 0: Unknown
   * 1: BT.601
   * 2: BT.709
   * 3: SMPTE-170
   * 4: SMPTE-240
   * 5: BT.2020
   * 6: Reserved
   * 7: sRGB
   *
   * @param colorSpace - VP9 color space value
   * @returns String identifier or null if unknown
   */
  private static mapVP9ColorSpace(colorSpace: number): string | null {
    switch (colorSpace) {
      case 1:
        return 'bt601'
      case 2:
        return 'bt709'
      case 3:
        return 'bt601' // SMPTE-170 is same as BT.601
      case 4:
        return 'smpte240m'
      case 5:
        return 'bt2020nc'
      case 7:
        return 'rgb'
      default:
        return null
    }
  }

  /**
   * Maps VP9 color primaries to standard strings.
   * Uses same mapping as color space but with specific
   * handling for sRGB (uses BT.709 primaries).
   *
   * @param colorSpace - VP9 color space value
   * @returns String identifier or null if unknown
   */
  private static mapVP9Primaries(colorSpace: number): string | null {
    switch (colorSpace) {
      case 1:
        return 'bt601'
      case 2:
        return 'bt709'
      case 3:
        return 'bt601'
      case 4:
        return 'smpte240m'
      case 5:
        return 'bt2020'
      case 7:
        return 'bt709' // sRGB uses BT.709 primaries
      default:
        return null
    }
  }

  /**
   * Maps VP9 transfer characteristics based on color space,
   * profile, and bit depth. HDR is indicated by:
   * - Profile 2/3 with 10+ bit depth
   * - BT.2020 color space with 10/12 bit depth
   *
   * @param colorSpace - VP9 color space value
   * @param profile - VP9 profile (0-3)
   * @param bitDepth - Color bit depth
   * @returns String identifier or null if unknown
   */
  private static mapVP9Transfer(
    colorSpace: number,
    profile: number,
    bitDepth: number
  ): string | null {
    // HDR detection: Profile 2/3 with 10+ bit depth indicates HDR capability
    if (profile >= 2 && bitDepth >= 10) {
      return 'smpte2084'
    }

    switch (colorSpace) {
      case 1:
        return 'bt601'
      case 2:
        return 'bt709'
      case 3:
        return 'bt601'
      case 4:
        return 'smpte240m'
      case 5:
        return bitDepth === 10 ? 'bt2020-10' : 'bt2020-12'
      case 7:
        return 'srgb'
      default:
        return null
    }
  }

  /**
   * Maps color primaries values to standard strings.
   * Values and mappings from ISO/IEC 23091-2:2021 section 8.1.
   * These values indicate the chromaticity coordinates of the color primaries
   * and white point used in the video content.
   *
   * @param value - Color primaries value from container
   * @returns String identifier or null if unknown/reserved
   */
  private static mapColorPrimaries(value: number): string | null {
    switch (value) {
      case 1:
        return 'bt709'
      case 4:
        return 'bt470m'
      case 5:
        return 'bt470bg'
      case 6:
        return 'smpte170m'
      case 7:
        return 'smpte240m'
      case 8:
        return 'film'
      case 9:
        return 'bt2020'
      case 10:
        return 'smpte428'
      case 11:
        return 'p3'
      case 12:
        return 'p3-d65'
      default:
        return null
    }
  }

  /**
   * Maps matrix coefficients values to standard strings.
   * Values and mappings from ISO/IEC 23091-2:2021 section 8.3.
   * These values define how RGB values are converted to YCbCr,
   * which affects color reproduction and conversion.
   *
   * @param value - Matrix coefficients value from container
   * @returns String identifier or null if unknown/reserved
   */
  private static mapMatrixCoefficients(value: number): string | null {
    switch (value) {
      case 1:
        return 'bt709'
      case 4:
        return 'fcc'
      case 5:
        return 'bt470bg'
      case 6:
        return 'smpte170m'
      case 7:
        return 'smpte240m'
      case 8:
        return 'ycocg'
      case 9:
        return 'bt2020nc'
      case 10:
        return 'bt2020c'
      case 11:
        return 'smpte2085'
      case 12:
        return 'chromat-ncl'
      case 13:
        return 'chromat-cl'
      case 14:
        return 'ictcp'
      default:
        return null
    }
  }

  /**
   * Maps transfer characteristics values to standard strings.
   * Values and mappings from ISO/IEC 23091-2:2021 section 8.2.
   * These values define the electro-optical transfer function (EOTF)
   * used to convert signal values to display light output.
   *
   * @param value - Transfer characteristics value from container
   * @returns String identifier or null if unknown/reserved
   */
  private static mapTransferCharacteristics(value: number): string | null {
    switch (value) {
      case 1:
        return 'bt709'
      case 4:
        return 'gamma22'
      case 5:
        return 'gamma28'
      case 6:
        return 'smpte170m'
      case 7:
        return 'smpte240m'
      case 8:
        return 'linear'
      case 9:
        return 'log'
      case 10:
        return 'log-sqrt'
      case 11:
        return 'iec61966-2-4'
      case 13:
        return 'iec61966-2-1'
      case 14:
        return 'bt2020-10'
      case 15:
        return 'bt2020-12'
      case 16:
        return 'smpte2084'
      case 17:
        return 'smpte428'
      case 18:
        return 'hlg'
      default:
        return null
    }
  }

  /**
   * Returns default color information structure.
   * @returns VideoColorInfo Default color info with null values
   */
  static getDefaultColorInfo(): VideoColorInfo {
    return {
      matrixCoefficients: null,
      transferCharacteristics: null,
      primaries: null,
      fullRange: null,
    }
  }

  /**
   * Parses HDR10 mastering display metadata.
   * Contains display primaries, white point, and luminance range.
   *
   * @param reader - Binary reader positioned at start of mastering display metadata
   * @returns VideoColorInfo Color space and HDR metadata
   */
  private static parseMasteringDisplayColorVolume(reader: BinaryReaderImpl): VideoColorInfo {
    try {
      // Display primaries are 3 sets of 16-bit x,y coordinates (3 * 2 * 4 = 24 bytes)
      reader.skip(24)

      // White point is 2 sets of 16-bit x,y coordinates (2 * 2 * 2 = 8 bytes)
      reader.skip(8)

      // Max/min luminance in 0.0001 nits
      // 1000000 = 100 nits (typical HDR threshold)
      const maxLuminance = reader.readUint32()
      // const minLuminance = reader.readUint32()

      // If max luminance > 1000 nits (10000000 in 0.0001 nits), likely HDR
      const isHDR = maxLuminance > 1000000 // Value in 0.0001 nits

      if (isHDR) {
        return {
          matrixCoefficients: 'bt2020nc',
          transferCharacteristics: 'smpte2084',
          primaries: 'bt2020',
          fullRange: true,
        }
      }
    } catch (error) {
      console.debug('Error parsing mastering display metadata:', error)
    }
    return MP4ColorParser.getDefaultColorInfo()
  }

  /**
   * Parses Dolby Vision configuration for HDR metadata.
   * Dolby Vision always uses HDR with either:
   * - SMPTE 2084 (PQ) for profiles 1-7
   * - BT.1361 for profiles 8+
   *
   * @param reader - Binary reader positioned at start of Dolby Vision config
   * @returns VideoColorInfo Color space and HDR metadata
   */
  private static parseDolbyVision(reader: BinaryReaderImpl): VideoColorInfo {
    try {
      const dvProfile = reader.readUint8()
      // const dvLevel = reader.readUint8()
      // const rpuFlag = reader.readUint8()
      // const elFlag = reader.readUint8()
      // const blFlag = reader.readUint8()

      // Dolby Vision always uses HDR
      return {
        matrixCoefficients: 'ictcp',
        transferCharacteristics: dvProfile <= 7 ? 'smpte2084' : 'bt1361',
        primaries: 'bt2020',
        fullRange: true,
      }
    } catch (error) {
      console.debug('Error parsing Dolby Vision config:', error)
    }
    return MP4ColorParser.getDefaultColorInfo()
  }
}

/**
 * Bit-level reader for parsing H.264 NAL units.
 * Implements Exp-Golomb (UEV/SEV) decoding as per H.264 spec.
 * Uses DataView and 32-bit buffer for efficient bit operations.
 */
class BitReader {
  private view: DataView
  private byteOffset = 0
  //private bitOffset = 0
  private bitBuffer = 0
  private bitsInBuffer = 0
  private readonly length: number

  constructor(data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    this.length = data.length
    this.fillBitBuffer()
  }

  /**
   * Fills the internal 32-bit buffer with next available bytes.
   * This reduces the number of individual byte reads needed.
   */
  private fillBitBuffer(): void {
    while (this.bitsInBuffer <= 24 && this.byteOffset < this.length) {
      this.bitBuffer = (this.bitBuffer << 8) | this.view.getUint8(this.byteOffset++)
      this.bitsInBuffer += 8
    }
  }

  /**
   * Reads specified number of bits from the stream.
   * Uses the internal 32-bit buffer for faster access.
   *
   * @param count - Number of bits to read (max 32)
   * @returns Bit value as number
   */
  readBits(count: number): number {
    if (count === 0) return 0
    if (count > 32) {
      console.debug('Attempting to read more than 32 bits')
      return 0
    }

    // Ensure we have enough bits
    if (this.bitsInBuffer < count) {
      this.fillBitBuffer()
      if (this.bitsInBuffer < count) {
        console.debug('End of buffer reached while reading bits')
        return 0
      }
    }

    // Extract bits from the buffer
    const value = (this.bitBuffer >> (this.bitsInBuffer - count)) & ((1 << count) - 1)
    this.bitsInBuffer -= count
    return value
  }

  /**
   * Reads a single bit from the stream.
   * Optimized special case of readBits(1).
   *
   * @returns Bit value (0 or 1)
   */
  readBit(): number {
    if (this.bitsInBuffer === 0) {
      this.fillBitBuffer()
      if (this.bitsInBuffer === 0) {
        console.debug('End of buffer reached while reading bit')
        return 0
      }
    }

    const bit = (this.bitBuffer >> (this.bitsInBuffer - 1)) & 1
    this.bitsInBuffer--
    return bit
  }

  /**
   * Reads an unsigned Exp-Golomb code (UEV).
   * Optimized to use readBits for the suffix.
   *
   * @returns Decoded UEV value
   */
  readUEV(): number {
    let leadingZeroBits = -1
    let bit = 0
    do {
      bit = this.readBit()
      leadingZeroBits++
    } while (bit === 0 && leadingZeroBits < 32)

    if (leadingZeroBits >= 32) {
      console.debug('Invalid UEV code - too many leading zeros')
      return 0
    }

    const suffixBits = this.readBits(leadingZeroBits)
    return (1 << leadingZeroBits) + suffixBits - 1
  }

  /**
   * Reads a signed Exp-Golomb code (SEV).
   * Uses UEV encoding with sign bit in LSB.
   *
   * @returns Decoded SEV value
   */
  readSEV(): number {
    const codeNum = this.readUEV()
    if (codeNum === 0) return 0
    const signFlag = codeNum & 1
    const magnitude = (codeNum + 1) >> 1
    return signFlag ? magnitude : -magnitude
  }

  /**
   * Skips scaling list data in SPS.
   * Used for custom quantization matrices.
   *
   * @param size - Size of scaling list (16 or 64)
   */
  skipScalingList(size: number): void {
    let lastScale = 8
    let nextScale = 8
    for (let j = 0; j < size; j++) {
      if (nextScale !== 0) {
        const deltaScale = this.readSEV()
        nextScale = (lastScale + deltaScale + 256) % 256
      }
      lastScale = nextScale === 0 ? lastScale : nextScale
    }
  }

  /**
   * Outputs debug information about reader state.
   * Includes byte/bit offsets and buffer contents.
   */
  debugState(): void {
    const nextBytes = new Array(4)
    for (let i = 0; i < 4 && this.byteOffset + i < this.length; i++) {
      nextBytes[i] = `0x${this.view.getUint8(this.byteOffset + i).toString(16)}`
    }

    console.debug('BitReader state:', {
      byteOffset: this.byteOffset,
      bitsInBuffer: this.bitsInBuffer,
      bitBuffer: `0x${this.bitBuffer.toString(16)}`,
      nextBytes,
      binaryView: nextBytes
        .map((hex) => Number.parseInt(hex.slice(2), 16).toString(2).padStart(8, '0'))
        .join(' '),
    })
  }

  /**
   * Checks if more data is available in the stream.
   *
   * @returns true if more data available, false otherwise
   */
  hasMoreData(): boolean {
    return this.bitsInBuffer > 0 || this.byteOffset < this.length
  }
}
