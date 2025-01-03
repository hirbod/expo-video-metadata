import type {
  ParsedVideoMetadata,
  VideoColorInfo,
  VideoContainer,
  WebMElement,
} from '../ExpoVideoMetadata.types'
// WebM parser with full support for video/audio codecs and metadata parsing
import { BinaryReaderImpl } from './binary-reader'

/**
 * Parser for WebM/MKV container formats using EBML structure
 * - WebM is a subset of Matroska optimized for web delivery
 * - Both use EBML (Extensible Binary Meta Language) for data structure
 * - Supports VP8/VP9 video and Vorbis/Opus audio codecs
 */
export class WebMParser {
  protected reader: BinaryReaderImpl

  // EBML element IDs for WebM/MKV container format
  // Each ID uniquely identifies different parts of the container structure
  // IDs can be variable length, but common elements use fixed lengths
  protected static readonly ELEMENTS = {
    EBML: 0x1a45dfa3, // Root element that marks file as EBML (4 bytes)
    DocType: 0x4282, // Document type - 'webm' or 'matroska' (2 bytes)
    DocTypeVersion: 0x4287,
    DocTypeReadVersion: 0x4285,
    Segment: 0x18538067, // Contains all metadata and media data (4 bytes)
    Info: 0x549a966, // Segment information like timescale, duration (3 bytes)
    Tracks: 0x1654ae6b, // Contains all track information (4 bytes)
    TrackEntry: 0x2e, // Use short form ID
    TrackEntryLong: 0xae35, // Long form ID (some files use this)
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
    TimecodeScale: 0xad7b1,
    Duration: 0x489,
    ContentEncoding: 0x6240,
    ContentCompression: 0x5034,
    ContentCompSettings: 0x5035,
  }

  constructor(data: Uint8Array) {
    this.reader = new BinaryReaderImpl(data)
  }

  /**
   * Parses a WebM file and extracts video metadata
   * @returns Promise<ParsedVideoMetadata> Object containing video metadata
   * @throws Error if file is not a valid WebM/MKV file or required elements are missing
   */
  public async parse(): Promise<ParsedVideoMetadata> {
    const ebml = this.readElement()
    if (!ebml || ebml.id !== WebMParser.ELEMENTS.EBML) {
      throw new Error('Not a valid WebM/MKV file')
    }

    // Use specialized EBML header parser for DocType
    const docType = this.findEBMLHeaderElement(ebml.data, WebMParser.ELEMENTS.DocType)
    let container: VideoContainer = 'webm'

    if (docType?.data) {
      const docTypeStr = new TextDecoder().decode(docType.data)
      console.debug('EBML Header:', {
        docTypeElement: {
          id: docType.id.toString(16),
          size: docType.size,
          offset: docType.offset,
          rawBytes: Array.from(docType.data)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' '),
          decodedValue: docTypeStr,
        },
        fullHeader: Array.from(ebml.data.slice(0, 20))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' '),
      })

      // DocType can be 'webm' or 'matroska'
      const normalizedType = docTypeStr.toLowerCase().trim()
      console.debug('Container type detection:', {
        rawType: docTypeStr,
        normalizedType,
        willUse: normalizedType === 'matroska' ? 'mkv' : 'webm',
      })

