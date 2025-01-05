import type {
  MP4Box,
  ParsedVideoMetadata,
  VideoColorInfo,
  VideoTrackMetadata,
} from '../ExpoVideoMetadata.types'

import { BinaryReaderImpl } from './binary-reader'
import { FpsDetector } from './fps-detector'
import { MP4ColorParser } from './mp4-color'

interface FragmentInfo {
  defaultSampleDescriptionIndex: number
  defaultSampleDuration: number
  defaultSampleSize: number
  defaultSampleFlags: number
}

interface TrackFragment {
  trackId: number
  fragmentInfo: FragmentInfo
}

export class MP4Parser {
  protected reader: BinaryReaderImpl
  protected boxes: MP4Box[] = []
  protected fragments = new Map<number, TrackFragment>()

  constructor(data: Uint8Array) {
    this.reader = new BinaryReaderImpl(data)
  }

  public async parse(): Promise<ParsedVideoMetadata> {
    try {
      await this.readBoxes()

      const moov = this.boxes.find((box) => box.type === 'moov')
      if (!moov) throw new Error('No moov box found')

      const moovBoxes = await this.parseBoxes(moov.data!)
      const trak = await this.findVideoTrack(moovBoxes)
      if (!trak) throw new Error('File contains no video track, likely just audio')

      const metadata = await this.parseVideoTrack(trak, moovBoxes) // Pass moovBoxes
      const duration = await this.getDuration(moovBoxes)

      const audioTrak = await this.findAudioTrack(moovBoxes)
      console.debug('Audio track found:', audioTrak ? { size: audioTrak.size } : 'not found')

      const audioInfo = audioTrak
        ? await this.parseAudioMetadata(audioTrak)
        : {
            hasAudio: false,
            audioChannels: 0,
            audioSampleRate: 0,
            audioCodec: '',
          }

      const bitrate =
        this.reader.length && duration ? Math.floor((this.reader.length * 8) / duration) : undefined

      return {
        ...metadata,
        ...audioInfo,
        duration,
        fileSize: this.reader.length,
        bitrate,
        container: 'mp4',
      }
    } catch (error) {
      console.error('Error parsing MP4:', error)
      throw error
    }
  }

  protected async readBoxes(): Promise<void> {
    this.boxes = []
    this.fragments = new Map<number, TrackFragment>()
    let offset = 0
    const data = this.reader.data

    while (offset < data.length) {
      if (data.length - offset < 8) break

      let size =
        (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]

      const type = new TextDecoder().decode(data.slice(offset + 4, offset + 8))
      let headerSize = 8

      // Handle 64-bit size
      if (size === 1 && data.length - offset >= 16) {
        const highBits =
          (data[offset + 8] << 24) |
          (data[offset + 9] << 16) |
          (data[offset + 10] << 8) |
          data[offset + 11]
        const lowBits =
          (data[offset + 12] << 24) |
          (data[offset + 13] << 16) |
          (data[offset + 14] << 8) |
          data[offset + 15]
        size = highBits * 2 ** 32 + lowBits
        headerSize = 16
      }
      // Handle box that extends to EOF
      else if (size === 0) {
        size = data.length - offset
      }

      if (offset + headerSize <= data.length) {
        const box: MP4Box = {
          type,
          size,
          start: offset,
          end: offset + size,
          data: data.subarray(offset + headerSize, offset + size),
        }

        this.boxes.push(box)

        if (type === 'moof') {
          await this.parseFragment(box)
        }
      }

      if (size < headerSize) size = headerSize
      offset += size
    }
  }

