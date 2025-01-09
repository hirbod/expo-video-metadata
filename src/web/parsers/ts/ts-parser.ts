// ts-parser.ts
import type { ParsedVideoMetadata, VideoTrackMetadata } from '../../../ExpoVideoMetadata.types'
import { BinaryReaderImpl } from '../../binary-reader'
import { AUDIO_STREAM_TYPES, parseAudioStream, type AudioStreamType } from './audio-parser'
import { getDefaultColorInfo } from './color-utils'
import {
  findSPS,
  findVideoPackets,
  parseNALUnits,
  parseSPS,
  STREAM_TYPES,
  streamTypeToCodec,
} from './elementary-stream-parser'
import { parseMPEG2SequenceHeader } from './mpeg2-parser'
import { parsePAT, parsePMT } from './psi-parser'

/**
 * Parser for MPEG Transport Stream (TS) container format.
 * Handles parsing of video and audio elementary streams within TS packets.
 *
 * Key features:
 * - Program Association Table (PAT) parsing
 * - Program Map Table (PMT) parsing
 * - Video elementary stream extraction (MPEG2, H.264, HEVC)
 * - Audio elementary stream extraction (MPEG1/2 Audio, AAC)
 * - PCR-based duration calculation
 * - Bitrate estimation
 */
export class TSParser {
  private reader: BinaryReaderImpl
  // Standard TS packet size as defined by ISO/IEC 13818-1
  private static readonly PACKET_SIZE = 188
  // Sync byte that marks the start of each TS packet
  private static readonly SYNC_BYTE = 0x47

  constructor(data: Uint8Array) {
    this.reader = new BinaryReaderImpl(data)
  }

  /**
   * Main entry point for parsing a Transport Stream.
   * Extracts and parses program information, video/audio streams, and timing data.
   *
   * Process:
   * 1. Verify TS sync bytes
   * 2. Parse PAT to find PMT
   * 3. Parse PMT to find elementary streams
   * 4. Extract and parse video/audio metadata
   * 5. Calculate duration and bitrate
   *
   * @returns Promise<ParsedVideoMetadata> Complete container and stream metadata
   * @throws Error if not a valid TS or no PMT found
   */
  public async parse(): Promise<ParsedVideoMetadata> {
    if (!this.verifyTSSync()) {
      throw new Error('Not a valid Transport Stream')
    }

    const programInfo = parsePAT(this.reader)
    if (!programInfo.pmtPid) {
      throw new Error('No PMT PID found')
    }

    const streams = parsePMT(this.reader, programInfo.pmtPid)
    const videoMetadata = await this.parseVideoStream(streams)
    const audioInfo = await this.parseAudioStream(streams)

    // Calculate duration from PCR values
    const duration = await this.calculateDuration()

    // Calculate bitrate - TS usually has a constant bitrate
    const bitrate = duration ? Math.floor((this.reader.length * 8) / duration) : undefined

    return {
      ...videoMetadata,
      ...audioInfo,
      duration,
      fileSize: this.reader.length,
      bitrate,
      container: 'ts',
    }
  }

