/**
 * Parser for WebM/MKV container formats using EBML structure.
 * Supports VP8/VP9/AV1 video and Vorbis/Opus audio codecs.
 *
 * @module WebMParser
 */

import type {
  ParsedVideoMetadata,
  VideoColorInfo,
  VideoContainer,
  WebMElement,
} from '../ExpoVideoMetadata.types'
// WebM parser with full support for video/audio codecs and metadata parsing
import { BinaryReaderImpl } from './binary-reader'
import { MkvColorParser } from './mkv-color'

/**
 * Parser for WebM/MKV container formats using EBML structure.
 * - WebM is a subset of Matroska optimized for web delivery
 * - Both use EBML (Extensible Binary Meta Language) for data structure
 * - Supports VP8/VP9/AV1 video and Vorbis/Opus audio codecs
 */
export class WebMParser {
  protected reader: BinaryReaderImpl
  private static readonly textDecoder = new TextDecoder()

  // Static buffers for common operations
  private static readonly AUDIO_BUFFER = new ArrayBuffer(8)
  private static readonly AUDIO_VIEW = new DataView(WebMParser.AUDIO_BUFFER)
  private static readonly SINGLE_BYTE_BUFFER = new Uint8Array(1)

  // Helper method for consistent hex string formatting
  private static bytesToHexString(data: Uint8Array, maxBytes: number = data.length): string {
    return Array.from(data.slice(0, maxBytes))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
  }