  /**
   * Parses a movie fragment box (moof) to extract track-specific information.
   * Used in fragmented MP4s where track data is split across multiple fragments.
   *
   * Fragment structure:
   * moof
   *   └── traf (Track Fragment)
   *       └── tfhd (Track Fragment Header)
   *           Contains: track_ID, sample defaults
   *
   * @param moof - The movie fragment box to parse
   */
  private async parseFragment(moof: MP4Box): Promise<void> {
    const moofBoxes = await this.parseBoxes(moof.data!)
    const traf = moofBoxes.find((box) => box.type === 'traf')

    if (traf) {
      const trafBoxes = await this.parseBoxes(traf.data!)
      const tfhd = trafBoxes.find((box) => box.type === 'tfhd')

      if (tfhd?.data) {
        // Track ID is at bytes 5-8 (after version and flags)
        const trackId =
          (tfhd.data[4] << 24) | (tfhd.data[5] << 16) | (tfhd.data[6] << 8) | tfhd.data[7]

        // Read flags from bytes 2-4
        const flags = (tfhd.data[1] << 16) | (tfhd.data[2] << 8) | tfhd.data[3]

        let offset = 8 // Start after track_ID
        const fragmentInfo: FragmentInfo = {
          defaultSampleDescriptionIndex: 1,
          defaultSampleDuration: 0,
          defaultSampleSize: 0,
          defaultSampleFlags: 0,
        }

        // Parse optional fields based on flags
        // Each flag indicates presence of a specific field
        if (flags & 0x000001) offset += 8 // base-data-offset-present
        if (flags & 0x000002) {
          // sample-description-index-present
          fragmentInfo.defaultSampleDescriptionIndex =
            (tfhd.data[offset] << 24) |
            (tfhd.data[offset + 1] << 16) |
            (tfhd.data[offset + 2] << 8) |
            tfhd.data[offset + 3]
          offset += 4
        }
        if (flags & 0x000008) {
          // default-sample-duration-present
          fragmentInfo.defaultSampleDuration =
            (tfhd.data[offset] << 24) |
            (tfhd.data[offset + 1] << 16) |
            (tfhd.data[offset + 2] << 8) |
            tfhd.data[offset + 3]
          offset += 4
        }
        if (flags & 0x000010) {
          // default-sample-size-present
          fragmentInfo.defaultSampleSize =
            (tfhd.data[offset] << 24) |
            (tfhd.data[offset + 1] << 16) |
            (tfhd.data[offset + 2] << 8) |
            tfhd.data[offset + 3]
          offset += 4
        }
        if (flags & 0x000020) {
          // default-sample-flags-present
          fragmentInfo.defaultSampleFlags =
            (tfhd.data[offset] << 24) |
            (tfhd.data[offset + 1] << 16) |
            (tfhd.data[offset + 2] << 8) |
            tfhd.data[offset + 3]
        }

        this.fragments.set(trackId, { trackId, fragmentInfo })
      }
    }
  }

  /**
   * Gets the duration of the video in seconds.
   * Reads from the media header box (mdhd) which contains timing information.
   *
   * @param moovBoxes - Array of boxes from the movie box
   * @returns Promise<number> Duration in seconds, or 0 if not found
   */
  protected async getDuration(moovBoxes: MP4Box[]): Promise<number> {
    try {
      for (const trak of moovBoxes.filter((box) => box.type === 'trak')) {
        const mdia = this.findBox(await this.parseBoxes(trak.data!), 'mdia')
        if (!mdia) continue

        const mdiaBoxes = await this.parseBoxes(mdia.data!)
        const mdhd = this.findBox(mdiaBoxes, 'mdhd')
        if (!mdhd) continue

        const reader = new BinaryReaderImpl(mdhd.data!)
        const version = reader.readUint8()
        reader.skip(3) // flags

        if (version === 1) {
          reader.skip(16) // 64-bit creation and modification times
        } else {
          reader.skip(8) // 32-bit creation and modification times
        }

        const timescale = reader.readUint32()
        const duration = version === 1 ? reader.readUint64() : reader.readUint32()

        return duration / timescale
      }
    } catch (error) {
      console.debug('Error getting duration:', error)
    }
    return 0
  }