  /**
   * Checks if a stream type corresponds to a known video format.
   * Includes both standard stream types from ISO/IEC 13818-1 and common extensions.
   *
   * @param streamType - Stream type value from PMT
   * @returns boolean True if stream type is video
   */
  private isVideoStream(streamType: number): boolean {
    // Add debug logging
    console.debug('Checking stream type:', {
      type: `0x${streamType.toString(16)}`,
      knownTypes: Object.values(STREAM_TYPES).map((t) => `0x${t.toString(16)}`),
    })

    const videoTypes = [
      STREAM_TYPES.VIDEO_MPEG1,
      STREAM_TYPES.VIDEO_MPEG2,
      STREAM_TYPES.VIDEO_MPEG4,
      STREAM_TYPES.VIDEO_H264,
      STREAM_TYPES.VIDEO_HEVC,
      STREAM_TYPES.VIDEO_HEVC_ALT,
      STREAM_TYPES.VIDEO_H265,
      STREAM_TYPES.VIDEO_CAVS,
      STREAM_TYPES.VIDEO_VC1,
      STREAM_TYPES.VIDEO_DIRAC,
      STREAM_TYPES.VIDEO_AVS,
      STREAM_TYPES.VIDEO_AVS2,
      STREAM_TYPES.VIDEO_AVS3,
      STREAM_TYPES.VIDEO_VP8,
      STREAM_TYPES.VIDEO_VP9,
      STREAM_TYPES.VIDEO_AV1,
    ]

    // Also check for common video stream types not in our enum
    if ([0x1b, 0x24, 0x21, 0x10].includes(streamType)) {
      console.debug('Found common video type:', `0x${streamType.toString(16)}`)
      return true
    }

    const result = videoTypes.includes(streamType)
    console.debug('Stream type check result:', result)
    return result
  }

  /**
   * Checks if a stream type corresponds to a known audio format.
   * Uses type predicate to ensure type safety when handling audio streams.
   *
   * @param streamType - Stream type value from PMT
   * @returns boolean True if stream type is audio
   */
  private isAudioStream(streamType: number): streamType is AudioStreamType {
    return [
      AUDIO_STREAM_TYPES.MPEG1_AUDIO,
      AUDIO_STREAM_TYPES.MPEG2_AUDIO,
      AUDIO_STREAM_TYPES.AAC,
      AUDIO_STREAM_TYPES.AAC_LATM,
    ].includes(streamType as AudioStreamType)
  }

  /**
   * Calculates stream duration using Program Clock Reference (PCR) values.
   * PCR is a 33-bit value running at 90kHz, used for timing synchronization.
   *
   * Process:
   * 1. Find PCR-carrying PIDs
   * 2. Extract first and last PCR values
   * 3. Calculate duration from PCR difference
   * 4. Fall back to bitrate-based estimation if PCR not available
   *
   * @returns Promise<number> Duration in seconds
   */
  private async calculateDuration(): Promise<number> {
    try {
      // Find first and last PCR values
      let firstPCR: number | null = null
      let lastPCR: number | null = null
      const pcrPids = new Set<number>()

      // First pass: scan initial packets to find PIDs carrying PCR
      // 940 bytes = 5 TS packets, usually enough to find PCR PID
      for (
        let offset = 0;
        offset < Math.min(this.reader.length, 940);
        offset += TSParser.PACKET_SIZE
      ) {
        const adaptationField = this.getAdaptationField(offset)
        if (adaptationField && adaptationField.flags & 0x10) {
          // 0x10 = PCR flag
          pcrPids.add(this.getPid(offset))
        }
      }

      // Find first PCR
      for (let offset = 0; offset < this.reader.length; offset += TSParser.PACKET_SIZE) {
        const pid = this.getPid(offset)
        if (pcrPids.has(pid)) {
          const pcr = this.getPCR(offset)
          if (pcr !== null) {
            firstPCR = pcr
            break
          }
        }
      }

      // Find last PCR
      for (
        let offset = this.reader.length - TSParser.PACKET_SIZE;
        offset >= 0;
        offset -= TSParser.PACKET_SIZE
      ) {
        const pid = this.getPid(offset)
        if (pcrPids.has(pid)) {
          const pcr = this.getPCR(offset)
          if (pcr !== null) {
            lastPCR = pcr
            break
          }
        }
      }

      if (firstPCR !== null && lastPCR !== null) {
        return (lastPCR - firstPCR) / 90000 // Convert from 90kHz to seconds
      }
    } catch (error) {
      console.debug('Error calculating duration:', error)
    }

    // Fallback: estimate from file size and typical bitrate
    // 10Mbps is a common bitrate for HD content
    return Math.floor((this.reader.length * 8) / 10000000)
  }

