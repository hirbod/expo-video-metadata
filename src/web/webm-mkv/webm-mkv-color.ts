import type { VideoColorInfo } from '../../ExpoVideoMetadata.types'

/**
 * Parser for WebM/MKV color information.
 * Handles color metadata parsing for WebM and Matroska container formats.
 */
export class MkvColorParser {
  // Static cache for hex string formatting
  private static readonly byteToHex = Array.from({ length: 256 }, (_, i) =>
    i.toString(16).padStart(2, '0')
  )

  // Static buffer for color element scanning
  private static readonly COLOR_BUFFER = new Uint8Array(4)

  // Cache default color info
  private static readonly DEFAULT_COLOR_INFO: VideoColorInfo = {
    primaries: null,
    transferCharacteristics: null,
    matrixCoefficients: null,
    fullRange: null,
  }

  // Cache H.264 default color info
  private static readonly H264_COLOR_INFO: VideoColorInfo = {
    primaries: 'smpte170m',
    transferCharacteristics: 'bt709',
    matrixCoefficients: 'smpte170m',
    fullRange: false,
  }

  /**
   * Returns default color info object.
   */
  static getDefaultColorInfo(): VideoColorInfo {
    return { ...MkvColorParser.DEFAULT_COLOR_INFO }
  }

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
        data: Array.from(data.slice(0, 32)).map((b, i) => ({
          offset: i,
          hex: MkvColorParser.byteToHex[b],
          decimal: b,
          ascii: b >= 32 && b <= 126 ? String.fromCharCode(b) : '.',
          possibleElement: b === 0x55 ? 'Color element start' : '',
        })),
      })

      // For H.264 in MKV/WebM, if no color info is present, use standard values
      if (codec === 'V_MPEG4/ISO/AVC') {
        return { ...MkvColorParser.H264_COLOR_INFO }
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
      const dataLength = data.length - 3
      for (let i = 0; i < dataLength; i++) {
        // Check for element IDs starting with 0x55
        if (data[i] !== 0x55) continue

        const nextByte = data[i + 1]
        const sizeMarker = data[i + 2]

        // Only process if we have a size marker of 0x81 (single byte)
        if (sizeMarker !== 0x81) continue

        const value = data[i + 3]

        // Copy to buffer for debug logging
        MkvColorParser.COLOR_BUFFER[0] = data[i]
        MkvColorParser.COLOR_BUFFER[1] = nextByte
        MkvColorParser.COLOR_BUFFER[2] = sizeMarker
        MkvColorParser.COLOR_BUFFER[3] = value

        console.debug('Found color element:', {
          offset: i,
          id: '0x55' + MkvColorParser.byteToHex[nextByte],
          value,
          bytes: Array.from(MkvColorParser.COLOR_BUFFER)
            .map((b) => MkvColorParser.byteToHex[b])
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
   * Values from ISO/IEC 23091-2:2021
   *
   * @param value - Matrix coefficients value from container
   * @returns String identifier or null if unknown
   */
  private static mapMatrixCoefficients(value: number): string | null {
    switch (value) {
      case 0:
        return 'rgb'
      case 1:
        return 'bt709'
      case 2:
        return 'unspecified'
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
        return 'chroma-derived-nc'
      case 13:
        return 'chroma-derived-c'
      case 14:
        return 'ictcp'
      case 15:
        return 'y-derived'
      default:
        return null
    }
  }

  /**
   * Maps transfer characteristics values to standard strings.
   * Values from ISO/IEC 23091-2:2021
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
      case 19:
        return 'bt2100-hlg'
      default:
        return null
    }
  }

  /**
   * Maps color primaries values to standard strings.
   * Values from ISO/IEC 23091-2:2021
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
        return 'jedec-p22'
      case 23:
        return 'ebu3213'
      default:
        return null
    }
  }
}
