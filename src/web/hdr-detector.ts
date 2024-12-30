// hdr-detector.ts
import { VideoColorInfo } from "../ExpoVideoMetadata.types";
import { BinaryReaderImpl } from "./binary-reader";

export class HdrDetector {

static parseMP4ColorInfo(data: Uint8Array): VideoColorInfo {
    try {
        const reader = new BinaryReaderImpl(data);
        const colourType = reader.readString(4);
        console.debug('Color type:', colourType);
        console.debug('Raw data:', Array.from(data).map(b => b.toString(16)));

        switch(colourType) {
            case 'nclx':
            case 'nclc':
                const primaries = reader.readUint16();
                const transfer = reader.readUint16();
                const matrix = reader.readUint16();
                const fullRange = colourType === 'nclx' ? (reader.readUint8() & 0x80) !== 0 : null;
                return {
                    matrixCoefficients: this.mapMatrixCoefficients(matrix),
                    transferCharacteristics: this.mapTransferCharacteristics(transfer),
                    primaries: this.mapColorPrimaries(primaries),
                    fullRange
                };
            case 'rICC':
            case 'prof':
                return {
                    matrixCoefficients: 'rgb',
                    transferCharacteristics: null,
                    primaries: null,
                    fullRange: true
                };
        }
    } catch (error) {
        console.debug('Error parsing color info:', error);
    }

    return this.getDefaultColorInfo();
}



  static parseWebMColorInfo(data: Uint8Array): VideoColorInfo {
    try {
      const reader = new BinaryReaderImpl(data);
      let matrixCoefficients: string | null = null;
      let transferCharacteristics: string | null = null;
      let primaries: string | null = null;
      let fullRange: boolean | null = null;

      while (reader.remaining() >= 2) {
        const id = reader.readVint();
        const size = reader.readVint();

        if (reader.remaining() < size) break;

        switch (id) {
          case 0x55B1: // MatrixCoefficients
            matrixCoefficients = this.mapMatrixCoefficients(reader.readUint8());
            break;
          case 0x55B2: // BitsPerChannel
            fullRange = reader.readUint8() === 0;
            break;
          case 0x55B9: // TransferCharacteristics
            transferCharacteristics = this.mapTransferCharacteristics(reader.readUint8());
            break;
          case 0x55BA: // Primaries
            primaries = this.mapColorPrimaries(reader.readUint8());
            break;
          default:
            reader.skip(Number(size));
        }
      }

      return {
        matrixCoefficients,
        transferCharacteristics,
        primaries,
        fullRange
      };
    } catch (error) {
      return this.getDefaultColorInfo();
    }
  }

private static mapColorPrimaries(value: number): string | null {
    switch (value) {
        case 0: return null;
        case 1: return 'bt709';      // ITU-R BT.709
        case 4: return 'bt470m';     // ITU-R BT.470M
        case 5: return 'bt470bg';    // ITU-R BT.470BG
        case 6: return 'bt601';      // ITU-R BT.601
        case 7: return 'smpte240m';  // SMPTE 240M
        case 8: return 'film';       // Film
        case 9: return 'bt2020';     // ITU-R BT.2020
        case 10: return 'smpte428';  // SMPTE ST 428-1
        case 11: return 'smpte431';  // SMPTE RP 431-2
        case 12: return 'smpte432';  // SMPTE EG 432-1
        case 22: return 'ebu3213';   // EBU Tech. 3213-E
        default: return null;
    }
}

private static mapTransferCharacteristics(value: number): string | null {
    switch (value) {
        case 0: return null;
        case 1: return 'bt709';        // ITU-R BT.709
        case 4: return 'gamma22';      // Gamma 2.2
        case 5: return 'gamma28';      // Gamma 2.8
        case 6: return 'bt601';        // ITU-R BT.601
        case 7: return 'smpte240m';    // SMPTE 240M
        case 8: return 'linear';       // Linear
        case 11: return 'log100';      // LOG 100:1
        case 12: return 'log316';      // LOG 316.22777:1
        case 13: return 'iec61966-2-4';// IEC 61966-2-4
        case 14: return 'bt1361';      // ITU-R BT.1361
        case 15: return 'srgb';        // sRGB/sYCC
        case 16: return 'bt2020-10';   // BT.2020 10-bit
        case 17: return 'bt2020-12';   // BT.2020 12-bit
        case 18: return 'smpte2084';   // SMPTE ST 2084 (HDR10)
        case 19: return 'smpte428';    // SMPTE ST 428-1
        default: return null;
    }
}

private static mapMatrixCoefficients(value: number): string | null {
    switch (value) {
        case 0: return 'rgb';          // Identity/RGB
        case 1: return 'bt709';        // ITU-R BT.709
        case 4: return 'fcc';          // US FCC 73.682
        case 5: return 'bt470bg';      // ITU-R BT.470BG
        case 6: return 'bt601';        // ITU-R BT.601
        case 7: return 'smpte240m';    // SMPTE 240M
        case 8: return 'ycgco';        // YCgCo
        case 9: return 'bt2020nc';     // BT.2020 non-constant
        case 10: return 'bt2020c';     // BT.2020 constant
        case 11: return 'smpte2085';   // SMPTE ST 2085
        default: return null;
    }
}

  private static getDefaultColorInfo(): VideoColorInfo {
    return {
      matrixCoefficients: null,
      transferCharacteristics: null,
      primaries: null,
      fullRange: null
    };
  }

  static isHdr(colorInfo: VideoColorInfo): boolean {
    // HDR10
    const isHdr10 =
      colorInfo.primaries === 'bt2020' &&
      colorInfo.transferCharacteristics === 'smpte2084' &&
      (colorInfo.matrixCoefficients === 'bt2020nc' ||
       colorInfo.matrixCoefficients === 'bt2020c');

    // HLG
    const isHlg =
      colorInfo.primaries === 'bt2020' &&
      colorInfo.transferCharacteristics === 'arib-std-b67' &&
      (colorInfo.matrixCoefficients === 'bt2020nc' ||
       colorInfo.matrixCoefficients === 'bt2020c');

    return isHdr10 || isHlg;
  }
}