  /**
   * Parses a sequence of MP4 boxes from binary data.
   * Each box consists of a size (4 bytes), type (4 bytes), and data.
   * Some boxes have extended headers or 64-bit sizes.
   *
   * @param data - The binary data containing MP4 boxes
   * @returns Promise<MP4Box[]> Array of parsed boxes
   */
  protected async parseBoxes(data: Uint8Array): Promise<MP4Box[]> {
    const boxes: MP4Box[] = []
    let offset = 0

    while (offset < data.length) {
      // Every box must start with a 32-bit size and 4-byte type
      if (data.length - offset < 8) break

      // First 4 bytes are box size (big-endian)
      const size =
        (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]

      if (size <= 0 || size > data.length - offset) break

      // Next 4 bytes are box type (FourCC)
      const type = new TextDecoder().decode(data.slice(offset + 4, offset + 8))

      // Box header is normally 8 bytes (4 for size + 4 for type)
      // But some boxes have extended headers:
      let boxSize = size
      let headerSize = 8

      if (type === 'stsd') {
        // Sample Description Box: 8 bytes header + 8 bytes version/flags/entry_count
        headerSize = 16
      } else if (type === 'avc1' || type === 'hev1' || type === 'hvc1' || type === 'vp09') {
        // Visual Sample Entry boxes: 8 bytes header + 78 bytes of standard fields
        // - 6 bytes reserved
        // - 2 bytes data reference index
        // - 16 bytes pre-defined
        // - 12 bytes for width, height, horizresolution, vertresolution
        // - 4 bytes reserved
        // - 2 bytes frame_count
        // - 32 bytes compressorname
        // - 4 bytes depth
        // - 2 bytes pre-defined
        headerSize = 86
      }

      // Check for 64-bit size field
      // If size==1, the real size is in the next 8 bytes (64-bit)
      if (size === 1) {
        if (data.length - offset < 16) break

        // Read high 32 bits
        const highBits =
          (data[offset + 8] << 24) |
          (data[offset + 9] << 16) |
          (data[offset + 10] << 8) |
          data[offset + 11]

        // Read low 32 bits
        const lowBits =
          (data[offset + 12] << 24) |
          (data[offset + 13] << 16) |
          (data[offset + 14] << 8) |
          data[offset + 15]

        // Combine into 64-bit size
        boxSize = highBits * 2 ** 32 + lowBits
        headerSize = 16 // 8 bytes original header + 8 bytes extended size
      }

      // Validate box size
      if (boxSize < headerSize || offset + boxSize > data.length) break

      // Store box info and data (excluding header)
      boxes.push({
        type,
        size: boxSize,
        start: offset,
        end: offset + boxSize,
        data: data.subarray(offset + headerSize, offset + boxSize),
      })

      offset += boxSize
    }

    console.debug(
      'Found boxes:',
      boxes.map((b) => ({ type: b.type, size: b.size }))
    )
    return boxes
  }

  /**
   * Finds a box of a specific type in an array of boxes.
   * Simple helper method for direct box lookup.
   *
   * @param boxes - Array of MP4 boxes to search
   * @param type - The 4-character box type to find
   * @returns The found box or undefined
   */
  protected findBox(boxes: MP4Box[], type: string): MP4Box | undefined {
    return boxes.find((box) => box.type === type)
  }

  /**
   * Finds the byte offset of a specific box type within the data.
   * This is used when we need to locate a box's position without parsing the entire structure.
   *
   * @param data - The binary data to search through
   * @param type - The 4-character box type to find (e.g., 'mdia', 'hdlr')
   * @returns The byte offset where the box starts, or -1 if not found
   */
  protected findBoxOffset(data: Uint8Array, type: string): number {
    let offset = 0
    while (offset < data.length - 8) {
      // -8 because we need at least size (4) + type (4)
      // Read box size (32-bit big-endian)
      const size =
        (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]

      // Read box type (4 characters)
      const boxType = new TextDecoder().decode(data.slice(offset + 4, offset + 8))

      if (boxType === type) {
        return offset
      }

      // Special cases for box size:
      // size == 0: box extends to end of file
      // size == 1: 64-bit size follows
      if (size === 0) break
      if (size === 1) {
        if (data.length - offset < 16) break // Not enough data for 64-bit size
        const headerSize = 16 // 8 bytes original header + 8 bytes extended size
        offset += headerSize
      } else {
        offset += size
      }
    }
    return -1
  }