  /**
   * Extracts 13-bit PID from TS packet header.
   * PID structure in header (bits):
   * Byte 1: 0x47 (sync)
   * Byte 2: [TEI(1), PES(1), PID_HIGH(5)]
   * Byte 3: [PID_LOW(8)]
   *
   * @param offset - Offset to start of TS packet
   * @returns number 13-bit PID value
   */
  private getPid(offset: number): number {
    return ((this.reader.data[offset + 1] & 0x1f) << 8) | this.reader.data[offset + 2]
  }

  /**
   * Parses adaptation field if present in TS packet.
   * Adaptation field contains timing and control information.
   *
   * Field structure:
   * - Length (8 bits)
   * - Flags (8 bits):
   *   - PCR present (0x10)
   *   - OPCR present (0x08)
   *   - Splicing point (0x04)
   *   - Transport private data (0x02)
   *   - Extension (0x01)
   *
   * @param offset - Offset to start of TS packet
   * @returns Object containing length and flags, or null if no adaptation field
   */
  private getAdaptationField(offset: number): { length: number; flags: number } | null {
    const flags = this.reader.data[offset + 3]
    if ((flags & 0x20) === 0) return null // No adaptation field

    const length = this.reader.data[offset + 4]
    if (length === 0) return null

    return { length, flags: this.reader.data[offset + 5] }
  }

  /**
   * Extracts Program Clock Reference (PCR) from adaptation field.
   * PCR is a 33-bit value used for timing synchronization.
   *
   * PCR structure (bits):
   * - PCR base (33 bits)
   * - Reserved (6 bits)
   * - PCR extension (9 bits)
   *
   * @param offset - Offset to start of TS packet
   * @returns number|null PCR base value or null if not present
   */
  private getPCR(offset: number): number | null {
    const adaptField = this.getAdaptationField(offset)
    if (!adaptField || !(adaptField.flags & 0x10)) return null // 0x10 = PCR present flag

    // PCR is encoded as 6 bytes:
    // 4 bytes + high bit of 5th byte = 33-bit base
    // Remaining bits = 9-bit extension (not used here)
    const pcrOffset = offset + 6
    const pcr_base =
      this.reader.data[pcrOffset] * 33554432 + // 2^25
      this.reader.data[pcrOffset + 1] * 131072 + // 2^17
      this.reader.data[pcrOffset + 2] * 512 + // 2^9
      this.reader.data[pcrOffset + 3] * 2 + // 2^1
      ((this.reader.data[pcrOffset + 4] & 0x80) >>> 7) // 2^0

    return pcr_base
  }

  /**
   * Verifies TS sync bytes at the start of each packet.
   * Every TS packet must start with 0x47 at PACKET_SIZE intervals.
   *
   * @returns boolean True if valid TS sync pattern found
   */
  private verifyTSSync(): boolean {
    // Check first few packets for sync byte
    for (let i = 0; i < 5; i++) {
      const pos = i * TSParser.PACKET_SIZE
      if (pos >= this.reader.length) break

      const syncByte = this.reader.data[pos]
      if (syncByte !== TSParser.SYNC_BYTE) {
        return false
      }
    }
    return true
  }

  /**
   * Parses audio stream metadata from elementary stream packets.
   * Supports MPEG1/2 Audio and AAC formats.
   *
   * Process:
   * 1. Filter streams to find audio PIDs
   * 2. Extract PES packets for first audio stream
   * 3. Parse audio format specific headers
   * 4. Return audio properties or default values if parsing fails
   *
   * @param streamInfo - Array of elementary streams from PMT
   * @returns Promise<AudioStreamInfo> Audio format, channels, and sample rate
   */
  private async parseAudioStream(
    streamInfo: {
      streamType: number
      elementaryPid: number
    }[]
  ): Promise<{
    hasAudio: boolean
    audioChannels: number
    audioSampleRate: number
    audioCodec: string
  }> {
    try {
      // Parse PMT for audio PIDs
      const audioStreams = streamInfo.filter((stream) => this.isAudioStream(stream.streamType))

      if (audioStreams.length > 0) {
        const audioStream = audioStreams[0] // Use first audio stream
        return parseAudioStream(
          this.reader,
          audioStream.elementaryPid,
          audioStream.streamType as AudioStreamType
        )
      }
    } catch (error) {
      console.debug('Error parsing audio stream:', error)
    }

    return {
      hasAudio: false,
      audioChannels: 0,
      audioSampleRate: 0,
      audioCodec: '',
    }
  }

