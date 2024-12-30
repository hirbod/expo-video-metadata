// mov-parser.ts
import { MP4Parser } from './mp4-parser';
import { BinaryReaderImpl } from './binary-reader';
import type { MP4Box, VideoTrackMetadata, ParsedVideoMetadata } from '../ExpoVideoMetadata.types';

export class MOVParser extends MP4Parser {
  // Additional QuickTime specific atoms
  private static readonly QT_ATOMS = {
    CLAP: 'clap', // Clean aperture
    TAPT: 'tapt', // Track aperture mode dimensions
    FIEL: 'fiel', // Field handling
    CTMD: 'ctmd'  // Content mode dimensions
  };

  public async parse(): Promise<ParsedVideoMetadata> {
    const metadata = await super.parse();
    return {
      ...metadata,
      container: 'mov'
    };
  }

  protected async parseVideoTrack(trak: MP4Box): Promise<VideoTrackMetadata> {
    // Get base metadata from MP4 parser
    const baseMetadata = await super.parseVideoTrack(trak);

    // Parse QuickTime specific boxes
    const trakBoxes = await this.parseBoxes(trak.data!);
    const stsd = this.findBox(trakBoxes, 'stsd');

    if (stsd) {
      const stsdBoxes = await this.parseBoxes(stsd.data!);

      // Parse clean aperture if present
      const clap = this.findBox(stsdBoxes, MOVParser.QT_ATOMS.CLAP);
      if (clap) {
        const { width, height } = this.parseClap(clap);
        if (width && height) {
          baseMetadata.displayAspectWidth = width;
          baseMetadata.displayAspectHeight = height;
        }
      }

      // Parse track aperture mode dimensions
      const tapt = this.findBox(trakBoxes, MOVParser.QT_ATOMS.TAPT);
      if (tapt) {
        const { width, height } = await this.parseTapt(tapt);
        if (width && height) {
          // TAPT takes precedence over CLAP if both exist
          baseMetadata.displayAspectWidth = width;
          baseMetadata.displayAspectHeight = height;
        }
      }
    }

    return baseMetadata;
  }

  private parseClap(clap: MP4Box): { width?: number; height?: number } {
    const reader = new BinaryReaderImpl(clap.data!);

    const cleanApertureWidthN = reader.readUint32();
    const cleanApertureWidthD = reader.readUint32();
    const cleanApertureHeightN = reader.readUint32();
    const cleanApertureHeightD = reader.readUint32();

    if (cleanApertureWidthD !== 0 && cleanApertureHeightD !== 0) {
      return {
        width: Math.round(cleanApertureWidthN / cleanApertureWidthD),
        height: Math.round(cleanApertureHeightN / cleanApertureHeightD)
      };
    }

    return {};
  }

  private async parseTapt(tapt: MP4Box): Promise<{ width?: number; height?: number }> {
    const taptBoxes = await this.parseBoxes(tapt.data!);

    // Look for clef (clean aperture dimensions) box
    const clef = this.findBox(taptBoxes, 'clef');
    if (clef) {
      const reader = new BinaryReaderImpl(clef.data!);
      reader.skip(8); // Skip version and flags

      const width = reader.readUint32() >> 16;
      const height = reader.readUint32() >> 16;

      return { width, height };
    }

    return {};
  }
}