  /**
   * Finds the video track in the movie box hierarchy.
   * A video track is identified by its handler type 'vide' in the hdlr box.
   * Also handles fragmented MP4s where track info might be in mvex box.
   *
   * Box hierarchy for track identification:
   * moov
   *   └── trak
   *       └── mdia
   *           └── hdlr (contains handler_type = 'vide' for video tracks)
   *
   * For fragmented MP4s:
   * moov
   *   ├── trak (contains track_ID)
   *   └── mvex
   *       └── trex (references track_ID)
   *
   * @param moovBoxes - Array of boxes from the movie (moov) box
   * @returns Promise<MP4Box | undefined> The video track box if found
   */
  protected async findVideoTrack(moovBoxes: MP4Box[]): Promise<MP4Box | undefined> {
    console.debug(
      'Looking for video track in moov boxes:',
      moovBoxes.map((b) => ({ type: b.type, size: b.size }))
    )

    // Get all track boxes
    const tracks = moovBoxes.filter((box) => box.type === 'trak')
    console.debug('Found tracks:', tracks.length)

    // First check normal (non-fragmented) MP4 tracks
    for (const trak of tracks) {
      // Find media box (mdia) within track
      const mdiaOffset = this.findBoxOffset(trak.data!, 'mdia')
      console.debug('Found mdia offset:', mdiaOffset)
      if (mdiaOffset === -1) continue

      // Get handler box (hdlr) within media box
      // Skip 8 bytes (size + type) to get to mdia data
      const mdiaData = trak.data!.subarray(mdiaOffset + 8)
      const hdlrOffset = this.findBoxOffset(mdiaData, 'hdlr')
      console.debug('Found hdlr offset:', hdlrOffset)
      if (hdlrOffset === -1) continue

      // Handler type is at offset 16 in hdlr box:
      // - 8 bytes: size + type
      // - 4 bytes: version + flags
      // - 4 bytes: pre_defined
      // - 4 bytes: handler_type ('vide' for video)
      const handlerOffset = hdlrOffset + 16
      if (mdiaData.length < handlerOffset + 4) continue

      const handlerType = new TextDecoder().decode(
        mdiaData.subarray(handlerOffset, handlerOffset + 4)
      )
      console.debug('Found track type:', handlerType)

      if (handlerType === 'vide') {
        return trak
      }
    }

    // Check for fragmented MP4 structure
    // In fragmented MP4s, track info is split between trak and trex boxes
    const mvex = moovBoxes.find((box) => box.type === 'mvex')
    if (mvex) {
      console.debug('Found fragmented MP4')
      const mvexBoxes = await this.parseBoxes(mvex.data!)

      // Look through track extend boxes (trex)
      for (const trex of mvexBoxes.filter((box) => box.type === 'trex')) {
        // Track ID is at offset 4-7 in trex box (after version + flags)
        const trackId =
          (trex.data![4] << 24) | (trex.data![5] << 16) | (trex.data![6] << 8) | trex.data![7]

        // Find matching track by ID
        for (const trak of tracks) {
          const tkhd = this.findBox(await this.parseBoxes(trak.data!), 'tkhd')
          if (tkhd) {
            // Track ID is at offset 12-15 in tkhd box
            // (after version + flags + creation_time + modification_time)
            const trakId =
              (tkhd.data![12] << 24) |
              (tkhd.data![13] << 16) |
              (tkhd.data![14] << 8) |
              tkhd.data![15]

            if (trakId === trackId) {
              return trak
            }
          }
        }
      }
    }

    return undefined
  }

