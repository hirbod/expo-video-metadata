// hdr-detector.ts
import type { VideoColorInfo } from '../ExpoVideoMetadata.types'

/**
 * Class responsible for detecting HDR (High Dynamic Range)
 *
 * Supports:
 * - HDR10/HDR10+ (BT.2020 + PQ/SMPTE2084)
 * - Dolby Vision (SMPTE2084/BT.1361 + ICtCp)
 * - HLG (BT.2020 + HLG/BT.2100-HLG)
 * - Advanced HDR by Technicolor (BT.2020 + SMPTE428)
 */
export class HdrDetector {
  /**
   * Determines if the given color information represents HDR content.
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
      (colorInfo.transferCharacteristics === 'arib-std-b67' ||
        colorInfo.transferCharacteristics === 'bt2100-hlg')

    // Dolby Vision
    const isDolbyVision =
      (colorInfo.transferCharacteristics === 'smpte2084' ||
        colorInfo.transferCharacteristics === 'bt1361') &&
      colorInfo.matrixCoefficients === 'ictcp'

    // Advanced HDR by Technicolor
    const isAdvancedHdr =
      colorInfo.primaries === 'bt2020' &&
      colorInfo.transferCharacteristics === 'smpte428' &&
      (colorInfo.matrixCoefficients === 'bt2020nc' || colorInfo.matrixCoefficients === 'bt2020c')

    return isHdr10 || isHlg || isDolbyVision || isAdvancedHdr
  }
}
