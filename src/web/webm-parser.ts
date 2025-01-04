import type {
  ParsedVideoMetadata,
  VideoColorInfo,
  VideoContainer,
  WebMElement,
} from '../ExpoVideoMetadata.types'
// WebM parser with full support for video/audio codecs and metadata parsing
import { BinaryReaderImpl } from './binary-reader'
import { HdrDetector } from './hdr-detector'

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
    ColourRange: 0x55bb,
    ColourTransfer: 0x55b9,
    ColourPrimaries: 0x55ba,
    ColourMatrix: 0x55b1,
    MasteringMetadata: 0x55d0,
    MaxCLL: 0x55bc,
    MaxFALL: 0x55bd,
    LuminanceMax: 0x55d9,
    LuminanceMin: 0x55da,
    ColourBitDepth: 0x55b2,
    ColourChromaSubsampling: 0x55b5,
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
    let timescale = 1000000 // Default timescale: 1 million units = 1 second (microseconds)

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
            // Some encoders use 4-byte float32 for duration to save space
            // We pad from the right since EBML can omit leading zeros
            for (let i = 0; i < durationData.length; i++) {
              view32.setUint8(4 - durationData.length + i, durationData[i])
            }

            // Read as float32 (big-endian)
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
            // Try float64 for 8-byte duration (standard format)
            const buffer64 = new ArrayBuffer(8)
            const view64 = new DataView(buffer64)

            // Copy bytes in big-endian order
            // EBML can omit leading zeros, so we pad from the right
            for (let i = 0; i < durationData.length; i++) {
              view64.setUint8(8 - durationData.length + i, durationData[i])
            }

            // Read as float64 (big-endian)
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
            // Try integer interpretation as last resort
            // Some encoders store duration as a simple integer
            let intValue = 0
            // Combine bytes in big-endian order
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
            // Convert to seconds:
            // - rawDuration is in timescale units
            // - timescale defines units per second (default 1,000,000 = microseconds)
            // - We convert to nanoseconds (multiply by 1000) for precision
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

    const { width, height, codec, fps, colorInfo } = this.parseVideoTrack(videoTrack)
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
      // Convert bytes to bits (multiply by 8) and divide by duration
      // This gives us bits per second (bps)
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
            `Bitrate in Mbit/s = ${bitrate / 1_000_000}`, // Convert to Mbps for readability
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
      colorInfo,
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
    let attempts = 0
    const maxAttempts = 100 // Safety limit

    while (offset < data.length - 1 && attempts < maxAttempts) {
      attempts++
      try {
        // Try normal VINT parsing first
        const reader = new BinaryReaderImpl(data.slice(offset))
        const id = reader.readVint()
        const size = reader.readVint()
        const headerSize = reader.offset

        // Special handling for single-byte elements
        if ((data[offset] === targetId && targetId < 0xff) || id === targetId) {
          // For single-byte elements, next byte should be size marker
          let elementSize = size
          let elementOffset = offset + headerSize
          let elementData: Uint8Array

          if (data[offset] === targetId && targetId < 0xff) {
            const sizeByte = data[offset + 1]
            if ((sizeByte & 0x80) === 0x80) {
              elementSize = sizeByte & 0x7f
              elementData = data.slice(offset + 2, offset + 2 + elementSize)
              elementOffset = offset + 2
            } else {
              // Skip this match as it's not a valid EBML size marker
              offset += 1
              continue
            }
          } else {
            elementData = data.slice(elementOffset, elementOffset + elementSize)
          }

          console.debug('Found matching element:', {
            id: '0x' + targetId.toString(16),
            size: elementSize,
            offset: elementOffset,
            raw: Array.from(data.slice(offset, offset + Math.min(headerSize + elementSize, 16)))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(' '),
            data: Array.from(elementData)
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(' '),
          })

          return {
            id: targetId,
            size: elementSize,
            data: elementData,
            offset: elementOffset,
          }
        }

        offset += headerSize + size
      } catch (error) {
        offset += 1
      }
    }

    if (attempts >= maxAttempts) {
      console.warn('Exceeded maximum attempts while searching for element:', {
        targetId: '0x' + targetId.toString(16),
        dataLength: data.length,
      })
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

      // Track entry found (0xae = long form, 0x2e = short form)
      // Some encoders use short form IDs to save space
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

          // Track type element (0x83 = long form, 0x03 = short form)
          // Type values:
          // 1 = video
          // 2 = audio
          // 3 = complex
          // 0x10 = logo
          // 0x11 = subtitle
          // 0x12 = buttons
          // 0x20 = control
          if (subId === 0x83 || subId === 0x03) {
            const type = trackReader.read(1)[0]
            trackInfo.type = type
            if (type === 1) {
              // Found video track (type = 1)
              return {
                id,
                size,
                data: trackData,
                offset: reader.offset,
              }
            }
          } else if (subId === 0x86) {
            // CodecID (0x86) - String identifying the codec
            const codecData = trackReader.read(subSize)
            trackInfo.codec = new TextDecoder().decode(codecData)
          } else if (subId === 0xe0 || subId === 0x60) {
            // Video element (0xe0 = long form, 0x60 = short form)
            // Contains video-specific metadata like dimensions
            trackInfo.hasVideo = true
            const videoData = trackReader.read(subSize)
            trackInfo.videoData = new Uint8Array(videoData.slice(0, 16)) // Store first 16 bytes for debugging
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
    colorInfo: VideoColorInfo
  } {
    const data = track.data
    let width = 0
    let height = 0
    let fps = 0
    let colorInfo = this.getDefaultColorInfo()

    // Find codec first since we need it for color mapping
    const codecElement = this.findElement(data, WebMParser.ELEMENTS.CodecID)
    const codec = codecElement?.data
      ? this.mapCodecId(new TextDecoder().decode(codecElement.data))
      : ''

    // Find video-specific elements
    const videoElement = this.findElement(data, WebMParser.ELEMENTS.Video)

    if (videoElement?.data) {
      console.debug('Found Video element:', {
        length: videoElement.data.length,
        hex: Array.from(videoElement.data)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' '),
      })

      // Try to find dimensions in Video element first
      const widthElement = this.findElement(videoElement.data, WebMParser.ELEMENTS.PixelWidth)
      const heightElement = this.findElement(videoElement.data, WebMParser.ELEMENTS.PixelHeight)

      // Try to find default duration in Video element
      const durationElement = this.findElement(
        videoElement.data,
        WebMParser.ELEMENTS.DefaultDuration
      )

      if (widthElement?.data) {
        width = this.readUintFromElement(widthElement)
      }
      if (heightElement?.data) {
        height = this.readUintFromElement(heightElement)
      }
      if (durationElement?.data) {
        const defaultDuration = this.readUintFromElement(durationElement)
        fps = Math.round(1_000_000_000 / defaultDuration)
        console.debug('DefaultDuration found in Video element:', {
          defaultDuration,
          calculatedFps: fps,
        })
      }

      // Try to find color info in Video element
      colorInfo = this.parseColorInfo(videoElement.data, codec)
    }

    // If dimensions not found in Video element, try track data directly
    if (!width || !height) {
      console.debug('Dimensions not found through EBML parsing, trying direct scan')

      // Log the raw data we're scanning
      console.debug('Track data to scan:', {
        length: data.length,
        sample: Array.from(data.slice(0, Math.min(64, data.length)))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' '),
      })

      // First scan forward for width
      for (let i = 0; i < data.length - 3; i++) {
        const currentByte = data[i]
        const nextByte = data[i + 1]

        // Check for PixelWidth element (0xb0) followed by size marker
        // 0x82 indicates 2-byte size, 0x81 indicates 1-byte size
        if (!width && currentByte === 0xb0 && (nextByte === 0x82 || nextByte === 0x81)) {
          const size = nextByte === 0x82 ? 2 : 1
          const widthData = data.slice(i + 2, i + 2 + size)
          if (size === 2) {
            // For 2-byte width, combine bytes in big-endian order
            width = (widthData[0] << 8) | widthData[1]
          } else {
            // For 1-byte width, use value directly
            width = widthData[0]
          }
          console.debug('Found width by scanning:', {
            offset: i,
            size,
            value: width,
            bytes: Array.from(data.slice(i, i + 2 + size))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(' '),
          })
        }
      }

      // Then scan backward for height since it's usually at the end
      for (let i = data.length - 1; i >= 2; i--) {
        const currentByte = data[i - 2]
        const nextByte = data[i - 1]
        const valueByte = data[i]

        /*
        console.debug('Scanning backward:', {
          offset: i - 2,
          bytes: Array.from(data.slice(i - 2, i + 1))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' '),
        })
            */

        // Check for PixelHeight element (0xba) followed by size marker
        // 0x82 indicates 2-byte size, 0x81 indicates 1-byte size
        if (!height && currentByte === 0xba && (nextByte === 0x82 || nextByte === 0x81)) {
          const size = nextByte === 0x82 ? 2 : 1
          const heightData = data.slice(i, i + size)
          if (size === 2) {
            // For 2-byte height, combine bytes in big-endian order
            height = (heightData[0] << 8) | heightData[1]
          } else {
            // For 1-byte height, use value directly
            height = heightData[0]
          }
          console.debug('Found height by backward scanning:', {
            offset: i - 2,
            size,
            value: height,
            bytes: Array.from(data.slice(i - 2, i + size))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(' '),
          })
          break
        }
      }

      console.debug('Dimension scan results:', {
        width,
        height,
        lastBytes: Array.from(data.slice(Math.max(0, data.length - 8)))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' '),
      })
    }

    // If FPS not found in Video element, try scanning the entire track data
    if (!fps) {
      console.debug('DefaultDuration not found in Video element, trying direct scan')

      // Scan for DefaultDuration element bytes (0x23E383)
      // In EBML format, DefaultDuration is a 3-byte element ID that defines frame duration
      for (let i = 0; i < data.length - 6; i++) {
        // Check for DefaultDuration element marker (0x23 0xE3 0x83)
        // This is followed by a 4-byte integer containing duration in nanoseconds
        // We shift and combine bytes to form the full integer
        if (data[i] === 0x23 && data[i + 1] === 0xe3 && data[i + 2] === 0x83) {
          const durationData = data.slice(i + 3, i + 7)

          // EBML variable integer format for DefaultDuration:
          // First byte (0x84) indicates 4-byte integer
          // Next 3 bytes contain the actual duration value in nanoseconds
          // We shift and combine bytes to form the full integer
          const defaultDuration =
            ((durationData[1] << 24) | (durationData[2] << 16) | (durationData[3] << 8)) >>> 0

          // Convert nanoseconds per frame to frames per second
          // 1 second = 1,000,000,000 nanoseconds
          const nanosPerSecond = 1_000_000_000
          fps = Math.round(nanosPerSecond / defaultDuration)

          console.debug('DefaultDuration found by scanning:', {
            rawBytes: Array.from(durationData)
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(' '),
            defaultDuration,
            nanosPerFrame: defaultDuration,
            calculatedFps: fps,
            calculation: {
              formula: `${nanosPerSecond} / ${defaultDuration}`,
              steps: [
                `Raw bytes: ${Array.from(durationData)
                  .map((b) => b.toString(16).padStart(2, '0'))
                  .join(' ')}`,
                `Value bytes: ${Array.from(durationData.slice(1))
                  .map((b) => b.toString(16).padStart(2, '0'))
                  .join(' ')}`,
                `Duration = ${defaultDuration} ns/frame`,
                `FPS = ${nanosPerSecond} / ${defaultDuration} = ${nanosPerSecond / defaultDuration} ≈ ${fps}`,
              ],
            },
          })
          break
        }
      }
    }

    // If no color info found in Video element, try track level
    if (
      !colorInfo.matrixCoefficients &&
      !colorInfo.transferCharacteristics &&
      !colorInfo.primaries
    ) {
      // Try to find color info in track data
      colorInfo = this.parseColorInfo(data, codec)

      // If still no color info and codec is VP9, try codec private data
      if (
        codec === 'V_VP9' &&
        !colorInfo.matrixCoefficients &&
        !colorInfo.transferCharacteristics &&
        !colorInfo.primaries
      ) {
        const privateDataElement = this.findElement(data, WebMParser.ELEMENTS.CodecPrivate)
        if (privateDataElement?.data) {
          console.debug('Found VP9 private data:', {
            length: privateDataElement.data.length,
            hex: Array.from(privateDataElement.data)
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(' '),
          })
          colorInfo = HdrDetector.parseVP9ColorInfo(privateDataElement.data)
        }
      }
    }

    return { width, height, codec, fps, colorInfo }
  }

  private findCodec(data: Uint8Array): string {
    const codecElement = this.findElement(data, WebMParser.ELEMENTS.CodecID)
    if (!codecElement?.data) return ''
    return new TextDecoder().decode(codecElement.data)
  }

  protected async findAudioTrack(data: Uint8Array): Promise<WebMElement | null> {
    const reader = new BinaryReaderImpl(data)
    let attempts = 0
    const maxAttempts = 10000 // Safety limit

    console.debug('Audio track search:', {
      firstTrackBytes: Array.from(data.slice(0, 32))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' '),
    })

    while (reader.remaining() > 0 && attempts < maxAttempts) {
      attempts++
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

    if (attempts >= maxAttempts) {
      console.warn('Exceeded maximum attempts while searching for audio track')
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

    // Find Audio element first (0xE1 in EBML)
    // Audio element contains channel count, sample rate, and other audio-specific metadata
    const audioElement = this.findElement(data, WebMParser.ELEMENTS.Audio)
    let channels = 0
    let sampleRate = 0

    if (audioElement?.data) {
      // Try to find explicit elements within Audio element first
      // Channels (0x9F) indicates number of audio channels (1=mono, 2=stereo, etc.)
      const channelsElement = this.findElement(audioElement.data, WebMParser.ELEMENTS.Channels)
      // SamplingFrequency (0xB5) indicates audio sample rate in Hz (e.g., 44100, 48000)
      const sampleRateElement = this.findElement(
        audioElement.data,
        WebMParser.ELEMENTS.SamplingFrequency
      )

      if (channelsElement?.data) {
        channels = channelsElement.data[0]
        // Validate channel count (should be between 1 and 8)
        // 1 = mono, 2 = stereo, 6 = 5.1, 8 = 7.1
        if (channels < 1 || channels > 8) {
          console.debug('Invalid channel count in Audio element:', channels)
          channels = 0 // Will try other methods
        }
      }

      if (sampleRateElement?.data) {
        // Sample rate is stored as a float64 in WebM/MKV format
        // Common values: 44100 (CD), 48000 (DVD), 96000 (HD audio)
        const view = new DataView(sampleRateElement.data.buffer, sampleRateElement.data.byteOffset)
        try {
          sampleRate = Math.round(view.getFloat64(0, false)) // false = big-endian
          // Validate sample rate (common rates: 8000 to 192000)
          // 8000 = telephone quality
          // 44100 = CD quality
          // 48000 = DVD quality
          // 96000-192000 = HD audio
          if (sampleRate < 8000 || sampleRate > 192000) {
            console.debug('Invalid sample rate in Audio element:', sampleRate)
            sampleRate = 0 // Will try other methods
          }
        } catch (error) {
          console.debug('Failed to read sample rate as float64, trying alternative methods')
        }
      }
    }

    // If not found in Audio element, try scanning the entire track data
    if (!channels || !sampleRate) {
      console.debug('Audio metadata not found in Audio element, trying direct scan')

      // Scan for both channels and sample rate in one pass
      for (let i = 0; i < data.length - 9; i++) {
        const currentByte = data[i]
        const nextByte = data[i + 1]

        // Check for Channels element (0x9F)
        // Format: [0x9F][size marker][channel count]
        // Size marker has top bit set (0x80-0xFF)
        if (!channels && currentByte === 0x9f && (nextByte & 0x80) === 0x80) {
          const channelValue = data[i + 2]
          // Validate channel count (1-8 channels)
          // 1 = mono
          // 2 = stereo
          // 6 = 5.1 surround
          // 8 = 7.1 surround
          if (channelValue >= 1 && channelValue <= 8) {
            channels = channelValue
            console.debug('Found channels by scanning:', {
              offset: i,
              value: channels,
              bytes: Array.from(data.slice(i, i + 3))
                .map((b) => b.toString(16).padStart(2, '0'))
                .join(' '),
            })
          }
        }

        // Check for SamplingFrequency element (0xB5)
        // Format: [0xB5][size marker][8 bytes float64 value]
        // Size marker has top bit set (0x80-0xFF)
        if (!sampleRate && currentByte === 0xb5 && (nextByte & 0x80) === 0x80) {
          const rateData = data.slice(i + 2, i + 10)
          const view = new DataView(rateData.buffer, rateData.byteOffset)
          try {
            const rate = Math.round(view.getFloat64(0, false)) // false = big-endian
            // Validate sample rate against common audio sample rates
            // 8000 Hz = telephone quality
            // 44100 Hz = CD quality
            // 48000 Hz = DVD quality
            // 96000-192000 Hz = HD audio
            if (rate >= 8000 && rate <= 192000) {
              sampleRate = rate
              console.debug('Found sample rate by scanning:', {
                offset: i,
                value: sampleRate,
                bytes: Array.from(rateData)
                  .map((b) => b.toString(16).padStart(2, '0'))
                  .join(' '),
              })
            }
          } catch (error) {
            console.debug('Failed to parse sample rate at offset', i)
          }
        }

        // Break if we found both values
        if (channels && sampleRate) break
      }
    }

    // Find codec ID (0x86) to determine audio format
    const codecElement = this.findElement(data, WebMParser.ELEMENTS.CodecID)
    const codec = codecElement?.data
      ? this.mapCodecId(new TextDecoder().decode(codecElement.data))
      : 'vorbis' // Default to Vorbis if not specified

    // Try to get more accurate metadata from codec private data (0x63A2)
    // Vorbis codec private data contains detailed audio format information
    const privateElement = this.findElement(data, WebMParser.ELEMENTS.CodecPrivate)
    if (privateElement?.data && codec === 'vorbis' && (!channels || !sampleRate)) {
      const privateData = this.parseVorbisPrivateData(privateElement.data)
      if (privateData.channels && !channels) {
        channels = privateData.channels
      }
      if (privateData.sampleRate && !sampleRate) {
        sampleRate = privateData.sampleRate
      }
    }

    // Use fallback values if still not found or invalid
    // Most common defaults for web audio:
    // - 2 channels (stereo)
    // - 44100 Hz (CD quality)
    if (!channels || channels < 1 || channels > 8) channels = 2
    if (!sampleRate || sampleRate < 8000 || sampleRate > 192000) sampleRate = 44100

    console.debug('Final audio track values:', {
      codec,
      channels,
      sampleRate,
      privateDataFound: !!privateElement?.data,
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
    const maxSearchBytes = 1024 // Only search first 1KB for Segment, as it should be near the start

    while (offset < Math.min(data.length, maxSearchBytes)) {
      const reader = new BinaryReaderImpl(data.slice(offset))

      if (reader.remaining() < 2) break // Need at least 2 bytes for VINT

      try {
        const id = reader.readVint()

        // Log what we found
        console.debug('Scanning for Segment:', {
          offset,
          id: '0x' + id.toString(16),
          isSegment: id === WebMParser.ELEMENTS.Segment,
          // Show next 16 bytes for debugging
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
      // EBML header element structure:
      // [0-1] = 2-byte element ID
      // [2]   = Size byte (top bit set, 0x80 + actual size)
      // [3+]  = Element data

      // Check for 2-byte element ID match
      if (data[i] === targetId >> 8 && data[i + 1] === (targetId & 0xff)) {
        // Get size byte (usually 0x80 + actual size)
        const sizeByte = data[i + 2]
        const size = sizeByte & 0x7f // Remove length marker bit (top bit)

        // Get element data (starts after ID and size byte)
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
        // Show first 32 bytes or less for debugging
        firstBytes: Array.from(data.slice(0, Math.min(32, data.length)))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' '),
      })

      // Xiph lacing format structure:
      // [0]   = Number of packets
      // [1-N] = Packet lengths (except last packet)
      // [N+]  = Concatenated packet data
      const numPackets = data[0]
      let offset = 1 // Start after packet count
      const lengths: number[] = []
      let totalLength = 0

      // Read packet lengths (all but last packet)
      for (let i = 0; i < numPackets - 1; i++) {
        let length = 0
        let val: number
        do {
          val = data[offset++]
          length += val
        } while (val === 255) // 255 means "add 255 and read another byte"
        lengths.push(length)
        totalLength += length
      }

      // Last packet length is implicit (remaining data)
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
        identHeader[0] !== 1 || // packet type 1 = identification header
        // Bytes 1-6 should contain the string "vorbis"
        String.fromCharCode(...identHeader.slice(1, 7)) !== 'vorbis'
      ) {
        throw new Error('Invalid Vorbis header')
      }

      // Parse identification header fields
      // Vorbis header structure:
      // [0]     = Packet type (1 = identification header)
      // [1-6]   = "vorbis" string
      // [7-10]  = Version (uint32)
      // [11]    = Number of channels (uint8)
      // [12-15] = Sample rate (uint32)
      // [16-19] = Bitrate maximum (uint32)
      // [20-23] = Bitrate nominal (uint32)
      // [24-27] = Bitrate minimum (uint32)
      // [28]    = Blocksize values (uint8)
      // [29]    = Framing flag (uint8)
      const view = new DataView(identHeader.buffer, identHeader.byteOffset + 7) // Skip packet type and "vorbis" string

      const result = {
        // Channels at byte 4 (after version)
        channels: view.getUint8(4),
        // Sample rate at byte 5-8 (after channels)
        sampleRate: view.getUint32(5, true), // true = little-endian for Vorbis
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

  /**
   * Parses WebM/MKV color information including HDR metadata.
   * Color information in WebM/MKV is stored hierarchically:
   * Colour
   * ├── MatrixCoefficients (0x55b1)
   * ├── Range (0x55b2)
   * ├── TransferCharacteristics (0x55b9)
   * ├── Primaries (0x55ba)
   * └── MasteringMetadata (0x55d0)
   *     ├── LuminanceMax/Min
   *     └── MaxCLL/MaxFALL
   */
  private parseColorInfo(data: Uint8Array, codec = ''): VideoColorInfo {
    try {
      console.debug('Color info parsing:', {
        data: Array.from(data)
          .map((b, i) => ({
            offset: i,
            hex: b.toString(16).padStart(2, '0'),
            decimal: b,
            ascii: b >= 32 && b <= 126 ? String.fromCharCode(b) : '.',
            possibleElement: b === 0x55 ? 'Color element start' : '',
          }))
          .filter((_, i) => i < 32), // Only show first 32 bytes to avoid noise
      })

      // For H.264 in MKV/WebM, if no color info is present, use standard values
      if (codec === 'V_MPEG4/ISO/AVC') {
        return {
          primaries: 'smpte170m',
          transferCharacteristics: 'bt709',
          matrixCoefficients: 'smpte170m',
          fullRange: false,
        }
      }

      // For VFW content, return null values as we can't make assumptions
      if (codec === 'V_MS/VFW/FOURCC') {
        return this.getDefaultColorInfo()
      }

      let primaries: number | null = null
      let transfer: number | null = null
      let matrix: number | null = null
      let range: number | null = null

      // Direct scan for color elements
      for (let i = 0; i < data.length - 3; i++) {
        // Check for element IDs starting with 0x55
        if (data[i] !== 0x55) continue

        const nextByte = data[i + 1]
        const sizeMarker = data[i + 2]

        // Only process if we have a size marker of 0x81 (single byte)
        if (sizeMarker !== 0x81) continue

        const value = data[i + 3]

        console.debug('Found color element:', {
          offset: i,
          id: '0x55' + nextByte.toString(16),
          value,
          bytes: Array.from(data.slice(i, i + 4))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' '),
        })

        switch (nextByte) {
          case 0xba: // Primaries
            primaries = value
            break
          case 0xb9: // Transfer
            transfer = value
            break
          case 0xb1: // Matrix
            matrix = value
            break
          case 0xbb: // Range
            range = value
            break
        }

        // Skip the element (ID + size marker + value)
        i += 3
      }

      console.debug('Raw color values:', { primaries, transfer, matrix, range })

      // Map the values according to the WebM/MKV specification
      const colorInfo: VideoColorInfo = {
        primaries: primaries !== null ? this.mapMkvColorPrimaries(primaries, codec, matrix) : null,
        transferCharacteristics:
          transfer !== null ? this.mapMkvTransferCharacteristics(transfer, primaries) : null,
        matrixCoefficients: matrix !== null ? this.mapMkvMatrixCoefficients(matrix) : null,
        fullRange: range !== null ? range === 2 : null,
      }

      console.debug('Color info mapping:', {
        raw: { primaries, transfer, matrix, range },
        mapped: colorInfo,
      })

      return colorInfo
    } catch (error) {
      console.debug('Error parsing color info:', error)
      return this.getDefaultColorInfo()
    }
  }

  private mapMkvColorPrimaries(value: number, codec = '', matrix: number | null = null): string {
    // Values from https://www.matroska.org/technical/elements.html#Colour
    switch (value) {
      case 1:
        // For VP9:
        // - If all values are 1, it means bt709
        // - Otherwise, value 1 means bt470bg
        // For AV1, value 1 means bt470bg
        if (codec === 'V_VP9' && matrix === 1) {
          return 'bt709'
        }
        return 'bt470bg'
      case 2:
        return 'unspecified'
      case 4:
        return 'bt470m'
      case 5:
        return 'bt470bg'
      case 6:
        return 'smpte170m'
      case 7:
        return 'smpte240m'
      case 8:
        return 'film'
      case 9:
        return 'bt2020'
      case 10:
        return 'smpte428'
      case 11:
        return 'smpte431'
      case 12:
        return 'smpte432'
      case 16:
        return 'bt2020'
      case 22:
        return 'ebu3213'
      default:
        return 'unspecified'
    }
  }

  private mapMkvTransferCharacteristics(value: number, primaries: number | null = null): string {
    // Values from https://www.matroska.org/technical/elements.html#Colour
    switch (value) {
      case 1:
        // For HDR content (primaries = 16 means BT.2020), value 1 means SMPTE 2084
        // Otherwise, it means BT.709
        return primaries === 16 ? 'smpte2084' : 'bt709'
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
        return 'unspecified'
    }
  }

  private mapMkvMatrixCoefficients(value: number): string {
    // Values from https://www.matroska.org/technical/elements.html#Colour
    switch (value) {
      case 1:
        return 'bt709'
      case 2:
        return 'unspecified'
      case 4:
        return 'fcc'
      case 5:
        return 'bt470bg'
      case 6:
        return 'smpte170m'
      case 7:
        return 'smpte240m'
      case 8:
        return 'ycocg'
      case 9:
        return 'bt2020nc'
      case 10:
        return 'bt2020c'
      default:
        return 'unspecified'
    }
  }

  private parseAV1ColorInfo(data: Uint8Array): VideoColorInfo {
    try {
      // AV1 sequence header parsing similar to MP4
      // First byte: marker bit (1) + version (7 bits)
      const version = data[0] & 0x7f
      if (data[0] >> 7 !== 1 || version !== 1) {
        console.debug('Invalid AV1 config version:', {
          marker: data[0] >> 7,
          version,
        })
        return this.getDefaultColorInfo()
      }

      // Profile and level info
      const profile = (data[1] >> 5) & 0x7
      const level = data[1] & 0x1f
      const tier = (data[2] >> 7) & 0x1
      const highBitDepth = (data[2] >> 6) & 0x1
      const twelveBit = (data[2] >> 5) & 0x1
      const monochrome = (data[2] >> 4) & 0x1
      const chromaSubsamplingX = (data[2] >> 3) & 0x1
      const chromaSubsamplingY = (data[2] >> 2) & 0x1
      const chromaSamplePosition = data[2] & 0x3

      console.debug('AV1 config:', {
        profile,
        level,
        tier,
        highBitDepth,
        twelveBit,
        monochrome,
        chromaSubsamplingX,
        chromaSubsamplingY,
        chromaSamplePosition,
      })

      // For AV1, we can determine HDR capability from profile and bit depth
      const isHdrCapable = profile >= 2 && (highBitDepth || twelveBit)

      return isHdrCapable
        ? {
            matrixCoefficients: 'bt2020nc',
            transferCharacteristics: 'smpte2084',
            primaries: 'bt2020',
            fullRange: true,
          }
        : {
            matrixCoefficients: 'bt709',
            transferCharacteristics: 'bt709',
            primaries: 'bt709',
            fullRange: true,
          }
    } catch (error) {
      console.debug('Error parsing AV1 color info:', error)
      return this.getDefaultColorInfo()
    }
  }
}