  /**
   * Parses a video track to extract metadata including:
   * - Dimensions (width, height, display aspect)
   * - Codec information
   * - Color information (color space, HDR metadata)
   * - Bitrate information
   *
   * @param trak - The track box containing video data
   * @param moovBoxes - All boxes from the movie box (for additional metadata)
   * @returns Promise<VideoTrackMetadata>
   */
  protected async parseVideoTrack(trak: MP4Box, moovBoxes: MP4Box[]): Promise<VideoTrackMetadata> {
    let videoBitrate: number | undefined
    let codec = ''
    let timescale: number | undefined
    let fps: number | undefined

    // Parse track header box (tkhd) for basic video properties
    const trakBoxes = await this.parseBoxes(trak.data!)
    const tkhd = this.findBox(trakBoxes, 'tkhd')
    if (!tkhd) {
      throw new Error('No tkhd box found')
    }

    const reader = new BinaryReaderImpl(tkhd.data!)

    // Skip version and flags (4 bytes)
    reader.skip(4)
    // Skip creation_time, modification_time, track_ID, reserved (16 bytes)
    reader.skip(16)
    // Skip duration (4 bytes)
    reader.skip(4)
    // Skip reserved fields (8 bytes)
    reader.skip(8)
    // Skip layer and alternate_group (4 bytes)
    reader.skip(4)
    // Skip volume and reserved (4 bytes)
    reader.skip(4)

    // Read transformation matrix (9 x 32-bit fixed-point values)
    // This matrix defines how the video should be transformed (rotation, scale, etc.)
    const matrix: number[] = []
    for (let i = 0; i < 9; i++) {
      matrix.push(reader.readUint32())
    }

    console.debug('Transformation matrix:', {
      matrix,
      hex: matrix.map((n) => '0x' + n.toString(16)),
      normalized: matrix.map((n) => n / 0x10000), // Convert from 16.16 fixed-point
    })

    // Calculate scale factors from matrix (in 16.16 fixed-point)
    const scaleX = Math.sqrt(matrix[0] * matrix[0] + matrix[3] * matrix[3]) / 0x10000
    const scaleY = Math.sqrt(matrix[1] * matrix[1] + matrix[4] * matrix[4]) / 0x10000

    console.debug('Scale factors:', { scaleX, scaleY })

    // Read dimensions from tkhd (these are the display dimensions)
    let displayWidth = Math.round(reader.readUint32() / 65536) // Divide by 2^16 to convert fixed-point
    let displayHeight = Math.round(reader.readUint32() / 65536)

    // Initialize dimensions
    let width = displayWidth
    let height = displayHeight
    let unrotatedWidth = displayWidth
    let unrotatedHeight = displayHeight

    // Find media information box hierarchy
    const mdia = this.findBox(trakBoxes, 'mdia')
    if (!mdia) throw new Error('No mdia box found')

    const mdiaBoxes = await this.parseBoxes(mdia.data!)
    const minf = this.findBox(mdiaBoxes, 'minf')
    if (!minf) throw new Error('No minf box found')

    const minfBoxes = await this.parseBoxes(minf.data!)
    const stbl = this.findBox(minfBoxes, 'stbl')
    if (!stbl) throw new Error('No stbl box found')

    const stblBoxes = await this.parseBoxes(stbl.data!)
    const stsd = this.findBox(stblBoxes, 'stsd')
    if (!stsd) throw new Error('No stsd box found')

    const stsdBoxes = await this.parseBoxes(stsd.data!)
    console.debug(
      'STSD box content:',
      stsdBoxes.map((b) => ({ type: b.type, size: b.size }))
    )

    // Find video codec box
    const videoTrack =
      this.findBox(stsdBoxes, 'avc1') ||
      this.findBox(stsdBoxes, 'hev1') ||
      this.findBox(stsdBoxes, 'hvc1') ||
      this.findBox(stsdBoxes, 'mp4v') ||
      this.findBox(stsdBoxes, 'vp08') ||
      this.findBox(stsdBoxes, 'vp09') ||
      this.findBox(stsdBoxes, 'av01')

    if (videoTrack) {
      codec = videoTrack.type

      // Get the actual coded dimensions from the video sample entry
      if (stsd?.data) {
        // Skip version and entry count (8 bytes)
        const stsdReader = new BinaryReaderImpl(stsd.data)
        stsdReader.skip(8)

        // Log the first 100 bytes for debugging
        console.debug(
          'STSD box data (first 100 bytes):',
          Array.from(stsdReader.data.slice(0, 100)).map((b) => '0x' + b.toString(16))
        )

        // In an AVC1 box:
        // - First 8 bytes: size + type ('avc1')
        // - Next 6 bytes: reserved
        // - Next 2 bytes: data reference index
        // - Next 16 bytes: predefined & reserved
        // - Next 2 bytes: width
        // - Next 2 bytes: height
        const widthOffset = 32
        const heightOffset = 34

        // Get the dimensions directly from the avc1 box
        const codedWidth = (stsdReader.data[widthOffset] << 8) | stsdReader.data[widthOffset + 1]
        const codedHeight = (stsdReader.data[heightOffset] << 8) | stsdReader.data[heightOffset + 1]

        console.debug('Raw dimension bytes:', {
          width: [
            '0x' + stsdReader.data[widthOffset].toString(16),
            '0x' + stsdReader.data[widthOffset + 1].toString(16),
          ],
          height: [
            '0x' + stsdReader.data[heightOffset].toString(16),
            '0x' + stsdReader.data[heightOffset + 1].toString(16),
          ],
        })

        if (codedWidth > 0 && codedHeight > 0 && codedWidth < 10000 && codedHeight < 10000) {
          // These are the actual dimensions the video is encoded at
          width = codedWidth
          height = codedHeight
          unrotatedWidth = codedWidth
          unrotatedHeight = codedHeight
          console.debug('Found coded dimensions:', { width, height })
        } else {
          console.debug('Invalid coded dimensions:', { codedWidth, codedHeight })
        }
      }

      const videoBoxes = await this.parseBoxes(videoTrack.data!)

      // Handle pixel aspect ratio
      const pasp = this.findBox(videoBoxes, 'pasp')
      if (pasp?.data) {
        const paspReader = new BinaryReaderImpl(pasp.data)
        const hSpacing = paspReader.readUint32()
        const vSpacing = paspReader.readUint32()
        if (hSpacing && vSpacing) {
          const pixelAspectRatio = hSpacing / vSpacing
          console.debug('Pixel Aspect Ratio:', { hSpacing, vSpacing, ratio: pixelAspectRatio })

          // The display dimensions should be adjusted by PAR
          displayWidth = Math.round(width * pixelAspectRatio)
          displayHeight = height
        }
      }

      // Calculate rotation from transformation matrix
      let rotation = 0
      if (matrix[0] === 0 && matrix[4] === 0) {
        // 90° or 270° rotation
        if (matrix[1] === 0x10000 && matrix[3] === -0x10000) {
          rotation = 90
          // Store unrotated (natural) dimensions first
          unrotatedWidth = width
          unrotatedHeight = height

          // Then swap dimensions for the rotated view
          const temp = width
          width = height
          height = temp

          // Also swap display dimensions
          const tempDisplay = displayWidth
          displayWidth = displayHeight
          displayHeight = tempDisplay
        } else if (matrix[1] === -0x10000 && matrix[3] === 0x10000) {
          rotation = 270
          // Store unrotated (natural) dimensions first
          unrotatedWidth = width
          unrotatedHeight = height

          // Then swap dimensions for the rotated view
          const temp = width
          width = height
          height = temp

          // Also swap display dimensions
          const tempDisplay = displayWidth
          displayWidth = displayHeight
          displayHeight = tempDisplay
        }
      } else if (matrix[0] === -0x10000 && matrix[4] === -0x10000) {
        rotation = 180
        // No dimension swapping needed for 180° rotation
        unrotatedWidth = width
        unrotatedHeight = height
      } else {
        // No rotation
        unrotatedWidth = width
        unrotatedHeight = height
      }

      // Get color info
      let colorInfo = this.getDefaultColorInfo()
      const colr = this.findBox(videoBoxes, 'colr')
      if (colr?.data) {
        colorInfo = MP4ColorParser.parseColorInfo(colr.data)
      }

      // Get fps from mdhd
      const mdhd = this.findBox(mdiaBoxes, 'mdhd')
      if (mdhd?.data) {
        const mdhdReader = new BinaryReaderImpl(mdhd.data)
        const version = mdhdReader.readUint8()
        mdhdReader.skip(3)
        if (version === 1) mdhdReader.skip(16)
        else mdhdReader.skip(8)

        timescale = mdhdReader.readUint32()
        const duration = version === 1 ? mdhdReader.readUint64() : mdhdReader.readUint32()

        const stts = this.findBox(stblBoxes, 'stts')
        if (stts?.data) {
          const timing = FpsDetector.parseMP4TimingInfo(stts.data, timescale, Number(duration))
          if (timing) fps = FpsDetector.calculateFps(timing)
        }
      }

      // Get bitrate
      const btrt = this.findBox(videoBoxes, 'btrt')
      if (btrt?.data) {
        const btrtReader = new BinaryReaderImpl(btrt.data)
        btrtReader.skip(8) // Skip buffer and max bitrate
        videoBitrate = btrtReader.readUint32()
      }

      return {
        width,
        height,
        rotation,
        displayAspectWidth: displayWidth,
        displayAspectHeight: displayHeight,
        unrotatedWidth,
        unrotatedHeight,
        colorInfo,
        fps,
        codec,
        videoBitrate,
      }
    }

    throw new Error('No supported video codec found')
  }

