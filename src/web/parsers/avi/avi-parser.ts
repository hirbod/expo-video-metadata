import type {
  ParsedVideoMetadata,
  VideoColorInfo,
  VideoTrackMetadata,
} from '../../../ExpoVideoMetadata.types'
// avi-parser.ts
import { BinaryReaderImpl } from '../../binary-reader'

/**
 * Parser for AVI (Audio Video Interleave) container format.
 * Supports parsing of common video and audio formats found in AVI files.
 *
 * Video formats:
 * - MPEG4 (various variants including DivX, XviD)
 * - H.264/AVC
 * - MPEG-1/2
 *
 * Audio formats:
 * - PCM (uncompressed)
 * - MP3
 * - AC-3
 * - DTS
 * - WMA
 *
 * Features:
 * - Accurate video/audio bitrate calculation
 * - Frame rate detection
 * - Audio stream properties (channels, sample rate)
 * - Container metadata (dimensions, duration)
 */
export class AVIParser {
  private reader: BinaryReaderImpl
  private mainHeader: {
    width?: number
    height?: number
    displayAspectWidth?: number
    displayAspectHeight?: number
    fps?: number
    totalFrames?: number
    maxBytesPerSec?: number
  } | null = null
  private audioInfo: {
    avgBytesPerSec?: number
  } | null = null

  // AVI chunk IDs in little-endian order
  // Note: These are stored in little-endian format to match file layout
  private static readonly CHUNKS: Record<string, number> = {
    RIFF: 0x46464952, // 'RIFF'
    AVI_: 0x20495641, // 'AVI '
    LIST: 0x5453494c, // 'LIST'
    hdrl: 0x6c726468, // 'hdrl'
    avih: 0x68697661, // 'avih'
    strl: 0x6c727473, // 'strl'
    strh: 0x68727473, // 'strh'
    strf: 0x66727473, // 'strf'
    INFO: 0x4f464e49, // 'INFO'
    JUNK: 0x4b4e554a, // 'JUNK'
    vids: 0x73646976, // 'vids'
    auds: 0x73647561, // 'auds'
  } as const

  // Constants for validation
  private static readonly MAX_DIMENSION = 10000 // Maximum reasonable dimension in pixels
  private static readonly MAX_STRF_SIZE = 1024 * 1024 // 1MB max size for format chunks
  private static readonly MIN_LIST_SIZE = 4 // Minimum size for LIST chunks (type field)
  private static readonly MICROSECONDS_PER_SECOND = 1_000_000

  constructor(data: Uint8Array) {
    this.reader = new BinaryReaderImpl(data)
  }

