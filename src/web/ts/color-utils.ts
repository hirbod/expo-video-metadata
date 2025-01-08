import type { VideoColorInfo } from '../../ExpoVideoMetadata.types'

/**
 * Returns default color information with all fields set to null.
 * Used when a video format doesn't provide color metadata.
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
 * @param value The numeric value from the video stream
 * @returns The standardized string representation or null if unknown
 */
export function mapColorPrimaries(value: number): string | null {
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
 * Maps matrix coefficients values to their standardized string representations.
 * @param value The numeric value from the video stream
 * @returns The standardized string representation or null if unknown
 */
export function mapMatrixCoefficients(value: number): string | null {
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
 * Maps transfer characteristics values to their standardized string representations.
 * @param value The numeric value from the video stream
 * @returns The standardized string representation or null if unknown
 */
export function mapTransferCharacteristics(value: number): string | null {
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