  /**
   * Finds the audio track in the movie box hierarchy.
   * Similar to findVideoTrack but looks for 'soun' handler type.
   *
   * Box hierarchy:
   * moov
   *   └── trak
   *       └── mdia
   *           └── hdlr (contains handler_type = 'soun' for audio tracks)
   *
   * @param moovBoxes - Array of boxes from the movie box
   * @returns Promise<MP4Box | undefined> The audio track box if found
   */
  protected async findAudioTrack(moovBoxes: MP4Box[]): Promise<MP4Box | undefined> {
    for (const trak of moovBoxes.filter((box) => box.type === 'trak')) {
      const mdiaOffset = this.findBoxOffset(trak.data!, 'mdia')
      if (mdiaOffset === -1) continue

      const mdiaData = trak.data!.subarray(mdiaOffset + 8)
      const hdlrOffset = this.findBoxOffset(mdiaData, 'hdlr')
      if (hdlrOffset === -1) continue

      const handlerOffset = hdlrOffset + 16
      if (mdiaData.length < handlerOffset + 4) continue

      const handlerType = new TextDecoder().decode(
        mdiaData.subarray(handlerOffset, handlerOffset + 4)
      )

      if (handlerType === 'soun') {
        return trak
      }
    }

    return undefined
  }

  /**
   * Parses audio metadata from an MP4 audio track.
   * Supports common formats: AAC, HE-AAC, MP3, AC3, E-AC3, DTS, TrueHD, FLAC, ALAC, Opus
   *
   * Box hierarchy for audio configuration:
   * trak
   *   └── mdia
   *       └── minf
   *           └── stbl
   *               └── stsd
   *                   └── mp4a/ac-3/ec-3/dtsc/dtsh/dtsl/dtse/mlpa/alac/Opus
   *                       └── esds/dac3/dec3/dstd/dmlp (codec specific config)
   *
   * @param trak - The audio track box to parse
   * @returns Promise<AudioMetadata> Audio format, channels, and sample rate info
   */
  protected async parseAudioMetadata(trak: MP4Box) {
    try {
      // Parse track boxes hierarchy to find audio sample description
      const trakBoxes = await this.parseBoxes(trak.data!)
      const mdia = this.findBox(trakBoxes, 'mdia')
      if (!mdia) throw new Error('No mdia box')

      const mdiaBoxes = await this.parseBoxes(mdia.data!)
      const minf = this.findBox(mdiaBoxes, 'minf')
      if (!minf) throw new Error('No minf box')

      const minfBoxes = await this.parseBoxes(minf.data!)
      const stbl = this.findBox(minfBoxes, 'stbl')
      if (!stbl) throw new Error('No stbl box')

      const stblBoxes = await this.parseBoxes(stbl.data!)
      const stsd = this.findBox(stblBoxes, 'stsd')
      if (!stsd) throw new Error('No stsd box')

      const stsdBoxes = await this.parseBoxes(stsd.data!)
      const mp4a = this.findBox(stsdBoxes, 'mp4a')
      if (!mp4a || !mp4a.data) throw new Error('No mp4a box')

      // Parse fixed-position audio data from mp4a box:
      // - Bytes 16-17: Number of channels (uint16)
      // - Bytes 24-27: Sample rate (32-bit fixed-point)
      const audioChannels = (mp4a.data[16] << 8) | mp4a.data[17]
      const sampleRate =
        ((mp4a.data[24] << 24) | (mp4a.data[25] << 16) | (mp4a.data[26] << 8) | mp4a.data[27]) >>>
        16 // Convert from 16.16 fixed-point

      // Find ESDS box to determine codec
      // ESDS box starts with 'esds' FourCC (0x65, 0x73, 0x64, 0x73)
      const esdsStart = mp4a.data.indexOf(0x65, 28)
      let codec = 'aac' // Default to AAC
      if (
        esdsStart > 0 &&
        mp4a.data[esdsStart + 1] === 0x73 &&
        mp4a.data[esdsStart + 2] === 0x64 &&
        mp4a.data[esdsStart + 3] === 0x73
      ) {
        // Audio Object Type ID is at offset 21 from ESDS start
        const objectTypeID = mp4a.data[esdsStart + 21]
        console.debug('Audio Object Type ID:', objectTypeID.toString(16))

        // Map Audio Object Type ID to codec string
        switch (objectTypeID) {
          case 0x40:
          case 0x41:
          case 0x42:
            codec = 'aac'
            break
          case 0x45:
          case 0x46:
          case 0x47:
            codec = 'aac-he'
            break
          case 0x67:
          case 0x68:
          case 0xa5:
            codec = 'ac3'
            break
          case 0x6b:
            codec = 'mp3'
            break
          case 0xa6:
            codec = 'e-ac3'
            break
          case 0xa9:
            codec = 'dts'
            break
          case 0xaa:
            codec = 'dts-hd'
            break
          case 0xab:
            codec = 'dts-hd-ma'
            break
          case 0xac:
            codec = 'truehd'
            break
          case 0xad:
            codec = 'flac'
            break
          case 0xae:
            codec = 'alac'
            break
          case 0xaf:
            codec = 'opus'
            break
          case 0x6d:
            codec = 'aac-he-v2'
            break
          case 0xdd:
            codec = 'vorbis'
            break
          case 0xe1:
            codec = 'pcm'
            break
        }
      }

      return {
        hasAudio: true,
        audioChannels,
        audioSampleRate: sampleRate,
        audioCodec: codec,
      }
    } catch (error) {
      console.debug('Error parsing audio metadata:', error)
      return {
        hasAudio: false,
        audioChannels: 0,
        audioSampleRate: 0,
        audioCodec: '',
      }
    }
  }

  /**
   * Returns default color information structure with null values.
   * Used when no color information is available in the video.
   *
   * @returns VideoColorInfo Default color info structure
   */
  protected getDefaultColorInfo(): VideoColorInfo {
    return {
      matrixCoefficients: null,
      transferCharacteristics: null,
      primaries: null,
      fullRange: null,
    }
  }
}
