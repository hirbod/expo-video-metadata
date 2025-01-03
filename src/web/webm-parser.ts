import type {
  ParsedVideoMetadata,
  VideoColorInfo,
  VideoTrackMetadata,
  WebMElement,
} from '../ExpoVideoMetadata.types'
// WebM parser with full support for video/audio codecs and metadata parsing
import { BinaryReaderImpl } from './binary-reader'

export class WebMParser {
  protected reader: BinaryReaderImpl

  // EBML element IDs for WebM container format
  protected static readonly ELEMENTS = {
    EBML: 0x1a45dfa3,
    Segment: 0x18538067,
    Info: 0x1549a966,
    Tracks: 0x1654ae6b,
    TrackEntry: 0xae,
    TrackType: 0x83,
    Video: 0xe0,
    Audio: 0xe1,
    TrackNumber: 0xd7,
    TrackUID: 0x73c5,
    FlagLacing: 0x9c,
    Language: 0x22b59c,
    CodecID: 0x86,
    CodecName: 0x258688,
    CodecPrivate: 0x63a2,
    Channels: 0x9f,
    SamplingFrequency: 0xb5,
    BitDepth: 0x6264,
    AudioBitrate: 0x4d80,
    VideoBitrate: 0x4d81,
    PixelWidth: 0xb0,
    PixelHeight: 0xba,
    DisplayWidth: 0x54b0,
    DisplayHeight: 0x54ba,
    DisplayUnit: 0x54b2,
    ColourSpace: 0x2eb524,
    Colour: 0x55b0,
    DefaultDuration: 0x23e383,
    TimecodeScale: 0x2ad7b1,
    Duration: 0x4489,
  }

  constructor(data: Uint8Array) {
    this.reader = new BinaryReaderImpl(data)
  }

  public async parse(): Promise<ParsedVideoMetadata> {
    const ebml = this.readElement()
    if (!ebml || ebml.id !== WebMParser.ELEMENTS.EBML) {
      throw new Error('Not a valid WebM file')
    }

    const segment = this.readElement()
    if (!segment || segment.id !== WebMParser.ELEMENTS.Segment) {
      throw new Error('No Segment element found')
    }

    // Parse duration info
    let duration = 0
    let timescale = 1000000 // Default microseconds

    const info = this.findElement(segment.data, WebMParser.ELEMENTS.Info)
    if (info?.data) {
      console.log(
        'Info data:',
        Array.from(info.data)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ')
      )

      const timeScale = this.findElement(info.data, WebMParser.ELEMENTS.TimecodeScale)
      const durationElement = this.findElement(info.data, WebMParser.ELEMENTS.Duration)

      if (timeScale?.data) {
        timescale = this.readUintFromElement(timeScale)
      }

      if (durationElement?.data) {
        const rawDuration = this.readUintFromElement(durationElement)
        duration = (rawDuration * timescale) / 1000000000
        console.log('Duration calculation:', { rawDuration, timescale, duration })
      }
    }

    const tracks = this.findElement(segment.data, WebMParser.ELEMENTS.Tracks)
    if (!tracks) {
      throw new Error('No Tracks element found')
    }

    const videoTrack = this.findVideoTrack(tracks.data)
    if (!videoTrack) {
      throw new Error('No video track found')
    }

    const { width, height, codec } = this.parseVideoTrack(videoTrack)

    const bitrate = duration ? Math.floor((this.reader.length * 8) / duration) : undefined

    return {
      width,
      height,
      rotation: 0,
      displayAspectWidth: width,
      displayAspectHeight: height,
      colorInfo: this.getDefaultColorInfo(),
      codec,
      duration,
      fileSize: this.reader.length,
      bitrate,
      hasAudio: false,
      audioChannels: 0,
      audioSampleRate: 0,
      audioCodec: '',
      container: 'webm',
    }
  }

  protected findElement(data: Uint8Array, targetId: number): WebMElement | null {
    let offset = 0

    while (offset < data.length) {
      const reader = new BinaryReaderImpl(data.slice(offset))
      const id = reader.readVint()
      const size = reader.readVint()

      console.log('Found element:', {
        id: id.toString(16),
        targetId: targetId.toString(16),
        size,
        offset,
      })

      if (id === targetId) {
        const elementData = data.slice(offset + reader.offset, offset + reader.offset + size)
        return {
          id,
          size,
          data: elementData,
          offset,
        }
      }

      // Make sure we're making progress
      const skip = reader.offset + size
      if (skip <= 0) break
      offset += skip
    }
    return null
  }

  protected readElement(): WebMElement | null {
    if (this.reader.remaining() < 2) return null

    const startOffset = this.reader.offset
    const id = this.reader.readVint()
    const size = this.reader.readVint()

    if (size > this.reader.remaining()) return null

    const data = this.reader.read(size)

    return {
      id,
      size,
      data,
      offset: startOffset,
    }
  }