  /**
   * Parses video stream metadata from elementary stream packets.
   * Supports multiple formats:
   * - MPEG-2: Sequence header parsing
   * - H.264: SPS (Sequence Parameter Set) parsing
   * - HEVC: SPS parsing
   *
   * Process:
   * 1. Find video stream in PMT
   * 2. Extract PES packets
   * 3. For MPEG-2: Search for sequence header (0xB3)
   * 4. For H.264/HEVC: Parse NAL units to find SPS
   * 5. Extract dimensions, frame rate, and color info
   *
   * @param streams - Array of elementary streams from PMT
   * @returns Promise<VideoTrackMetadata> Video format, dimensions, and timing info
   * @throws Error if no video stream found
   */
  private async parseVideoStream(
    streams: { streamType: number; elementaryPid: number }[]
  ): Promise<VideoTrackMetadata> {
    const videoStream = streams.find((stream) => this.isVideoStream(stream.streamType))
    if (!videoStream) {
      throw new Error('No video stream found')
    }

    console.debug('Found video stream:', {
      streamType: `0x${videoStream.streamType.toString(16)}`,
      elementaryPid: `0x${videoStream.elementaryPid.toString(16)}`,
    })

    // Parse video elementary stream for codec specific data
    const videoPackets = findVideoPackets(
      this.reader,
      videoStream.elementaryPid,
      videoStream.streamType
    )

    if (videoStream.streamType === STREAM_TYPES.VIDEO_MPEG2) {
      // For MPEG-2, search for sequence header (0x000001B3)
      // First try first 1KB of first packet for efficiency
      const packet = videoPackets[0]
      if (packet) {
        for (let i = 0; i < Math.min(packet.length - 4, 1024); i++) {
          if (
            packet[i] === 0x00 &&
            packet[i + 1] === 0x00 &&
            packet[i + 2] === 0x01 &&
            packet[i + 3] === 0xb3 // MPEG2 sequence header start code
          ) {
            const metadata = parseMPEG2SequenceHeader(packet.subarray(i))
            return {
              ...metadata,
              codec: streamTypeToCodec(videoStream.streamType),
            }
          }
        }
      }

      // If not found in first 1KB, check up to 32KB
      // This is a reasonable limit as sequence headers are usually near the start
      if (packet && packet.length > 1024) {
        for (let i = 1024; i < Math.min(packet.length - 4, 32768); i++) {
          if (
            packet[i] === 0x00 &&
            packet[i + 1] === 0x00 &&
            packet[i + 2] === 0x01 &&
            packet[i + 3] === 0xb3
          ) {
            const metadata = parseMPEG2SequenceHeader(packet.subarray(i))
            return {
              ...metadata,
              codec: streamTypeToCodec(videoStream.streamType),
            }
          }
        }
      }
    } else {
      // For H.264/HEVC, parse NAL units to find SPS
      const nalUnits = parseNALUnits(videoPackets)
      const sps = findSPS(nalUnits, videoStream.streamType)
      if (sps) {
        const metadata = await parseSPS(sps, videoStream.streamType)
        return {
          ...metadata,
          codec: streamTypeToCodec(videoStream.streamType),
        }
      }
    }

    // Return basic metadata if can't parse headers
    return {
      width: 0,
      height: 0,
      rotation: 0,
      displayAspectWidth: 0,
      displayAspectHeight: 0,
      codec: streamTypeToCodec(videoStream.streamType),
      colorInfo: getDefaultColorInfo(),
    }
  }
}