      container = normalizedType === 'matroska' ? 'mkv' : 'webm'
    } else {
      console.debug('No DocType found in EBML header:', {
        ebmlId: ebml.id.toString(16),
        ebmlSize: ebml.size,
        headerBytes: Array.from(ebml.data.slice(0, 20))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' '),
      })
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
      const timeScale = this.findElement(info.data, WebMParser.ELEMENTS.TimecodeScale)
      const durationElement = this.findElement(info.data, WebMParser.ELEMENTS.Duration)

      if (timeScale?.data) {
        timescale = this.readUintFromElement(timeScale)
      }

      if (durationElement?.data) {
        try {
          const durationData = durationElement.data

          // Try float64 first
          let rawDuration = 0
          let success = false

          if (durationData.length <= 4) {
            // Try float32 for 4-byte duration
            const buffer32 = new ArrayBuffer(4)
            const view32 = new DataView(buffer32)

            // Copy bytes in big-endian order
            for (let i = 0; i < durationData.length; i++) {
              view32.setUint8(4 - durationData.length + i, durationData[i])
            }

            // Read as float32
            rawDuration = view32.getFloat32(0, false) // false = big-endian
            success = Number.isFinite(rawDuration) && rawDuration > 0

            console.debug('Float32 duration attempt:', {
              rawBytes: Array.from(durationData)
                .map((b) => b.toString(16).padStart(2, '0'))
                .join(' '),
              rawDuration,
              success,
            })
          }

          if (!success && durationData.length <= 8) {
            // Try float64 for 8-byte duration
            const buffer64 = new ArrayBuffer(8)
            const view64 = new DataView(buffer64)

            // Copy bytes in big-endian order
            for (let i = 0; i < durationData.length; i++) {
              view64.setUint8(8 - durationData.length + i, durationData[i])
            }

            // Read as float64
            const duration64 = view64.getFloat64(0, false) // false = big-endian
            if (Number.isFinite(duration64) && duration64 > 0) {
              rawDuration = duration64
              success = true
            }

            console.debug('Float64 duration attempt:', {
              rawBytes: Array.from(durationData)
                .map((b) => b.toString(16).padStart(2, '0'))
                .join(' '),
              rawDuration: duration64,
              success,
            })
          }

          if (!success) {
            // Try integer interpretation
            let intValue = 0
            for (let i = 0; i < durationData.length; i++) {
              intValue = (intValue << 8) | durationData[i]
            }
            rawDuration = intValue
            success = intValue > 0

            console.debug('Integer duration attempt:', {
              rawBytes: Array.from(durationData)
                .map((b) => b.toString(16).padStart(2, '0'))
                .join(' '),
              rawDuration: intValue,
              success,
            })
          }

          if (success) {
            // Convert to seconds using timescale
            duration = (rawDuration * timescale) / 1_000_000_000

            console.debug('Duration calculation:', {
              rawBytes: Array.from(durationData)
                .map((b) => b.toString(16).padStart(2, '0'))
                .join(' '),
              rawDuration,
              timescale,
              duration,
              calculation: {
                steps: [
                  `Raw bytes: ${Array.from(durationData)
                    .map((b) => b.toString(16).padStart(2, '0'))
                    .join(' ')}`,
                  `Raw duration: ${rawDuration}`,
                  `Timescale: ${timescale}`,
                  `Duration = ${rawDuration} * ${timescale} / 1_000_000_000 = ${duration} seconds`,
                ],
              },
            })
          } else {
            throw new Error('Could not parse duration value')
          }
        } catch (error) {
          console.warn('Error reading duration:', error)
          duration = 0
        }
      }
    }

    // Try to find Tracks element recursively in case it's nested
    const tracks = this.findTracksElement(segment.data)
    if (!tracks) {
      throw new Error('No Tracks element found')
    }

    // Find both video and audio tracks
    const videoTrack = this.findVideoTrack(tracks.data)
    const audioTrack = await this.findAudioTrack(tracks.data)

    if (!videoTrack) {
      throw new Error('No video track found')
    }

    const { width, height, codec, fps } = this.parseVideoTrack(videoTrack)
    const audioInfo = audioTrack
      ? this.parseAudioTrack(audioTrack)
      : {
          hasAudio: false,
          audioChannels: 0,
          audioSampleRate: 0,
          audioCodec: '',
        }

    // Calculate bitrate from file size and duration
    let bitrate = 0
    if (duration > 0) {
      // Convert bytes to bits and divide by duration to get bits per second
      bitrate = Math.round((this.reader.length * 8) / duration)

      console.debug('Bitrate calculation:', {
        fileSize: this.reader.length,
        duration,
        bitrate,
        calculation: {
          steps: [
            `File size: ${this.reader.length} bytes`,
            `Duration: ${duration} seconds`,
            `Bitrate = (${this.reader.length} * 8) / ${duration} = ${bitrate} bits/s`,
            `Bitrate in Mbit/s = ${bitrate / 1_000_000}`,
          ],
        },
      })
    }

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
      ...audioInfo,
      container,
      fps,
    }
  }

  /**
   * Finds a specific EBML element in a data buffer
   * Uses variable-length integer (VINT) parsing for element IDs and sizes
   * - VINT format allows compact representation of large numbers
   * - First byte indicates length and contains part of the value
   * - Remaining bytes contain the rest of the value
   */
  protected findElement(data: Uint8Array, targetId: number): WebMElement | null {
    let offset = 0

    while (offset < data.length - 1) {
      try {
        // Try normal VINT parsing first
        const reader = new BinaryReaderImpl(data.slice(offset))
        const id = reader.readVint()
        const size = reader.readVint()
        const headerSize = reader.offset

        // Debug what we found
        console.debug('Found element:', {
          offset,
          id: '0x' + id.toString(16),
          targetId: '0x' + targetId.toString(16),
          size,
          headerSize,
          raw: Array.from(data.slice(offset, offset + headerSize + size))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' '),
        })

        // Special handling for single-byte elements
        if (data[offset] === targetId && targetId < 0xff) {
          // Next byte should be size marker
          const sizeByte = data[offset + 1]
          if ((sizeByte & 0x80) === 0x80) {
            // Valid size marker
            const size = sizeByte & 0x7f
            const elementData = data.slice(offset + 2, offset + 2 + size)

            console.debug('Found single-byte element:', {
              id: '0x' + targetId.toString(16),
              size,
              raw: Array.from(data.slice(offset, offset + 2 + size))
                .map((b) => b.toString(16).padStart(2, '0'))
                .join(' '),
              data: Array.from(elementData)
                .map((b) => b.toString(16).padStart(2, '0'))
                .join(' '),
            })

            return {
              id: targetId,
              size,
              data: elementData,
              offset: offset + 2,
            }
          }
        }

        // Special handling for audio elements
        const audioElements = {
          159: true, // Channels
          181: true, // SamplingFrequency
        }

        if (id === targetId && audioElements[targetId]) {
          console.debug('Found audio element:', {
            id: '0x' + id.toString(16),
            size,
            raw: Array.from(data.slice(offset, offset + headerSize + size))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(' '),
            data: Array.from(data.slice(offset + headerSize, offset + headerSize + size))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(' '),
          })

          return {
            id,
            size,
            data: data.slice(offset + headerSize, offset + headerSize + size),
            offset: offset + headerSize,
          }
        }

        if (id === targetId) {
          return {
            id,
            size,
            data: data.slice(offset + headerSize, offset + headerSize + size),
            offset: offset + headerSize,
          }
        }

        offset += headerSize + size
      } catch (error) {
        offset += 1
      }
    }

    return null
  }

  /**
   * Reads a complete EBML element from the current position
   * @returns WebMElement if successfully read, null if not enough data
   */
  protected readElement(): WebMElement | null {
    if (this.reader.remaining() < 2) return null

    const startOffset = this.reader.offset
    const id = this.reader.readVint()
    const size = this.reader.readVint()

    // Ensure we have enough data to read the element
    if (size > this.reader.remaining()) return null

    const data = this.reader.read(size)

    return {
      id,
      size,
      data,
      offset: startOffset,
    }
  }

  /**
   * Locates and parses the video track information from track data
   * @param data Track entry data buffer
   * @returns WebMElement containing video track data if found, null otherwise
   */
  protected findVideoTrack(data: Uint8Array): WebMElement | null {
    const reader = new BinaryReaderImpl(data)

    // Iterate through track entries to find video track (type = 1)
    while (reader.remaining() > 0) {
      const id = reader.readVint()
      const size = reader.readVint()

      // Track entry found (0xae or 0x2e)
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

        // Parse track entry elements
        while (trackReader.remaining() > 0) {
          const subId = trackReader.readVint()
          const subSize = trackReader.readVint()

          // Track type element (0x83)
          if (subId === 0x83 || subId === 0x03) {
            const type = trackReader.read(1)[0]
            trackInfo.type = type
            if (type === 1) {
              // 1 = video track
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
      }
      reader.skip(size)
    }
    return null
  }

  /**
   * Parses video track metadata including:
   * - Frame duration for FPS calculation
   * - Width/height for resolution
   * - Codec identification
   *
   * Note: DefaultDuration element uses a complex format:
   * - First byte (0x84) indicates 4-byte integer
   * - Next 3 bytes contain duration in nanoseconds
   * - Must shift bytes into correct position for accurate timing
   */
  protected parseVideoTrack(track: WebMElement): {
    width: number
    height: number
    codec: string
    fps: number
  } {
    const data = track.data

    // Find video-specific elements
    const videoElement = this.findElement(data, WebMParser.ELEMENTS.Video)
    if (!videoElement) {
      console.warn('No Video element found in track')
      return { width: 0, height: 0, codec: '', fps: 0 }
    }

    // Find dimensions in Video element
    const widthElement = this.findElement(videoElement.data, WebMParser.ELEMENTS.PixelWidth)
    const heightElement = this.findElement(videoElement.data, WebMParser.ELEMENTS.PixelHeight)

    // Find codec
    const codecElement = this.findElement(data, WebMParser.ELEMENTS.CodecID)

    // Find default duration for FPS calculation
    const durationElement = this.findElement(videoElement.data, WebMParser.ELEMENTS.DefaultDuration)

    // Parse values
    const width = widthElement?.data ? this.readUintFromElement(widthElement) : 0
    const height = heightElement?.data ? this.readUintFromElement(heightElement) : 0
    const codec = codecElement?.data
      ? this.mapCodecId(new TextDecoder().decode(codecElement.data))
      : ''
    const fps = durationElement?.data
      ? Math.round(1_000_000_000 / this.readUintFromElement(durationElement))
      : 0

    return { width, height, codec, fps }
  }

  private findCodec(data: Uint8Array): string {
    const codecElement = this.findElement(data, WebMParser.ELEMENTS.CodecID)
    if (!codecElement?.data) return ''
    return new TextDecoder().decode(codecElement.data)
  }

  protected async findAudioTrack(data: Uint8Array): Promise<WebMElement | null> {
    const reader = new BinaryReaderImpl(data)

    console.debug('Audio track search:', {
      firstTrackBytes: Array.from(data.slice(0, 32))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' '),
    })

    while (reader.remaining() > 0) {
      try {
        const id = reader.readVint()
        const size = reader.readVint()

        const isTrackEntry =
          id === WebMParser.ELEMENTS.TrackEntry || id === WebMParser.ELEMENTS.TrackEntryLong

        if (isTrackEntry) {
          const trackData = data.slice(reader.offset, reader.offset + size)
          const trackType = this.findElement(trackData, WebMParser.ELEMENTS.TrackType)

          // Log each track we find
          console.debug('Found track:', {
            id: '0x' + id.toString(16),
            size,
            type: trackType?.data ? trackType.data[0] : null,
            data: Array.from(trackData.slice(0, Math.min(32, trackData.length)))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(' '),
          })

          if (trackType?.data && trackType.data[0] === 2) {
            return {
              id,
              size,
              data: trackData,
              offset: reader.offset,
            }
          }
        }

        reader.skip(size)
      } catch (error) {
        reader.skip(1)
      }
    }

    return null
  }

  /**
   * Parses audio track metadata including:
   * - Channel count
   * - Sample rate
   * - Codec identification (Vorbis/Opus)
   */
  protected parseAudioTrack(track: WebMElement): {
    hasAudio: boolean
    audioChannels: number
    audioSampleRate: number
    audioCodec: string
  } {
    const data = track.data

    // Try to find explicit elements first
    const channelsElement = this.findElement(data, WebMParser.ELEMENTS.Channels)
    const sampleRateElement = this.findElement(data, WebMParser.ELEMENTS.SamplingFrequency)
    const codecElement = this.findElement(data, WebMParser.ELEMENTS.CodecID)
    const privateElement = this.findElement(data, WebMParser.ELEMENTS.CodecPrivate)

    console.debug('Audio track elements:', {
      explicit: {
        channels: channelsElement?.data?.[0],
        sampleRate: sampleRateElement?.data
          ? Math.round(new DataView(sampleRateElement.data.buffer).getFloat32(0, false))
          : null,
        codec: codecElement?.data ? new TextDecoder().decode(codecElement.data) : null,
      },
      private: privateElement
        ? {
            size: privateElement.size,
            data: Array.from(privateElement.data.slice(0, Math.min(32, privateElement.data.length)))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(' '),
          }
        : null,
    })

    // Use explicit elements or fall back to private data or defaults
    const channels = channelsElement?.data?.[0] || 1
    const sampleRate = sampleRateElement?.data
      ? Math.round(new DataView(sampleRateElement.data.buffer).getFloat32(0, false))
      : 44100
    const codec = codecElement?.data
      ? this.mapCodecId(new TextDecoder().decode(codecElement.data))
      : 'vorbis'

    console.debug('Audio track final values:', {
      channels: {
        value: channels,
        source: channelsElement?.data?.[0] ? 'explicit' : 'default',
      },
      sampleRate: {
        value: sampleRate,
        source: sampleRateElement?.data ? 'explicit' : 'default',
      },
      codec: {
        value: codec,
        source: codecElement?.data ? 'explicit' : 'default',
      },
    })

    return {
      hasAudio: true,
      audioChannels: channels,
      audioSampleRate: sampleRate,
      audioCodec: codec,
    }
  }

  /**
   * Maps WebM codec IDs to readable names
   */
  private mapCodecId(codecId: string): string {
    const codecMap: Record<string, string> = {
      A_VORBIS: 'vorbis',
      A_OPUS: 'opus',
      A_AAC: 'aac',
      'A_MPEG/L3': 'mp3',
      'A_PCM/INT/LIT': 'pcm',
    }
    return codecMap[codecId] || codecId
  }

  /**
   * Reads an unsigned integer from an EBML element
   * Used for timescale and other numeric metadata
   * Handles big-endian byte order required by EBML spec
   */
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

  /**
   * Recursively searches for Tracks element
   * This is necessary because:
   * - MKV files can have deeper nesting than WebM
   * - Tracks element might be after Void or CRC elements
   * - Some encoders place Tracks in different locations
   */
  protected findTracksElement(data: Uint8Array): WebMElement | null {
    // First try direct search
    const tracks = this.findElement(data, WebMParser.ELEMENTS.Tracks)
    if (tracks) return tracks

    // If not found, try to locate the Segment element first
    let offset = 0
    const maxSearchBytes = 1024 // Only search first 1KB for Segment

    while (offset < Math.min(data.length, maxSearchBytes)) {
      const reader = new BinaryReaderImpl(data.slice(offset))

      if (reader.remaining() < 2) break

      try {
        const id = reader.readVint()

        // Log what we found
        console.debug('Scanning for Segment:', {
          offset,
          id: '0x' + id.toString(16),
          isSegment: id === WebMParser.ELEMENTS.Segment,
          nextBytes: Array.from(data.slice(offset, offset + Math.min(16, data.length - offset)))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' '),
        })

        if (id === WebMParser.ELEMENTS.Segment) {
          const size = reader.readVint()
          const segmentData = data.slice(offset + reader.offset, offset + reader.offset + size)

          // Now search for Tracks within the Segment
          const nestedTracks = this.findElement(segmentData, WebMParser.ELEMENTS.Tracks)
          if (nestedTracks) return nestedTracks
        }

        // Move forward one byte at a time until we find Segment
        offset += 1
      } catch (error) {
        offset += 1
      }
    }

    return null
  }

  /**
   * Validates an EBML element's ID and size
   * More permissive validation to handle various MKV structures
   */
  private isValidEBMLElement(id: number, size: number, remainingBytes: number): boolean {
    // Known valid EBML IDs are typically 1-4 bytes
    if (id > 0xffffffff) return false

    // Size should be reasonable but allow larger elements
    if (size < 0 || size > remainingBytes) return false

    // Check for common EBML element IDs
    const knownIds = Object.values(WebMParser.ELEMENTS)
    if (knownIds.includes(id)) return true

    // For unknown IDs, be more permissive
    // Allow elements up to 1GB (some MKV files have large media blocks)
    if (size > 1024 * 1024 * 1024) return false

    return true
  }

  /**
   * Special parser for EBML header elements
   * Uses direct byte comparison instead of VINT parsing because:
   * - Header elements always use fixed 2-byte IDs
   * - Size is always a single byte with top bit set
   * - More efficient than full VINT parsing for header elements
   */
  protected findEBMLHeaderElement(data: Uint8Array, targetId: number): WebMElement | null {
    for (let i = 0; i < data.length - 1; i++) {
      // Check for 2-byte element ID match
      if (data[i] === targetId >> 8 && data[i + 1] === (targetId & 0xff)) {
        // Get size byte (usually 0x80 + actual size)
        const sizeByte = data[i + 2]
        const size = sizeByte & 0x7f // Remove length marker bit

        // Get element data
        const elementData = data.slice(i + 3, i + 3 + size)

        return {
          id: targetId,
          size,
          data: elementData,
          offset: i,
        }
      }
    }
    return null
  }

  protected parseVorbisPrivateData(data: Uint8Array): {
    channels?: number
    sampleRate?: number
  } {
    try {
      console.debug('Parsing Vorbis private data:', {
        length: data.length,
        firstBytes: Array.from(data.slice(0, Math.min(32, data.length)))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' '),
      })

      // Xiph lacing format:
      // - First byte is number of packets
      // - Then lengths for all but last packet
      // - Then concatenated packet data
      const numPackets = data[0]
      let offset = 1
      const lengths: number[] = []
      let totalLength = 0

      // Read packet lengths
      for (let i = 0; i < numPackets - 1; i++) {
        let length = 0
        let val: number
        do {
          val = data[offset++]
          length += val
        } while (val === 255)
        lengths.push(length)
        totalLength += length
      }

      // Last packet length is implicit
      const lastPacketLength = data.length - offset - totalLength
      lengths.push(lastPacketLength)

      console.debug('Xiph lacing:', {
        numPackets,
        lengths,
        offset,
        totalLength,
        remaining: data.length - offset,
      })

      // First packet is identification header
      const identHeader = data.slice(offset, offset + lengths[0])

      // Check header magic
      if (
        identHeader[0] !== 1 || // packet type
        String.fromCharCode(...identHeader.slice(1, 7)) !== 'vorbis'
      ) {
        throw new Error('Invalid Vorbis header')
      }

      // Parse identification header fields
      const view = new DataView(identHeader.buffer, identHeader.byteOffset + 7)

      const result = {
        channels: view.getUint8(4),
        sampleRate: view.getUint32(5, true),
      }

      console.debug('Vorbis identification header:', {
        magic: String.fromCharCode(...identHeader.slice(1, 7)),
        version: view.getUint32(0, true),
        ...result,
      })

      return result
    } catch (error) {
      console.debug('Failed to parse Vorbis private data:', error)
      return {}
    }
  }
}
