import type { VideoColorInfo } from '../../ExpoVideoMetadata.types'

/**
 * Returns default color information with all fields set to null.
 * Used when a video format doesn't provide color metadata.
 *
 * @returns {VideoColorInfo} Default color information structure
 */
export function getDefaultColorInfo(): VideoColorInfo {
  return {
    matrixCoefficients: null,
    transferCharacteristics: null,
    primaries: null,
    fullRange: null,
  }
}

/**
 * Maps color primaries values to their standardized string representations.
 * Values and mappings from ISO/IEC 23091-2:2021 section 8.1.
 *
 * These values indicate the chromaticity coordinates of the source RGB
 * primaries and white point used in the video content. The mapping follows
 * standard specifications:
 *
 * - BT.709: HDTV and sRGB (Rec. ITU-R BT.709-6)
 * - BT.470: Legacy TV standards (Rec. ITU-R BT.470)
 * - BT.2020: UHDTV and HDR (Rec. ITU-R BT.2020-2)
 * - P3: Digital Cinema (SMPTE RP 431-2)
 *
 * @param value The numeric value from the video stream
 * @returns The standardized string representation or null if unknown
 */
export function mapColorPrimaries(value: number): string | null {
  switch (value) {
    case 1:
      return 'bt709' // Rec. ITU-R BT.709-6
    case 4:
      return 'bt470m' // Rec. ITU-R BT.470 System M
    case 5:
      return 'bt470bg' // Rec. ITU-R BT.470 System B,G
    case 6:
      return 'smpte170m' // SMPTE 170M (same as BT.601)
    case 7:
      return 'smpte240m' // SMPTE 240M
    case 8:
      return 'film' // Generic film (color filters using Illuminant C)
    case 9:
      return 'bt2020' // Rec. ITU-R BT.2020-2
    case 10:
      return 'smpte428' // SMPTE ST 428-1
    case 11:
      return 'p3' // SMPTE RP 431-2 (DCI-P3)
    case 12:
      return 'p3-d65' // SMPTE EG 432-1 (Display P3)
    default:
      return null
  }
}

/**
 * Maps matrix coefficients values to their standardized string representations.
 * Values and mappings from ISO/IEC 23091-2:2021 section 8.3.
 *
 * These values define the matrix coefficients used to convert RGB to YCbCr
 * color space. The coefficients affect how color is reproduced and converted
 * between different color spaces. Common standards include:
 *
 * - BT.709: HDTV color space conversion
 * - BT.2020: UHDTV with non-constant/constant luminance
 * - YCoCg: Reversible RGB to YCbCr conversion
 * - ICT/PCT: HDR-optimized color transforms
 *
 * @param value The numeric value from the video stream
 * @returns The standardized string representation or null if unknown
 */
export function mapMatrixCoefficients(value: number): string | null {
  switch (value) {
    case 1:
      return 'bt709' // Rec. ITU-R BT.709-6
    case 4:
      return 'fcc' // US FCC Title 47 CFR 73.682
    case 5:
      return 'bt470bg' // Rec. ITU-R BT.470 / BT.601
    case 6:
      return 'smpte170m' // SMPTE 170M (same as BT.601)
    case 7:
      return 'smpte240m' // SMPTE 240M
    case 8:
      return 'ycocg' // YCoCg color space
    case 9:
      return 'bt2020nc' // BT.2020 non-constant luminance
    case 10:
      return 'bt2020c' // BT.2020 constant luminance
    case 11:
      return 'smpte2085' // SMPTE ST 2085
    case 12:
      return 'chromat-ncl' // Chromaticity-derived non-constant luminance
    case 13:
      return 'chromat-cl' // Chromaticity-derived constant luminance
    case 14:
      return 'ictcp' // ICtCp HDR color space
    default:
      return null
  }
}

/**
 * Maps transfer characteristics values to their standardized string representations.
 * Values and mappings from ISO/IEC 23091-2:2021 section 8.2.
 *
 * These values define the electro-optical transfer function (EOTF) that converts
 * encoded signal values to display light output. Key standards include:
 *
 * - BT.709: Standard dynamic range (SDR) gamma curve
 * - SMPTE 2084: HDR10 perceptual quantization (PQ)
 * - HLG: Hybrid Log-Gamma for HDR broadcast
 * - BT.2020: 10-bit and 12-bit UHDTV transfer functions
 *
 * @param value The numeric value from the video stream
 * @returns The standardized string representation or null if unknown
 */
export function mapTransferCharacteristics(value: number): string | null {
  switch (value) {
    case 1:
      return 'bt709' // Rec. ITU-R BT.709-6
    case 4:
      return 'gamma22' // Assumed display gamma 2.2
    case 5:
      return 'gamma28' // Assumed display gamma 2.8
    case 6:
      return 'smpte170m' // SMPTE 170M (same as BT.601)
    case 7:
      return 'smpte240m' // SMPTE 240M
    case 8:
      return 'linear' // Linear transfer characteristics
    case 9:
      return 'log' // Logarithmic transfer
    case 10:
      return 'log-sqrt' // Square root transfer
    case 11:
      return 'iec61966-2-4' // IEC 61966-2-4 xvYCC
    case 13:
      return 'iec61966-2-1' // IEC 61966-2-1 sRGB/sYCC
    case 14:
      return 'bt2020-10' // BT.2020 10-bit
    case 15:
      return 'bt2020-12' // BT.2020 12-bit
    case 16:
      return 'smpte2084' // SMPTE ST 2084 (HDR10/PQ)
    case 17:
      return 'smpte428' // SMPTE ST 428-1
    case 18:
      return 'hlg' // Hybrid Log-Gamma (HLG)
    default:
      return null
  }
}
