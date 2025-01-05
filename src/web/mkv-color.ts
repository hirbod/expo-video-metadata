import type { VideoColorInfo } from '../ExpoVideoMetadata.types'

/**
 * Parser for WebM/MKV color information.
 * Handles color metadata parsing for WebM and Matroska container formats.
 */
export class MkvColorParser {
  /**
   * Parses WebM/MKV color information including HDR metadata.
   * Color information in WebM/MKV is stored hierarchically:
   * Colour
   * ├── MatrixCoefficients (0x55b1)
   * ├── Range (0x55b2)
   * ├── TransferCharacteristics (0x55b9)
   * ├── Primaries (0x55ba)
   * └── MasteringMetadata (0x55d0)
   *     ├── LuminanceMax/Min
   *     └── MaxCLL/MaxFALL
   *
   * @param data - The color data to parse
   * @param codec - The video codec (optional)
   * @returns VideoColorInfo The parsed color information
   */
  static parseColorInfo(data: Uint8Array, codec = ''): VideoColorInfo {
    try {
      console.debug('Color info parsing:', {
        data: Array.from(data)
          .map((b, i) => ({
            offset: i,
            hex: b.toString(16).padStart(2, '0'),
            decimal: b,
            ascii: b >= 32 && b <= 126 ? String.fromCharCode(b) : '.',
            possibleElement: b === 0x55 ? 'Color element start' : '',
          }))
          .filter((_, i) => i < 32), // Only show first 32 bytes to avoid noise
      })

      // For H.264 in MKV/WebM, if no color info is present, use standard values
      if (codec === 'V_MPEG4/ISO/AVC') {
        return {
          primaries: 'smpte170m',
          transferCharacteristics: 'bt709',
          matrixCoefficients: 'smpte170m',
          fullRange: false,
        }
      }

      // For VFW content, return null values as we can't make assumptions
      if (codec === 'V_MS/VFW/FOURCC') {
        return MkvColorParser.getDefaultColorInfo()
      }

      let primaries: number | null = null
      let transfer: number | null = null
      let matrix: number | null = null
      let range: number | null = null

      // Direct scan for color elements
      for (let i = 0; i < data.length - 3; i++) {
        // Check for element IDs starting with 0x55
        if (data[i] !== 0x55) continue

        const nextByte = data[i + 1]
        const sizeMarker = data[i + 2]

        // Only process if we have a size marker of 0x81 (single byte)
        if (sizeMarker !== 0x81) continue

        const value = data[i + 3]

        console.debug('Found color element:', {
          offset: i,
          id: '0x55' + nextByte.toString(16),
          value,
          bytes: Array.from(data.slice(i, i + 4))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' '),
        })

        switch (nextByte) {
          case 0xba: // Primaries
            primaries = value
            break
          case 0xb9: // Transfer
            transfer = value
            break
          case 0xb1: // Matrix
            matrix = value
            break
          case 0xbb: // Range
            range = value
            break
        }

        // Skip the element (ID + size marker + value)
        i += 3
      }

      console.debug('Raw color values:', { primaries, transfer, matrix, range })

      // Map the values according to the WebM/MKV specification
      const colorInfo: VideoColorInfo = {
        primaries:
          primaries !== null ? MkvColorParser.mapColorPrimaries(primaries, codec, matrix) : null,
        transferCharacteristics:
          transfer !== null ? MkvColorParser.mapTransferCharacteristics(transfer, primaries) : null,
        matrixCoefficients: matrix !== null ? MkvColorParser.mapMatrixCoefficients(matrix) : null,
        fullRange: range !== null ? range === 2 : null,
      }

      console.debug('Color info mapping:', {
        raw: { primaries, transfer, matrix, range },
        mapped: colorInfo,
      })

      return colorInfo
    } catch (error) {
      console.debug('Error parsing color info:', error)
      return MkvColorParser.getDefaultColorInfo()
    }
  }

  /**
   * Maps matrix coefficients values to standard strings.
   * Values from ISO/IEC 23091-2:2019
   *
   * @param value - Matrix coefficients value from container
   * @returns String identifier or null if unknown
   */
  private static mapMatrixCoefficients(value: number): string | null {
    switch (value) {
      case 0:
        return 'rgb' // Identity/RGB
      case 1:
        return 'bt709' // ITU-R BT.709
      case 2:
        return 'unspecified'
      case 4:
        return 'fcc' // US FCC 73.682
      case 5:
        return 'bt470bg' // ITU-R BT.470BG
      case 6:
        return 'smpte170m' // ITU-R BT.601
      case 7:
        return 'smpte240m' // SMPTE 240M
      case 8:
        return 'ycocg' // YCgCo
      case 9:
        return 'bt2020nc' // BT.2020 non-constant
      case 10:
        return 'bt2020c' // BT.2020 constant
      case 11:
        return 'smpte2085' // SMPTE ST 2085
      case 12:
        return 'chroma-derived-nc' // Chromaticity-derived non-constant
      case 13:
        return 'chroma-derived-c' // Chromaticity-derived constant
      case 14:
        return 'ictcp' // ICtCp
      default:
        return null
    }
  }

  /**
   * Maps transfer characteristics values to standard strings.
   * Values from ISO/IEC 23091-2:2019
   *
   * @param value - Transfer characteristics value from container
   * @param primaries - Optional primaries value for context
   * @returns String identifier or null if unknown
   */
  private static mapTransferCharacteristics(
    value: number,
    primaries: number | null = null
  ): string | null {
    switch (value) {
      case 1:
        // For HDR content (primaries = 16 means BT.2020), value 1 means SMPTE 2084
        // Otherwise, it means BT.709
        return primaries === 16 ? 'smpte2084' : 'bt709'
      case 2:
        return 'unspecified'
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
        return 'log_sqrt'
      case 11:
        return 'iec61966-2-4'
      case 12:
        return 'bt1361'
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
        return 'arib-std-b67'
      default:
        return null
    }
  }

  /**
   * Maps color primaries values to standard strings.
   * Values from ISO/IEC 23091-2:2019
   *
   * @param value - Color primaries value from container
   * @param codec - Optional codec string for context
   * @param matrix - Optional matrix coefficients for context
   * @returns String identifier or null if unknown
   */
  private static mapColorPrimaries(
    value: number,
    codec = '',
    matrix: number | null = null
  ): string | null {
    switch (value) {
      case 1:
        // For VP9:
        // - If all values are 1, it means bt709
        // - Otherwise, value 1 means bt470bg
        // For AV1, value 1 means bt470bg
        if (codec === 'V_VP9' && matrix === 1) {
          return 'bt709'
        }
        return 'bt470bg'
      case 2:
        return 'unspecified'
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
        return 'smpte431'
      case 12:
        return 'smpte432'
      case 16:
        return 'bt2020'
      case 22:
        return 'ebu3213'
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
}