  /**
   * EBML element IDs for WebM/MKV container format.
   * Each ID uniquely identifies different parts of the container structure.
   * IDs can be variable length, but common elements use fixed lengths.
   */
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
  } as const

  /**
   * Creates a new WebM parser instance.
   * @param data - The raw binary data of the WebM file
   */
  constructor(data: Uint8Array) {
    this.reader = new BinaryReaderImpl(data)
  }

  /**
   * Parses a WebM file and extracts video metadata.
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
      const docTypeStr = WebMParser.textDecoder.decode(docType.data)
      console.debug('EBML Header:', {
        docTypeElement: {
          id: docType.id.toString(16),
          size: docType.size,
          offset: docType.offset,
          rawBytes: WebMParser.bytesToHexString(docType.data),
          decodedValue: docTypeStr,
        },
        fullHeader: WebMParser.bytesToHexString(ebml.data, 20),
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
        headerBytes: WebMParser.bytesToHexString(ebml.data, 20),
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
              rawBytes: WebMParser.bytesToHexString(durationData),
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
              rawBytes: WebMParser.bytesToHexString(durationData),
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
              rawBytes: WebMParser.bytesToHexString(durationData),
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
              rawBytes: WebMParser.bytesToHexString(durationData),
              rawDuration,
              timescale,
              duration,
              calculation: {
                steps: [
                  `Raw bytes: ${WebMParser.bytesToHexString(durationData)}`,
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
   * Finds a specific EBML element in a data buffer.
   * Uses variable-length integer (VINT) parsing for element IDs and sizes.
   * - VINT format allows compact representation of large numbers
   * - First byte indicates length and contains part of the value
   * - Remaining bytes contain the rest of the value
   *
   * @param data - The data buffer to search in
   * @param targetId - The ID of the element to find
   * @returns WebMElement | null The found element or null if not found
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

          console.debug('Element found:', {
            id: targetId.toString(16),
            size: elementSize,
            offset: elementOffset,
            raw: WebMParser.bytesToHexString(
              data.slice(offset, offset + Math.min(headerSize + elementSize, 16))
            ),
            data: WebMParser.bytesToHexString(elementData),
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
   * Reads a complete EBML element from the current position.
   * @returns WebMElement | null The read element or null if not enough data
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
   * Locates and parses the video track information from track data.
   * @param data - Track entry data buffer
   * @returns WebMElement | null The video track data if found, null otherwise
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
            WebMParser.SINGLE_BYTE_BUFFER.fill(0)
            const typeData = trackReader.read(1)
            WebMParser.SINGLE_BYTE_BUFFER.set(typeData)
            const type = WebMParser.SINGLE_BYTE_BUFFER[0]
            trackInfo.type = type
            if (type === 1) {
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
            trackInfo.codec = WebMParser.textDecoder.decode(codecData)
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
   *
   * @param track - The video track element to parse
   * @returns Object containing width, height, codec, fps, and color info
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
    let colorInfo = MkvColorParser.getDefaultColorInfo()

    // Find codec first since we need it for color mapping
    const codecElement = this.findElement(data, WebMParser.ELEMENTS.CodecID)
    const codec = codecElement?.data
      ? this.mapCodecId(WebMParser.textDecoder.decode(codecElement.data))
      : ''

    // Find video-specific elements
    const videoElement = this.findElement(data, WebMParser.ELEMENTS.Video)

    if (videoElement?.data) {
      console.debug('Found Video element:', {
        length: videoElement.data.length,
        hex: WebMParser.bytesToHexString(videoElement.data),
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
      colorInfo = MkvColorParser.parseColorInfo(videoElement.data, codec)
    }

    // If dimensions not found in Video element, try track data directly
    if (!width || !height) {
      console.debug('Dimensions not found through EBML parsing, trying direct scan')

      // Log the raw data we're scanning
      console.debug('Track data to scan:', {
        length: data.length,
        sample: WebMParser.bytesToHexString(data.slice(0, Math.min(64, data.length))),
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
            bytes: WebMParser.bytesToHexString(data.slice(i, i + 2 + size)),
          })
        }
      }

      // Then scan backward for height since it's usually at the end
      for (let i = data.length - 1; i >= 2; i--) {
        const currentByte = data[i - 2]
        const nextByte = data[i - 1]

        // Check for PixelHeight element (0xba) followed by size marker
        // 0x82 indicates 2-byte size, 0x81 indicates 1-byte size
        if (!height && currentByte === 0xba && (nextByte === 0x82 || nextByte === 0x81)) {
          const size = nextByte === 0x82 ? 2 : 1
          const heightData = data.slice(i, i + size)

          // For 2-byte height, combine bytes in big-endian order
          height = size === 2 ? (heightData[0] << 8) | heightData[1] : heightData[0]

          // Try forward scan if height seems wrong
          if (height < 100) {
            // Look for height element scanning forward
            for (let j = 0; j < data.length - 3; j++) {
              if (data[j] === 0xba && (data[j + 1] === 0x82 || data[j + 1] === 0x81)) {
                const forwardSize = data[j + 1] === 0x82 ? 2 : 1
                const forwardData = data.slice(j + 2, j + 2 + forwardSize)
                const forwardHeight =
                  forwardSize === 2 ? (forwardData[0] << 8) | forwardData[1] : forwardData[0]

                if (forwardHeight > 100 && forwardHeight < 10000) {
                  height = forwardHeight
                  console.debug('Found better height scanning forward:', {
                    offset: j,
                    size: forwardSize,
                    value: height,
                    bytes: WebMParser.bytesToHexString(data.slice(j, j + 2 + forwardSize)),
                  })
                  break
                }
              }
            }
          }

          console.debug('Found height by scanning:', {
            offset: i - 2,
            size,
            value: height,
            bytes: WebMParser.bytesToHexString(data.slice(i - 2, i + size)),
          })
          break
        }
      }

      console.debug('Dimension scan results:', {
        width,
        height,
        lastBytes: WebMParser.bytesToHexString(data.slice(Math.max(0, data.length - 8))),
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
            rawBytes: WebMParser.bytesToHexString(durationData),
            defaultDuration,
            nanosPerFrame: defaultDuration,
            calculatedFps: fps,
            calculation: {
              formula: `${nanosPerSecond} / ${defaultDuration}`,
              steps: [
                `Raw bytes: ${WebMParser.bytesToHexString(durationData)}`,
                `Value bytes: ${WebMParser.bytesToHexString(durationData.slice(1))}`,
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
      colorInfo = MkvColorParser.parseColorInfo(data, codec)

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
            hex: WebMParser.bytesToHexString(privateDataElement.data),
          })
          colorInfo = MkvColorParser.parseColorInfo(privateDataElement.data, codec)
        }
      }
    }

    return { width, height, codec, fps, colorInfo }
  }

  /**
   * Finds and parses the audio track information.
   * @param data - The track data to search in
   * @returns Promise<WebMElement | null> The audio track element if found
   */
  protected async findAudioTrack(data: Uint8Array): Promise<WebMElement | null> {
    const reader = new BinaryReaderImpl(data)
    let attempts = 0
    const maxAttempts = 10000 // Safety limit

    console.debug('Audio track search:', {
      firstTrackBytes: WebMParser.bytesToHexString(data.slice(0, 32)),
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
            data: WebMParser.bytesToHexString(trackData, 32),
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
   *
   * @param track - The audio track element to parse
   * @returns Object containing audio metadata
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
              bytes: WebMParser.bytesToHexString(data.slice(i, i + 3)),
            })
          }
        }

        // Check for SamplingFrequency element (0xB5)
        // Format: [0xB5][size marker][8 bytes float64 value]
        // Size marker has top bit set (0x80-0xFF)
        if (!sampleRate && currentByte === 0xb5 && (nextByte & 0x80) === 0x80) {
          const rateData = data.slice(i + 2, i + 10)
          // Use static DataView instead of creating new one
          WebMParser.AUDIO_BUFFER.slice(0) // Clear buffer
          const bytes = new Uint8Array(WebMParser.AUDIO_BUFFER)
          bytes.set(rateData)
          try {
            const rate = Math.round(WebMParser.AUDIO_VIEW.getFloat64(0, false))
            if (rate >= 8000 && rate <= 192000) {
              sampleRate = rate
              console.debug('Found sample rate by scanning:', {
                offset: i,
                value: sampleRate,
                bytes: WebMParser.bytesToHexString(rateData),
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
      ? this.mapCodecId(WebMParser.textDecoder.decode(codecElement.data))
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
   * Maps WebM codec IDs to readable names.
   * @param codecId - The codec ID from the WebM container
   * @returns string The human-readable codec name
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
   * Reads an unsigned integer from an EBML element.
   * Used for timescale and other numeric metadata.
   * Handles big-endian byte order required by EBML spec.
   *
   * @param element - The element to read from
   * @returns number The unsigned integer value
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

  /**
   * Recursively searches for Tracks element.
   * This is necessary because:
   * - MKV files can have deeper nesting than WebM
   * - Tracks element might be after Void or CRC elements
   * - Some encoders place Tracks in different locations
   *
   * @param data - The data to search in
   * @returns WebMElement | null The Tracks element if found
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
          nextBytes: WebMParser.bytesToHexString(
            data.slice(offset, offset + Math.min(16, data.length - offset))
          ),
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
   * Special parser for EBML header elements.
   * Uses direct byte comparison instead of VINT parsing because:
   * - Header elements always use fixed 2-byte IDs
   * - Size is always a single byte with top bit set
   * - More efficient than full VINT parsing for header elements
   *
   * @param data - The header data to parse
   * @param targetId - The ID of the element to find
   * @returns WebMElement | null The found element or null
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

  /**
   * Parses Vorbis codec private data to extract detailed audio format information.
   * @param data - The private data to parse
   * @returns Object containing channels and sample rate if found
   */
  protected parseVorbisPrivateData(data: Uint8Array): {
    channels?: number
    sampleRate?: number
  } {
    try {
      console.debug('Parsing Vorbis private data:', {
        length: data.length,
        // Show first 32 bytes or less for debugging
        firstBytes: WebMParser.bytesToHexString(data.slice(0, Math.min(32, data.length))),
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
}