  /**
   * Parses an AVI file and extracts video/audio metadata.
   * @returns Promise<ParsedVideoMetadata> Object containing video and audio metadata
   * @throws Error if file is not a valid AVI file or required chunks are missing
   */
  async parse(): Promise<ParsedVideoMetadata> {
    // Verify RIFF header
    const riffId = this.readUint32LE()
    console.debug('AVI Parser - RIFF ID:', {
      expected: AVIParser.CHUNKS.RIFF.toString(16),
      got: riffId.toString(16),
      asString: String.fromCharCode(
        riffId & 0xff,
        (riffId >> 8) & 0xff,
        (riffId >> 16) & 0xff,
        (riffId >> 24) & 0xff
      ),
    })

    if (riffId !== AVIParser.CHUNKS.RIFF) {
      // Log first 32 bytes for debugging
      const headerBytes = this.reader.data.slice(0, 32)
      console.debug('AVI Parser - First 32 bytes:', {
        hex: Array.from(headerBytes).map((b) => '0x' + b.toString(16).padStart(2, '0')),
        ascii: Array.from(headerBytes)
          .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
          .join(''),
      })
      throw new Error('Not a valid AVI file')
    }

    const fileSize = this.readUint32LE()
    const aviId = this.readUint32LE()
    console.debug('AVI Parser - AVI ID:', {
      expected: AVIParser.CHUNKS.AVI_.toString(16),
      got: aviId.toString(16),
      asString: String.fromCharCode(
        aviId & 0xff,
        (aviId >> 8) & 0xff,
        (aviId >> 16) & 0xff,
        (aviId >> 24) & 0xff
      ),
      fileSize,
    })

    if (aviId !== AVIParser.CHUNKS.AVI_) {
      throw new Error('Not a valid AVI file')
    }

    // Parse main AVI header and stream headers
    this.mainHeader = await this.parseMainAVIHeader()
    const streamInfo = await this.parseStreamHeaders()

    // Calculate duration from total frames and fps
    const duration =
      this.mainHeader.totalFrames && this.mainHeader.fps
        ? this.mainHeader.totalFrames / this.mainHeader.fps
        : 0

    // Log final bitrate values
    console.debug('Bitrate calculation:', {
      totalSize: this.reader.length,
      duration,
      calculatedBitrate: streamInfo.videoBitrate,
      videoBitrate: streamInfo.videoBitrate,
      audioBitrate: streamInfo.audioBitrate,
    })

    return {
      width: this.mainHeader.width || 0,
      height: this.mainHeader.height || 0,
      rotation: 0, // AVI doesn't support rotation
      displayAspectWidth: this.mainHeader.displayAspectWidth || 0,
      displayAspectHeight: this.mainHeader.displayAspectHeight || 0,
      fps: this.mainHeader.fps || 0,
      codec: streamInfo.codec || '',
      colorInfo: this.getDefaultColorInfo(),
      container: 'avi',
      hasAudio: streamInfo.hasAudio || false,
      audioChannels: streamInfo.audioChannels || 0,
      audioSampleRate: streamInfo.audioSampleRate || 0,
      audioCodec: streamInfo.audioCodec || '',
      audioBitrate: streamInfo.audioBitrate,
      duration,
      fileSize: this.reader.length,
      bitrate: streamInfo.videoBitrate || 0,
    }
  }

  /**
   * Reads a 32-bit unsigned integer in little-endian order.
   * Used for reading chunk IDs, sizes, and various header fields.
   * @returns number The read uint32 value
   * @throws Error if not enough bytes are available
   */
  private readUint32LE(): number {
    const bytes = this.reader.read(4)
    return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
  }

  /**
   * Reads a 16-bit unsigned integer in little-endian order.
   * Used for reading audio format fields and bitmap info.
   * @returns number The read uint16 value
   * @throws Error if not enough bytes are available
   */
  private readUint16LE(): number {
    const bytes = this.reader.read(2)
    return bytes[0] | (bytes[1] << 8)
  }

  /**
   * Reads a FourCC code in little-endian order.
   * FourCC codes are 4-character identifiers used for codecs and chunk types.
   * @returns string The FourCC code as a string
   * @throws Error if not enough bytes are available
   */
  private readFourCC(): string {
    const bytes = this.reader.read(4)
    // Read in little-endian order (reverse the bytes)
    return String.fromCharCode(bytes[3], bytes[2], bytes[1], bytes[0]).trim()
  }

  /**
   * Returns default color info for AVI files.
   * AVI doesn't support HDR or advanced color metadata.
   * All values are set to null to indicate standard/unknown color space.
   */
  private getDefaultColorInfo(): VideoColorInfo {
    return {
      matrixCoefficients: null,
      transferCharacteristics: null,
      primaries: null,
      fullRange: null,
    }
  }

  /**
   * Maps audio format tags to standardized codec strings.
   * @param formatTag The WAVEFORMATEX format tag
   * @returns string The standardized codec name or hex format tag if unknown
   */
  private formatAudioCodec(formatTag: number): string {
    // Common audio format tags
    switch (formatTag) {
      case 0x2000: // AC3
        return 'ac-3'
      case 0x0001: // PCM
        return 'pcm'
      case 0x0002: // MS ADPCM
        return 'adpcm'
      case 0x0055: // MP3
        return 'mp3'
      case 0x0050: // MPEG Layer 1 or 2
        return 'mp2'
      case 0x2001: // DTS
        return 'dts'
      case 0x0161: // Windows Media Audio
        return 'wma'
      case 0x0162: // Windows Media Audio Professional
        return 'wma-pro'
      default:
        return `0x${formatTag.toString(16)}`
    }
  }

