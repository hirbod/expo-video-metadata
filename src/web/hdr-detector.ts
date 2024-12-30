// hdr-detector.ts
import { VideoColorInfo } from "../ExpoVideoMetadata.types";
import { BinaryReaderImpl } from "./binary-reader";

export class HdrDetector {

static parseMP4ColorInfo(data: Uint8Array): VideoColorInfo {
    try {
        const reader = new BinaryReaderImpl(data);
        console.debug('Parsing color data of length:', data.length, 'First bytes:', Array.from(data.slice(0, 4)));

        // Check for HEVC/AVC configs first
        if (data[0] === 1) {
            if (data[1] === 0x22) {
                return this.parseHEVCConfig(reader);
            }
            if (data[1] === 0x64 || data[1] === 0x4D || data[1] === 0x42) {
                return this.parseAVCConfig(reader);
            }
        }

        const colourType = reader.readString(4);
        console.debug('Color type:', colourType, 'Data length:', data.length);
        console.debug('Raw data:', Array.from(data).map(b => b.toString(16)));

        // Rest of the existing logic...
    } catch (error) {
        console.debug('Error parsing color info:', error, 'Data:', Array.from(data));
    }
    return this.getDefaultColorInfo();
}



private static parseAVCConfig(reader: BinaryReaderImpl): VideoColorInfo {
   try {
       const configurationVersion = reader.readUint8();
       const profileIdc = reader.readUint8();
       const profileCompatibility = reader.readUint8();
       const levelIdc = reader.readUint8();

       console.debug('AVC config:', { configurationVersion, profileIdc, profileCompatibility, levelIdc });

       // Check profiles
       switch(profileIdc) {
           // High 10, High 10 Intra
           case 110:
           case 122:
               return {
                   matrixCoefficients: 'bt2020nc',
                   transferCharacteristics: 'bt2100-pq',
                   primaries: 'bt2020',
                   fullRange: true
               };

           // High, High Intra, High Progressive
           case 100:
           case 118:
           case 44:
               return {
                   matrixCoefficients: 'bt709',
                   transferCharacteristics: 'bt709',
                   primaries: 'bt709',
                   fullRange: false
               };

           // Main, Main Intra
           case 77:
           case 88:
               return {
                   matrixCoefficients: 'bt601',
                   transferCharacteristics: 'bt601',
                   primaries: 'bt601',
                   fullRange: false
               };

           // Baseline, Extended, Constrained Baseline
           case 66:
           case 88:
           case 82:
               return {
                   matrixCoefficients: 'bt601',
                   transferCharacteristics: 'bt601',
                   primaries: 'bt601',
                   fullRange: false
               };

           default:
               return this.getDefaultColorInfo();
       }
   } catch (error) {
       console.debug('Error parsing AVC config:', error);
   }
   return this.getDefaultColorInfo();
}

static parseHEVCConfig(reader: BinaryReaderImpl): VideoColorInfo {
   try {
       const configVersion = reader.readUint8();
       console.debug('HEVC config version:', configVersion);

       const generalProfileSpace = reader.readUint8();
       console.debug('General profile space:', generalProfileSpace);

       const profileIdc = generalProfileSpace & 0x1F;
       console.debug('Profile IDC:', profileIdc);

       // Read compatibility and constraint flags
       const constraintFlags: number[] = [];
       for (let i = 0; i < 6; i++) {
           constraintFlags.push(reader.readUint8());
       }
       console.debug('Constraint flags:', constraintFlags);

       const levelIdc = reader.readUint8();
       console.debug('Level IDC:', levelIdc);

       if (profileIdc === 2 || constraintFlags[1] & 0x40) {
           return {
               matrixCoefficients: 'bt2020nc',
               transferCharacteristics: 'smpte2084',
               primaries: 'bt2020',
               fullRange: true
           };
       }
   } catch (error) {
       console.debug('Error parsing HEVC config:', error);
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
        case 1: return 'bt709';
        case 4: return 'gamma22';
        case 5: return 'gamma28';
        case 6: return 'bt601';
        case 7: return 'smpte240m';
        case 8: return 'linear';
        case 11: return 'log100';
        case 12: return 'log316';
        case 13: return 'iec61966-2-4';
        case 14: return 'bt1361';
        case 15: return 'srgb';
        case 16: return 'bt2020-10';
        case 17: return 'bt2020-12';
        case 18: return 'smpte2084';
        case 19: return 'smpte428';
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