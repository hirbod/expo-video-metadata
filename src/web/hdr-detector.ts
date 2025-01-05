// hdr-detector.ts
import type { VideoColorInfo } from '../ExpoVideoMetadata.types'

/**
 * Class responsible for detecting HDR (High Dynamic Range)
 *
 * Supports:
 * - HDR10/HDR10+ (BT.2020 + PQ/SMPTE2084)
 * - Dolby Vision (SMPTE2084/BT.1361 + ICtCp)
 * - HLG (Hybrid Log-Gamma)
 * - Advanced HDR by Technicolor
 */
export class HdrDetector {
  /**
   * Determines if the given color information represents HDR content.
   * Checks for various HDR formats:
   * - HDR10/HDR10+ (BT.2020 + PQ)
   * - HLG (BT.2020 + HLG)
   * - Dolby Vision (PQ/BT.1361 + ICtCp)
   * - Advanced HDR by Technicolor
   *
   * @param colorInfo - Color information to check
   * @returns boolean True if HDR content is detected
   */
  static isHdr(colorInfo: VideoColorInfo): boolean {
    // HDR10/HDR10+
    const isHdr10 =
      colorInfo.primaries === 'bt2020' &&
      colorInfo.transferCharacteristics === 'smpte2084' &&
      (colorInfo.matrixCoefficients === 'bt2020nc' ||
        colorInfo.matrixCoefficients === 'bt2020c' ||
        colorInfo.matrixCoefficients === 'ictcp')

    // HLG (Hybrid Log-Gamma)
    const isHlg =
      colorInfo.primaries === 'bt2020' &&
      (colorInfo.transferCharacteristics === 'hlg' ||
        colorInfo.transferCharacteristics === 'arib-std-b67')

    // Dolby Vision
    const isDolbyVision =
      (colorInfo.transferCharacteristics === 'smpte2084' ||
        colorInfo.transferCharacteristics === 'bt1361') &&
      colorInfo.matrixCoefficients === 'ictcp'

    // Advanced HDR by Technicolor
    const isAdvancedHdr =
      colorInfo.primaries === 'bt2020' &&
      colorInfo.transferCharacteristics === 'smpte428' &&
      colorInfo.matrixCoefficients === 'bt2020nc'

    return isHdr10 || isHlg || isDolbyVision || isAdvancedHdr
  }
}