  /**
   * Maps video FourCC codes to standardized codec strings.
   * @param fourCC The video codec FourCC code
   * @returns string The standardized codec name or lowercase FourCC if unknown
   */
  private formatCodec(fourCC: string): string {
    console.debug('Formatting codec:', { fourCC })
    // Convert common FourCC codes to standard codec names
    const codecMap: Readonly<Record<string, string>> = {
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

  /**
   * Parses the main AVI header (avih chunk) which contains global information about the video.
   * @returns Promise<Partial<VideoTrackMetadata> & { totalFrames?: number; maxBytesPerSec?: number }>
   * @throws Error if no valid main AVI header is found
   */
  private async parseMainAVIHeader(): Promise<
    Partial<VideoTrackMetadata> & { totalFrames?: number; maxBytesPerSec?: number }
  > {
    while (this.reader.canRead(8)) {
      const chunkId = this.readUint32LE()
      const chunkSize = this.readUint32LE()

      console.debug('Parsing chunk:', {
        id: chunkId.toString(16),
        expectedListId: AVIParser.CHUNKS.LIST.toString(16),
        size: chunkSize,
      })

      if (chunkId === AVIParser.CHUNKS.LIST) {
        const listType = this.readUint32LE()
        console.debug('Found LIST chunk:', {
          type: listType.toString(16),
          expectedHdrlType: AVIParser.CHUNKS.hdrl.toString(16),
        })

        if (listType === AVIParser.CHUNKS.hdrl) {
          // Found main AVI header
          const avihChunkId = this.readUint32LE()
          const avihSize = this.readUint32LE()

          console.debug('Found hdrl chunk:', {
            id: avihChunkId.toString(16),
            expectedId: AVIParser.CHUNKS.avih.toString(16),
            size: avihSize,
          })

          if (avihChunkId === AVIParser.CHUNKS.avih) {
            return this.parseAVIMainHeader(avihSize)
          }
        } else {
          const skipSize = chunkSize - 4 // Subtract the 4 bytes we read for listType
          if (skipSize > 0 && skipSize <= this.reader.length - this.reader.offset) {
            this.reader.skip(skipSize)
          } else {
            console.debug('Invalid LIST skip size:', { skipSize })
            break
          }
        }
      } else {
        if (chunkSize > 0 && chunkSize <= this.reader.length - this.reader.offset) {
          this.reader.skip(chunkSize)
        } else {
          console.debug('Invalid chunk skip size:', { chunkSize })
          break
        }
      }
    }

    throw new Error('No main AVI header found')
  }

  /**
   * Parses the AVI main header structure (avih).
   * This contains global information about the video file.
   * @param size Size of the avih chunk in bytes
   * @returns Object containing video metadata and frame count
   */
  private parseAVIMainHeader(
    size: number
  ): Partial<VideoTrackMetadata> & { totalFrames: number; maxBytesPerSec: number } {
    console.debug('Parsing AVI main header:', { size })

    // Read main header fields
    const microSecPerFrame = this.readUint32LE() // microseconds per frame
    const maxBytesPerSec = this.readUint32LE() // maximum data rate
    const paddingGranularity = this.readUint32LE() // padding for data alignment
    const flags = this.readUint32LE() // file capabilities
    const totalFrames = this.readUint32LE() // total frames in file
    const initialFrames = this.readUint32LE() // initial frames for interleaved files
    const streams = this.readUint32LE() // number of streams in the file
    const suggestedBufferSize = this.readUint32LE() // suggested buffer size for reading
    const width = this.readUint32LE() // width in pixels
    const height = this.readUint32LE() // height in pixels
    this.reader.skip(16) // Skip reserved[4], 4 DWORDS reserved for future use

    console.debug('AVI main header values:', {
      microSecPerFrame,
      maxBytesPerSec,
      paddingGranularity,
      flags: flags.toString(16),
      totalFrames,
      initialFrames,
      streams,
      suggestedBufferSize,
      width,
      height,
    })

    // Validate dimensions (max 10000 pixels to prevent unreasonable values)
    const MAX_DIMENSION = 10000
    if (width > MAX_DIMENSION || width <= 0 || height > MAX_DIMENSION || height <= 0) {
      console.debug('Invalid dimensions, using defaults')
      return {
        width: 0,
        height: 0,
        displayAspectWidth: 0,
        displayAspectHeight: 0,
        fps: 0,
        rotation: 0,
        totalFrames: 0,
        maxBytesPerSec: 0,
      }
    }

    // Calculate fps from microseconds per frame
    // 1 second = 1,000,000 microseconds
    const MICROSECONDS_PER_SECOND = 1_000_000
    const fps = microSecPerFrame > 0 ? MICROSECONDS_PER_SECOND / microSecPerFrame : 0

    return {
      width,
      height,
      displayAspectWidth: width,
      displayAspectHeight: height,
      fps,
      rotation: 0, // AVI doesn't support rotation metadata
      totalFrames,
      maxBytesPerSec,
    }
  }

  /**
   * Parses stream headers to extract video and audio metadata.
   * AVI files can contain multiple streams, typically one video and one audio stream.
   * The method first collects all stream information, then calculates accurate bitrates
   * by accounting for both video and audio data.
   *
   * @returns Promise<Object> Combined video and audio metadata including:
   * - Video: codec, dimensions, framerate
   * - Audio: codec, channels, sample rate, bitrate
   * - Accurate video bitrate calculation that excludes audio data size
   */
  private async parseStreamHeaders(): Promise<
    Partial<VideoTrackMetadata> & {
      hasAudio: boolean
      audioCodec: string
      audioChannels: number
      audioSampleRate: number
      videoBitrate?: number
      audioBitrate?: number
    }
  > {
    // Initialize stream info containers
    let videoInfo: Partial<VideoTrackMetadata> = {}
    let hasAudio = false
    let audioCodec = ''
    let audioChannels = 0
    let audioSampleRate = 0
    let videoBitrate: number | undefined
    let audioBitrate: number | undefined
    let videoLength = 0
    let videoRate = 0
    let videoScale = 1

    // Parse stream headers until we can't read anymore or find what we need
    while (this.reader.canRead(8)) {
      const chunkId = this.readUint32LE()
      const chunkSize = this.readUint32LE()

      console.debug('Parsing stream chunk:', {
        id: chunkId.toString(16),
        expectedListId: AVIParser.CHUNKS.LIST.toString(16),
        size: chunkSize,
      })

      // Validate chunk size to prevent buffer overruns
      if (chunkSize > this.reader.length - this.reader.offset || chunkSize < 0) {
        console.debug('Invalid chunk size:', {
          chunkSize,
          remainingBytes: this.reader.length - this.reader.offset,
          offset: this.reader.offset,
        })
        break
      }

      if (chunkId === AVIParser.CHUNKS.LIST) {
        // LIST chunks must be at least 4 bytes (for list type)
        const MIN_LIST_SIZE = 4
        if (chunkSize < MIN_LIST_SIZE) {
          console.debug('LIST chunk too small:', { chunkSize })
          break
        }

        const listType = this.readUint32LE()
        console.debug('Found stream LIST chunk:', {
          type: listType.toString(16),
          expectedStrlType: AVIParser.CHUNKS.strl.toString(16),
        })

        if (listType === AVIParser.CHUNKS.strl) {
          // Parse stream header - could be video or audio
          const streamHeader = await this.parseStreamHeader()
          if (streamHeader) {
            if (streamHeader.type === 'video') {
              videoInfo = { ...videoInfo, ...streamHeader.data }
              videoLength = streamHeader.length
              videoRate = streamHeader.rate
              videoScale = streamHeader.scale
            } else if (streamHeader.type === 'audio') {
              hasAudio = true
              audioCodec = streamHeader.data.codec || ''
              audioChannels = streamHeader.data.channels || 0
              audioSampleRate = streamHeader.data.sampleRate || 0
              audioBitrate = streamHeader.data.bitrate
            }
          }
        } else {
          // Skip non-stream LIST chunks
          const skipSize = chunkSize - MIN_LIST_SIZE
          if (skipSize > 0 && skipSize <= this.reader.length - this.reader.offset) {
            this.reader.skip(skipSize)
          } else {
            console.debug('Invalid LIST skip size:', { skipSize })
            break
          }
        }
      } else {
        // Skip unknown chunks
        if (chunkSize > 0 && chunkSize <= this.reader.length - this.reader.offset) {
          this.reader.skip(chunkSize)
        } else {
          console.debug('Invalid chunk skip size:', { chunkSize })
          break
        }
      }
    }

    // Calculate accurate video bitrate after collecting all stream info
    if (videoLength > 0 && videoRate && videoScale) {
      const durationInSeconds = videoLength / (videoRate / videoScale)
      if (durationInSeconds > 0) {
        // Calculate video bitrate by subtracting audio data size from total file size
        const totalAudioBytes = ((audioBitrate || 0) / 8) * durationInSeconds
        const videoBytes = this.reader.length - totalAudioBytes
        videoBitrate = Math.floor((videoBytes * 8) / durationInSeconds)

        // Log detailed bitrate calculation for debugging
        console.debug('Final bitrate calculation:', {
          totalSize: this.reader.length,
          audioSize: totalAudioBytes,
          videoSize: videoBytes,
          duration: durationInSeconds,
          calculatedBitrate: videoBitrate,
          audioBitrate,
        })
      }
    }

    return {
      ...videoInfo,
      hasAudio,
      audioCodec,
      audioChannels,
      audioSampleRate,
      videoBitrate,
      audioBitrate,
    }
  }

  /**
   * Parses a single stream header (strh chunk) and its format-specific data (strf chunk).
   * This method handles both video and audio streams:
   * - For video: Extracts codec, dimensions, frame rate
   * - For audio: Extracts codec, channels, sample rate, bitrate
   *
   * @returns Promise<Object | null> Stream metadata or null if invalid/unsupported
   * @throws Error if unable to read required bytes
   */
  private async parseStreamHeader(): Promise<
    | {
        type: 'video'
        data: Partial<VideoTrackMetadata>
        length: number
        rate: number
        scale: number
      }
    | {
        type: 'audio'
        data: { codec: string; channels: number; sampleRate: number; bitrate?: number }
      }
    | null
  > {
    if (!this.reader.canRead(8)) return null

    const strhId = this.readUint32LE()
    const strhSize = this.readUint32LE()

    console.debug('Stream header:', {
      id: strhId.toString(16),
      expectedId: AVIParser.CHUNKS.strh.toString(16),
      size: strhSize,
    })

    // Validate strh size
    if (strhSize > this.reader.length - this.reader.offset || strhSize < 0) {
      console.debug('Invalid strh size:', { strhSize })
      return null
    }

    if (strhId !== AVIParser.CHUNKS.strh) {
      if (strhSize > 0 && strhSize <= this.reader.length - this.reader.offset) {
        this.reader.skip(strhSize)
      }
      return null
    }

    const streamType = this.readUint32LE()
    console.debug('Stream type:', {
      type: streamType.toString(16),
      expectedType: AVIParser.CHUNKS.vids.toString(16),
    })

    if (streamType === AVIParser.CHUNKS.vids) {
      const { data, length, rate, scale } = await this.parseVideoStreamHeader(
        strhSize,
        this.mainHeader || {
          width: 0,
          height: 0,
          displayAspectWidth: 0,
          displayAspectHeight: 0,
          fps: 0,
          totalFrames: 0,
          maxBytesPerSec: 0,
        }
      )
      return { type: 'video', data, length, rate, scale }
    }

    if (streamType === AVIParser.CHUNKS.auds) {
      const { data, bitrate } = await this.parseAudioStreamHeader(strhSize)
      const result: { type: 'audio'; data: typeof data } = {
        type: 'audio',
        data,
      }
      return result
    }

    const skipSize = strhSize - 4 // Subtract the 4 bytes we read for streamType
    if (skipSize > 0 && skipSize <= this.reader.length - this.reader.offset) {
      this.reader.skip(skipSize)
    }
    return null
  }

  /**
   * Parses audio stream format data (WAVEFORMATEX structure).
   * Extracts audio codec, channels, sample rate, and calculates bitrate.
   * Also stores audio info for accurate video bitrate calculation.
   *
   * @param strhSize Size of the stream header chunk to skip
   * @returns Object containing audio metadata and bitrate
   * @throws Error if unable to read required bytes
   */
  private async parseAudioStreamHeader(strhSize: number): Promise<{
    data: { codec: string; channels: number; sampleRate: number; bitrate: number }
    bitrate: number
  }> {
    // Skip the video-specific fields in strh
    this.reader.skip(strhSize - 4) // We already read streamType (4 bytes)

    // Read WAVEFORMATEX structure from strf chunk
    if (!this.reader.canRead(8))
      return { data: { codec: '', channels: 0, sampleRate: 0, bitrate: 0 }, bitrate: 0 }

    const strfId = this.readUint32LE()
    const strfSize = this.readUint32LE()

    console.debug('WAVEFORMATEX:', {
      id: strfId.toString(16),
      expectedId: AVIParser.CHUNKS.strf.toString(16),
      size: strfSize,
    })

    if (strfId !== AVIParser.CHUNKS.strf || strfSize < 16) {
      console.debug('Invalid audio format chunk')
      if (strfSize > 0 && strfSize <= this.reader.length - this.reader.offset) {
        this.reader.skip(strfSize)
      }
      return { data: { codec: '', channels: 0, sampleRate: 0, bitrate: 0 }, bitrate: 0 }
    }

    const wFormatTag = this.readUint16LE()
    const nChannels = this.readUint16LE()
    const nSamplesPerSec = this.readUint32LE()
    const nAvgBytesPerSec = this.readUint32LE()
    const nBlockAlign = this.readUint16LE()
    const wBitsPerSample = this.readUint16LE()

    console.debug('WAVEFORMATEX values:', {
      formatTag: wFormatTag.toString(16),
      channels: nChannels,
      samplesPerSec: nSamplesPerSec,
      avgBytesPerSec: nAvgBytesPerSec,
      blockAlign: nBlockAlign,
      bitsPerSample: wBitsPerSample,
    })

    // Skip any remaining bytes in strf chunk
    const remainingBytes = strfSize - 16 // We read 16 bytes of WAVEFORMATEX
    if (remainingBytes > 0) {
      this.reader.skip(remainingBytes)
    }

    // Map format tag to codec string
    const audioCodec = this.formatAudioCodec(wFormatTag)
    const bitrate = nAvgBytesPerSec * 8

    // Store audio info for later use in video bitrate calculation
    this.audioInfo = {
      avgBytesPerSec: nAvgBytesPerSec,
    }

    return {
      data: {
        codec: audioCodec,
        channels: nChannels,
        sampleRate: nSamplesPerSec,
        bitrate,
      },
      bitrate,
    }
  }

  /**
   * Parses video stream header and format data (BITMAPINFOHEADER).
   * Extracts video codec, frame rate, and timing information.
   *
   * @param strhSize Size of the stream header chunk
   * @param mainHeader Main AVI header data for validation
   * @returns Object containing video metadata and timing info
   * @throws Error if unable to read required bytes
   */
  private async parseVideoStreamHeader(
    strhSize: number,
    mainHeader: {
      width?: number
      height?: number
      displayAspectWidth?: number
      displayAspectHeight?: number
      fps?: number
      totalFrames?: number
      maxBytesPerSec?: number
    }
  ): Promise<{
    data: Partial<VideoTrackMetadata>
    length: number
    rate: number
    scale: number
  }> {
    // Parse video stream header
    const codec = this.readFourCC()
    const flags = this.readUint32LE()
    const priority = this.readUint16LE()
    const language = this.readUint16LE()
    const initialFrames = this.readUint32LE()
    const scale = this.readUint32LE()
    const rate = this.readUint32LE()
    const start = this.readUint32LE()
    const length = this.readUint32LE()
    const suggestedBufferSize = this.readUint32LE()
    const quality = this.readUint32LE()
    const sampleSize = this.readUint32LE()

    console.debug('Video stream header:', {
      codec,
      flags: flags.toString(16),
      scale,
      rate,
      length,
      fps: rate / scale,
    })

    // Skip any remaining bytes in strh chunk
    const remainingStrhBytes = strhSize - 48 // 48 bytes read so far
    if (remainingStrhBytes > 0) {
      this.reader.skip(remainingStrhBytes)
    }

    // Parse BITMAPINFOHEADER
    const bitmapHeader = await this.parseBitmapInfoHeader()
    if (!bitmapHeader) return { data: {}, length: 0, rate: 0, scale: 1 }

    return {
      data: {
        ...bitmapHeader,
        codec: this.formatCodec(codec),
        fps: rate / scale,
      },
      length,
      rate,
      scale,
    }
  }

  /**
   * Parses BITMAPINFOHEADER structure from video format chunk.
   * Contains detailed video format information including:
   * - Dimensions (width, height)
   * - Color depth (bits per pixel)
   * - Compression type
   * - Image size in bytes
   *
   * @returns Promise<Object | null> Video format data or null if invalid
   * @throws Error if unable to read required bytes
   */
  private async parseBitmapInfoHeader(): Promise<
    (Partial<VideoTrackMetadata> & { biSizeImage?: number }) | null
  > {
    // Validate we can read strf header
    if (!this.reader.canRead(8)) return null

    // Parse BITMAPINFOHEADER in strf chunk
    const strfId = this.readUint32LE()
    const strfSize = this.readUint32LE()

    console.debug('BITMAPINFOHEADER:', {
      id: strfId.toString(16),
      expectedId: AVIParser.CHUNKS.strf.toString(16),
      size: strfSize,
      offset: this.reader.offset,
    })

    // Validate strf size
    const maxStrfSize = 1024 * 1024 // 1MB max size for sanity
    if (
      strfSize > maxStrfSize ||
      strfSize < 40 ||
      strfSize > this.reader.length - this.reader.offset
    ) {
      console.debug('Invalid strf size:', { strfSize })
      return null
    }

    if (strfId === AVIParser.CHUNKS.strf) {
      const biSize = this.readUint32LE()
      if (biSize < 40 || biSize > strfSize) {
        console.debug('Invalid BITMAPINFOHEADER size:', { biSize, strfSize })
        return null
      }

      const biWidth = this.readUint32LE()
      const biHeight = this.readUint32LE()
      const biPlanes = this.readUint16LE()
      const biBitCount = this.readUint16LE()
      const biCompression = this.readFourCC()
      const biSizeImage = this.readUint32LE()
      const biXPelsPerMeter = this.readUint32LE()
      const biYPelsPerMeter = this.readUint32LE()
      const biClrUsed = this.readUint32LE()
      const biClrImportant = this.readUint32LE()

      console.debug('BITMAPINFOHEADER values:', {
        size: biSize,
        width: biWidth,
        height: biHeight,
        planes: biPlanes,
        bitCount: biBitCount,
        compression: biCompression,
        sizeImage: biSizeImage,
      })

      // Skip any remaining bytes in strf chunk
      const remainingStrfBytes = strfSize - biSize
      if (remainingStrfBytes > 0) {
        this.reader.skip(remainingStrfBytes)
      }

      // Validate dimensions
      if (biWidth > 10000 || biWidth <= 0 || Math.abs(biHeight) > 10000 || biHeight === 0) {
        console.debug('Invalid bitmap dimensions')
        return null
      }

      return {
        width: biWidth,
        height: Math.abs(biHeight), // Height might be negative for top-down images
        displayAspectWidth: biWidth,
        displayAspectHeight: Math.abs(biHeight),
        colorInfo: this.getDefaultColorInfo(), // AVI doesn't support HDR
        biSizeImage,
      }
    }

    return null
  }
}
