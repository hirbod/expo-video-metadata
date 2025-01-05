import type { VideoColorInfo } from '../ExpoVideoMetadata.types'
import { BinaryReaderImpl } from './binary-reader'

/**
 * Parser for MP4/MOV color information.
 * Handles color metadata parsing for MP4 and MOV container formats.
 */
export class MP4ColorParser {
  /**
   * Parses color information from MP4 container boxes.
   * Handles various color info box types including:
   * - nclx/nclc: Standard color info
   * - mdcv: HDR mastering display metadata
   * - clli: Content light level
   * - dovi: Dolby Vision
   * - ICC profiles
   *
   * @param data - Raw box data to parse
   * @returns VideoColorInfo Color space and HDR metadata
   */
  static parseColorInfo(data: Uint8Array): VideoColorInfo {
    try {
      const reader = new BinaryReaderImpl(data)
      console.debug(
        'Parsing color data of length:',
        data.length,
        'First bytes:',
        Array.from(data.slice(0, 4))
      )

      // Version byte = 1 indicates codec configuration data
      if (data[0] === 1) {
        // Codec identification bytes:
        // 0x22: HEVC Main10 profile
        // 0x64/0x4d/0x42: AVC High/Main/Baseline profiles
        // 0x81: AV1 with HDR capabilities
        // 0x91: VP9 with extended color config
        if (data[1] === 0x22) return MP4ColorParser.parseHEVCConfig(reader)
        if (data[1] === 0x64 || data[1] === 0x4d || data[1] === 0x42)
          return MP4ColorParser.parseAVCConfig(reader)
        if (data[1] === 0x81) return MP4ColorParser.parseAV1Config(reader)
        if (data[1] === 0x91) return MP4ColorParser.parseVP9Config(reader)
      }

      const colourType = reader.readString(4)
      console.debug('Color type:', colourType, 'Data length:', data.length)
      console.debug(
        'Raw data:',
        Array.from(data).map((b) => b.toString(16))
      )

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
   * Parses AVC/H.264 codec configuration for HDR metadata.
   * AVC signals HDR through:
   * - Profile (High 10, High 10 Intra)
   * - Profile compatibility flags
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

      console.debug('AVC config:', {
        configurationVersion,
        profileIdc,
        profileCompatibility,
        levelIdc,
      })

      // Check profiles
      switch (profileIdc) {
        // High 10, High 10 Intra
        case 110:
        case 122:
          return {
            matrixCoefficients: 'bt2020nc',
            transferCharacteristics: 'bt2100-pq',
            primaries: 'bt2020',
            fullRange: true,
          }

        // High, High Intra, High Progressive
        case 100:
        case 118:
        case 44:
          return {
            matrixCoefficients: 'bt709',
            transferCharacteristics: 'bt709',
            primaries: 'bt709',
            fullRange: false,
          }

        // Main, Main Intra
        // Baseline, Extended, Constrained Baseline
        case 66:
        case 77:
        case 82:
        case 88:
          return {
            matrixCoefficients: 'bt601',
            transferCharacteristics: 'bt601',
            primaries: 'bt601',
            fullRange: false,
          }

        default:
          return MP4ColorParser.getDefaultColorInfo()
      }
    } catch (error) {
      console.debug('Error parsing AVC config:', error)
    }
    return MP4ColorParser.getDefaultColorInfo()
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
   * Values from ISO/IEC 23091-2:2019
   *
   * @param value - Color primaries value from container
   * @returns String identifier or null if unknown
   */
  private static mapColorPrimaries(value: number): string | null {
    switch (value) {
      case 0:
        return null
      case 1:
        return 'bt709' // ITU-R BT.709
      case 2:
        return 'unspecified'
      case 4:
        return 'bt470m' // ITU-R BT.470M
      case 5:
        return 'bt470bg' // ITU-R BT.470BG
      case 6:
        return 'bt601' // ITU-R BT.601
      case 7:
        return 'smpte240m' // SMPTE 240M
      case 8:
        return 'film' // Generic film
      case 9:
        return 'bt2020' // ITU-R BT.2020
      case 10:
        return 'smpte428' // SMPTE ST 428-1
      case 11:
        return 'smpte431' // SMPTE RP 431-2
      case 12:
        return 'smpte432' // SMPTE EG 432-1
      case 22:
        return 'jedec-p22' // JEDEC P22
      default:
        return null
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
   * @returns String identifier or null if unknown
   */
  private static mapTransferCharacteristics(value: number): string | null {
    switch (value) {
      case 1:
        return 'bt709'
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
      const minLuminance = reader.readUint32()

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
      const dvLevel = reader.readUint8()
      const rpuFlag = reader.readUint8()
      const elFlag = reader.readUint8()
      const blFlag = reader.readUint8()

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
