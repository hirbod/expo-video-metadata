import type { VideoColorInfo, VideoTrackMetadata } from '../ExpoVideoMetadata.types'
// avi-parser.ts
import { BinaryReaderImpl } from './binary-reader'

export class AVIParser {
  private reader: BinaryReaderImpl

  // AVI chunk IDs
  private static readonly CHUNKS = {
    RIFF: 0x46464952, // 'RIFF'
    AVI_: 0x20495641, // 'AVI '
    LIST: 0x5453494c, // 'LIST'
    hdrl: 0x6c726468,
    avih: 0x68697661,
    strl: 0x6c727473,
    strh: 0x68727473,
    strf: 0x66727473,
    INFO: 0x4f464e49,
    JUNK: 0x4b4e554a,
    vids: 0x73646976,
    auds: 0x73647561,
  }

  constructor(data: Uint8Array) {
    this.reader = new BinaryReaderImpl(data)
  }

  async parse() {
    // Verify RIFF header
    const riffId = this.reader.readUint32()
    if (riffId !== AVIParser.CHUNKS.RIFF) {
      throw new Error('Not a valid AVI file')
    }

    const fileSize = this.reader.readUint32()
    const aviId = this.reader.readUint32()

    if (aviId !== AVIParser.CHUNKS.AVI_) {
      throw new Error('Not a valid AVI file')
    }

    // Parse main AVI header
    const mainHeader = await this.parseMainAVIHeader()
    // Parse stream headers
    const streamInfo = await this.parseStreamHeaders()

    return {
      ...mainHeader,
      ...streamInfo,
      container: 'avi',
    }
  }

  private async parseMainAVIHeader(): Promise<Partial<VideoTrackMetadata>> {
    while (this.reader.canRead(8)) {
      const chunkId = this.reader.readUint32()
      const chunkSize = this.reader.readUint32()

      if (chunkId === AVIParser.CHUNKS.LIST) {
        const listType = this.reader.readUint32()
        if (listType === AVIParser.CHUNKS.hdrl) {
          // Found main AVI header
          const avihChunkId = this.reader.readUint32()
          const avihSize = this.reader.readUint32()

          if (avihChunkId === AVIParser.CHUNKS.avih) {
            return this.parseAVIMainHeader(avihSize)
          }
        } else {
          this.reader.skip(chunkSize - 4)
        }
      } else {
        this.reader.skip(chunkSize)
      }
    }

    throw new Error('No main AVI header found')
  }

  private parseAVIMainHeader(size: number): Partial<VideoTrackMetadata> {
    const microSecPerFrame = this.reader.readUint32()
    const maxBytesPerSec = this.reader.readUint32()
    const paddingGranularity = this.reader.readUint32()
    const flags = this.reader.readUint32()
    const totalFrames = this.reader.readUint32()
    const initialFrames = this.reader.readUint32()
    const streams = this.reader.readUint32()
    const suggestedBufferSize = this.reader.readUint32()
    const width = this.reader.readUint32()
    const height = this.reader.readUint32()
    this.reader.skip(16) // Skip reserved bytes

    const fps = microSecPerFrame > 0 ? 1000000 / microSecPerFrame : 0

    return {
      width,
      height,
      displayAspectWidth: width,
      displayAspectHeight: height,
      fps,
      rotation: 0, // AVI doesn't support rotation metadata
    }
  }

  private async parseStreamHeaders(): Promise<Partial<VideoTrackMetadata>> {
    let videoInfo: Partial<VideoTrackMetadata> = {}

    while (this.reader.canRead(8)) {
      const chunkId = this.reader.readUint32()
      const chunkSize = this.reader.readUint32()

      if (chunkId === AVIParser.CHUNKS.LIST) {
        const listType = this.reader.readUint32()
        if (listType === AVIParser.CHUNKS.strl) {
          // Parse stream header
          const streamHeader = await this.parseStreamHeader()
          if (streamHeader) {
            videoInfo = { ...videoInfo, ...streamHeader }
          }
        } else {
          this.reader.skip(chunkSize - 4)
        }
      } else {
        this.reader.skip(chunkSize)
      }
    }

    return videoInfo
  }

  private async parseStreamHeader(): Promise<Partial<VideoTrackMetadata> | null> {
    const strhId = this.reader.readUint32()
    const strhSize = this.reader.readUint32()

    if (strhId !== AVIParser.CHUNKS.strh) {
      this.reader.skip(strhSize)
      return null
    }

    const streamType = this.reader.readUint32()
    if (streamType !== AVIParser.CHUNKS.vids) {
      this.reader.skip(strhSize - 4)
      return null
    }

    // Parse video stream header
    const codec = this.readFourCC()
    const flags = this.reader.readUint32()
    const priority = this.reader.readUint16()
    const language = this.reader.readUint16()
    const initialFrames = this.reader.readUint32()
    const scale = this.reader.readUint32()
    const rate = this.reader.readUint32()
    const start = this.reader.readUint32()
    const length = this.reader.readUint32()
    const suggestedBufferSize = this.reader.readUint32()
    const quality = this.reader.readUint32()
    const sampleSize = this.reader.readUint32()

    // Parse BITMAPINFOHEADER in strf chunk
    const strfId = this.reader.readUint32()
    const strfSize = this.reader.readUint32()

    if (strfId === AVIParser.CHUNKS.strf) {
      const biSize = this.reader.readUint32()
      const biWidth = this.reader.readUint32()
      const biHeight = this.reader.readUint32()
      const biPlanes = this.reader.readUint16()
      const biBitCount = this.reader.readUint16()
      const biCompression = this.readFourCC()
      const biSizeImage = this.reader.readUint32()
      const biXPelsPerMeter = this.reader.readUint32()
      const biYPelsPerMeter = this.reader.readUint32()
      const biClrUsed = this.reader.readUint32()
      const biClrImportant = this.reader.readUint32()

      return {
        width: biWidth,
        height: Math.abs(biHeight), // Height might be negative for top-down images
        displayAspectWidth: biWidth,
        displayAspectHeight: Math.abs(biHeight),
        codec: this.formatCodec(codec),
        fps: rate / scale,
        colorInfo: this.getDefaultColorInfo(), // AVI doesn't support HDR
      }
    }

    return null
  }

  private readFourCC(): string {
    const bytes = this.reader.read(4)
    return String.fromCharCode(...bytes).trim()
  }

  private formatCodec(fourCC: string): string {
    // Convert common FourCC codes to standard codec names
    const codecMap: { [key: string]: string } = {
      DIV3: 'divx3',
      DIVX: 'divx',
      DX50: 'divx5',
      XVID: 'xvid',
      MP42: 'mp42',
      MP43: 'mp43',
      H264: 'avc1',
      X264: 'avc1',
      DAVC: 'avc1',
      HEVC: 'hev1',
      MPG1: 'mpeg1',
      MPG2: 'mpeg2',
    }

    return codecMap[fourCC.toUpperCase()] || fourCC.toLowerCase()
  }

  private getDefaultColorInfo(): VideoColorInfo {
    return {
      matrixCoefficients: null,
      transferCharacteristics: null,
      primaries: null,
      fullRange: null,
    }
  }
}