  protected findVideoTrack(data: Uint8Array): WebMElement | null {
    const reader = new BinaryReaderImpl(data)

    while (reader.remaining() > 0) {
      const elementStart = reader.offset
      const id = reader.readVint()
      const size = reader.readVint()

      if (id === 0xae || id === 0x2e) {
        const trackData = reader.data.slice(reader.offset, reader.offset + size)
        const trackReader = new BinaryReaderImpl(trackData)

        // Track info map for debugging
        const trackInfo: {
          type?: number
          codec?: string
          hasVideo?: boolean
          videoData?: Uint8Array
        } = {}

        while (trackReader.remaining() > 0) {
          const subId = trackReader.readVint()
          const subSize = trackReader.readVint()

          if (subId === 0x83 || subId === 0x03) {
            const type = trackReader.read(1)[0]
            trackInfo.type = type
            if (type === 1) {
              console.log('Found video track:', trackInfo)
              return {
                id,
                size,
                data: trackData,
                offset: reader.offset,
              }
            }
          } else if (subId === 0x86) {
            // CodecID
            const codecData = trackReader.read(subSize)
            trackInfo.codec = new TextDecoder().decode(codecData)
          } else if (subId === 0xe0 || subId === 0x60) {
            // Video
            trackInfo.hasVideo = true
            const videoData = trackReader.read(subSize)
            trackInfo.videoData = new Uint8Array(videoData.slice(0, 16))
          } else {
            trackReader.skip(subSize)
          }
        }
        console.log('Track info:', trackInfo)
      }
      reader.skip(size)
    }
    return null
  }

  protected parseVideoTrack(track: WebMElement): VideoTrackMetadata {
    const data = track.data
    let width = 0
    let height = 0
    let codec = ''
    let foundWidth = false // Flag to only use first width

    // Find bytes
    for (let i = 0; i < data.length - 4; i++) {
      // Width (0xB0 0x82 followed by 2 bytes)
      if (!foundWidth && data[i] === 0xb0 && data[i + 1] === 0x82) {
        width = (data[i + 2] << 8) | data[i + 3]
        foundWidth = true
        console.log('Found width bytes:', data[i + 2], data[i + 3], width)
      }
      // Height (0xBA 0x81 followed by 1 byte)
      if (data[i] === 0xba && data[i + 1] === 0x81) {
        height = data[i + 2]
        console.log('Found height bytes:', data[i + 2], height)
      }
      // Codec (0x86 0x85)
      if (data[i] === 0x86 && data[i + 1] === 0x85) {
        const codecData = data.slice(i + 2, i + 7)
        codec = new TextDecoder().decode(codecData)
      }
    }

    console.log('Dimensions found:', { width, height, codec })

    return {
      width,
      height,
      rotation: 0,
      displayAspectWidth: width,
      displayAspectHeight: height,
      colorInfo: this.getDefaultColorInfo(),
      codec,
    }
  }

  protected async findAudioTrack(data: Uint8Array): Promise<WebMElement | null> {
    const reader = new BinaryReaderImpl(data)

    while (reader.remaining() > 0) {
      const id = reader.readVint()
      const size = reader.readVint()

      if (id === WebMParser.ELEMENTS.TrackEntry) {
        const trackData = reader.read(size)
        const trackReader = new BinaryReaderImpl(trackData)

        // Check if it's audio track (type = 2)
        while (trackReader.remaining() > 0) {
          const subId = trackReader.readVint()
          const subSize = trackReader.readVint()

          if (subId === WebMParser.ELEMENTS.TrackType && subSize === 1) {
            if (trackReader.read(1)[0] === 2) {
              return { id, size, data: trackData, offset: reader.offset }
            }
          } else {
            trackReader.skip(subSize)
          }
        }
      }
      reader.skip(size)
    }
    return null
  }

  protected parseAudioTrack(track: WebMElement): {
    hasAudio: boolean
    audioChannels: number
    audioSampleRate: number
    audioCodec: string
  } {
    const data = track.data
    let channels = 0
    let sampleRate = 0
    let codec = ''

    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0x9f) {
        // Channels
        channels = data[i + 2]
      }
      if (data[i] === 0xb5) {
        // SampleRate
        sampleRate = (data[i + 2] << 8) | data[i + 3]
      }
      if (data[i] === 0x86) {
        // Codec
        const codecLength = 5
        const codecData = data.slice(i + 2, i + 2 + codecLength)
        codec = new TextDecoder().decode(codecData)
      }
    }

    return {
      hasAudio: true,
      audioChannels: channels,
      audioSampleRate: sampleRate,
      audioCodec: codec,
    }
  }

  protected readUintFromElement(element: WebMElement | null): number {
    if (!element || !element.data) return 0

    try {
      const reader = new BinaryReaderImpl(element.data)
      let value = 0
      while (reader.remaining() > 0) {
        value = (value << 8) | reader.readUint8()
      }
      return value
    } catch (error) {
      console.warn('Error reading uint:', error)
      return 0
    }
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
