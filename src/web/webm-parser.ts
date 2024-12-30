// webm-parser.ts
import { BinaryReaderImpl } from './binary-reader';
import { HdrDetector } from './hdr-detector';
import { FpsDetector } from './fps-detector';
import type { WebMElement, VideoTrackMetadata, ParsedVideoMetadata, VideoColorInfo } from '../ExpoVideoMetadata.types';

export class WebMParser {
  protected reader: BinaryReaderImpl;

  // EBML element IDs
  protected static readonly ELEMENTS = {
    EBML: 0x1A45DFA3,
    Segment: 0x18538067,
    Info: 0x1549A966,
    Tracks: 0x1654AE6B,
    TrackEntry: 0xAE,
    TrackType: 0x83,
    TrackNumber: 0xD7,
    TrackUID: 0x73C5,
    FlagLacing: 0x9C,
    Language: 0x22B59C,
    CodecID: 0x86,
    CodecName: 0x258688,
    Video: 0xE0,
    Audio: 0xE1,
    PixelWidth: 0xB0,
    PixelHeight: 0xBA,
    DisplayWidth: 0x54B0,
    DisplayHeight: 0x54BA,
    DisplayUnit: 0x54B2,
    ColourSpace: 0x2EB524,
    Colour: 0x55B0,
    DefaultDuration: 0x23E383,
    TimecodeScale: 0x2AD7B1,
    Duration: 0x4489
  };

  constructor(data: Uint8Array) {
    this.reader = new BinaryReaderImpl(data);
  }

  public async parse(): Promise<ParsedVideoMetadata> {
    // Verify EBML header
    const ebml = this.readElement();
    if (!ebml || ebml.id !== WebMParser.ELEMENTS.EBML) {
      throw new Error('Not a valid WebM file');
    }

    // Find Segment element
    const segment = this.readElement();
    if (!segment || segment.id !== WebMParser.ELEMENTS.Segment) {
      throw new Error('No Segment element found');
    }

    // Find Tracks element
    const tracks = this.findElement(segment.data, WebMParser.ELEMENTS.Tracks);
    if (!tracks) {
      throw new Error('No Tracks element found');
    }

    // Find video track
    const videoTrack = this.findVideoTrack(tracks.data);
    if (!videoTrack) {
      throw new Error('No video track found');
    }

    const metadata = this.parseVideoTrack(videoTrack);
    return {
      ...metadata,
      container: 'webm'
    };
  }

  protected readElement(): WebMElement | null {
    try {
      if (this.reader.remaining() < 2) return null;

      const id = this.reader.readVint();
      if (this.reader.remaining() < 1) return null;

      const size = this.reader.readVint();
      if (size > this.reader.remaining()) return null;

      const data = this.reader.read(Number(size));

      return {
        id,
        size: Number(size),
        data,
        offset: this.reader.offset
      };
    } catch (error) {
      console.debug('Error reading EBML element:', error);
      return null;
    }
  }

  protected findElement(data: Uint8Array, targetId: number): WebMElement | null {
    try {
      const localReader = new BinaryReaderImpl(data);

      while (localReader.remaining() >= 2) {
        const id = localReader.readVint();
        if (localReader.remaining() < 1) break;

        const size = localReader.readVint();
        if (size > localReader.remaining()) break;

        if (id === targetId) {
          return {
            id,
            size: Number(size),
            data: localReader.read(Number(size)),
            offset: localReader.offset
          };
        }

        localReader.skip(Number(size));
      }
    } catch (error) {
      console.debug('Error finding EBML element:', error);
    }

    return null;
  }

  protected findVideoTrack(data: Uint8Array): WebMElement | null {
    try {
      const localReader = new BinaryReaderImpl(data);

      while (localReader.remaining() >= 2) {
        const id = localReader.readVint();
        if (localReader.remaining() < 1) break;

        const size = localReader.readVint();
        if (size > localReader.remaining()) break;

        const trackData = localReader.read(Number(size));

        if (id === WebMParser.ELEMENTS.TrackEntry) {
          const type = this.findElement(trackData, WebMParser.ELEMENTS.TrackType);
          if (type && type.data[0] === 1) { // 1 = video track
            return {
              id,
              size: Number(size),
              data: trackData,
              offset: localReader.offset
            };
          }
        } else {
          localReader.skip(Number(size));
        }
      }
    } catch (error) {
      console.debug('Error finding video track:', error);
    }

    return null;
  }

  protected parseVideoTrack(track: WebMElement): VideoTrackMetadata {
    let width = 0;
    let height = 0;
    let displayWidth = 0;
    let displayHeight = 0;
    let fps: number | undefined;
    let codec = '';

    try {
      const video = this.findElement(track.data, WebMParser.ELEMENTS.Video);
      if (!video) {
        throw new Error('No video element found in track');
      }

      // Get dimensions
      const pixelWidth = this.findElement(video.data, WebMParser.ELEMENTS.PixelWidth);
      const pixelHeight = this.findElement(video.data, WebMParser.ELEMENTS.PixelHeight);
      const displayWidthElem = this.findElement(video.data, WebMParser.ELEMENTS.DisplayWidth);
      const displayHeightElem = this.findElement(video.data, WebMParser.ELEMENTS.DisplayHeight);

      width = pixelWidth ? this.readUintFromElement(pixelWidth) : 0;
      height = pixelHeight ? this.readUintFromElement(pixelHeight) : 0;
      displayWidth = displayWidthElem ? this.readUintFromElement(displayWidthElem) : width;
      displayHeight = displayHeightElem ? this.readUintFromElement(displayHeightElem) : height;

      // Get codec
      const codecId = this.findElement(track.data, WebMParser.ELEMENTS.CodecID);
      if (codecId) {
        codec = new TextDecoder().decode(codecId.data).trim();
      }

      // Get FPS
      const defaultDuration = this.findElement(track.data, WebMParser.ELEMENTS.DefaultDuration);
      if (defaultDuration) {
        const duration = this.readUintFromElement(defaultDuration);
        if (duration > 0) {
          fps = Math.round((1_000_000_000 / duration) * 1000) / 1000;
        }
      }

      // Get color info
      const colour = this.findElement(video.data, WebMParser.ELEMENTS.Colour);
      const colorInfo = colour ?
        HdrDetector.parseWebMColorInfo(colour.data) :
        this.getDefaultColorInfo();

      return {
        width,
        height,
        rotation: 0, // WebM doesn't support rotation metadata
        displayAspectWidth: displayWidth,
        displayAspectHeight: displayHeight,
        colorInfo,
        codec,
        fps
      };
    } catch (error) {
      console.debug('Error parsing video track:', error);
      return {
        width,
        height,
        rotation: 0,
        displayAspectWidth: displayWidth,
        displayAspectHeight: displayHeight,
        colorInfo: this.getDefaultColorInfo(),
        codec,
        fps
      };
    }
  }

  protected readUintFromElement(element: WebMElement): number {
    try {
      const reader = new BinaryReaderImpl(element.data);
      let value = 0;
      while (reader.remaining() > 0) {
        value = (value << 8) | reader.readUint8();
      }
      return value;
    } catch (error) {
      console.debug('Error reading uint from element:', error);
      return 0;
    }
  }

  private getDefaultColorInfo(): VideoColorInfo {
    return {
      matrixCoefficients: null,
      transferCharacteristics: null,
      primaries: null,
      fullRange: null
    };
  }
}