import type { VideoTrackMetadata } from '../../ExpoVideoMetadata.types'
import type { BinaryReaderImpl } from '../binary-reader'
import { getDefaultColorInfo } from './color-utils'
import { parseH264SPS } from './h264-parser'
import { parseHEVCSPS } from './hevc-parser'

// Standard TS packet size as defined by ISO/IEC 13818-1
const PACKET_SIZE = 188
// Sync byte that marks the start of each TS packet
const SYNC_BYTE = 0x47

/**
 * Video stream type identifiers in MPEG-TS
 * Values are defined by:
 * - ISO/IEC 13818-1 (MPEG-2 Systems)
 * - ISO/IEC 14496-1 (MPEG-4 Systems)
 * - Various industry extensions (e.g., ATSC, DVB)
 */
export interface StreamTypes {
  VIDEO_MPEG1: number // ISO/IEC 11172-2 Video
  VIDEO_MPEG2: number // ISO/IEC 13818-2 Video
  VIDEO_MPEG4: number // ISO/IEC 14496-2 Visual
  VIDEO_H264: number // ISO/IEC 14496-10 (AVC/H.264)
  VIDEO_HEVC: number // ISO/IEC 23008-2 (HEVC/H.265)
  VIDEO_HEVC_ALT: number // Alternative HEVC type used by some broadcasters
  VIDEO_H265: number // Alias for HEVC
  VIDEO_CAVS: number // Chinese Audio Video Standard
  VIDEO_VC1: number // SMPTE 421M (VC-1)
  VIDEO_DIRAC: number // Dirac Video Codec
  VIDEO_AVS: number // Audio Video Standard
  VIDEO_AVS2: number // Audio Video Standard 2
  VIDEO_AVS3: number // Audio Video Standard 3
  VIDEO_VP8: number // VP8 Video
  VIDEO_VP9: number // VP9 Video
  VIDEO_AV1: number // AV1 Video
}

/**
 * Stream type values as defined in standards and common implementations
 */
export const STREAM_TYPES: StreamTypes = {
  VIDEO_MPEG1: 0x01, // ISO/IEC 11172-2
  VIDEO_MPEG2: 0x02, // ISO/IEC 13818-2
  VIDEO_MPEG4: 0x10, // ISO/IEC 14496-2
  VIDEO_H264: 0x1b, // ISO/IEC 14496-10
  VIDEO_HEVC: 0x24, // ISO/IEC 23008-2
  VIDEO_HEVC_ALT: 0x21, // Alternative HEVC type
  VIDEO_H265: 0x24, // Alias for HEVC
  VIDEO_CAVS: 0x42, // Chinese AVS
  VIDEO_VC1: 0xea, // SMPTE 421M
  VIDEO_DIRAC: 0xd1, // BBC Dirac
  VIDEO_AVS: 0x43, // AVS
  VIDEO_AVS2: 0x44, // AVS2
  VIDEO_AVS3: 0x45, // AVS3
  VIDEO_VP8: 0xa0, // VP8
  VIDEO_VP9: 0xa1, // VP9
  VIDEO_AV1: 0xa2, // AV1
}

/**
 * Finds and extracts video PES packets from transport stream.
 * For efficiency, can stop early if required headers are found.
 *
 * Process:
 * 1. Scan TS packets for specified PID
 * 2. Extract PES packets
 * 3. For MPEG-2: Stop after finding sequence header
 * 4. For H.264/HEVC: Continue to get multiple NAL units
 *
 * @param reader - Binary reader containing transport stream data
 * @param videoPid - PID of video elementary stream
 * @param streamType - Type of video stream (MPEG2, H.264, etc.)
 * @returns Array of PES packet payloads
 */
export function findVideoPackets(
  reader: BinaryReaderImpl,
  videoPid: number,
  streamType?: number
): Uint8Array[] {
  const packets: Uint8Array[] = []
  let offset = 0
  let currentPESLength = 0
  const packetCount = 0
  const maxPacketsToSearch = 1000 // Limit search to avoid processing entire file

  // Pre-allocate a buffer for efficiency
  const maxPESSize = 1024 * 1024 // 1MB max PES size
  const pesBuffer = new Uint8Array(maxPESSize)

  // Track if we've found what we need based on stream type
  let foundRequiredHeader = false
  const isMPEG2 = streamType === STREAM_TYPES.VIDEO_MPEG2
  const isH264 = streamType === STREAM_TYPES.VIDEO_H264
  const isHEVC = streamType === STREAM_TYPES.VIDEO_HEVC

  while (
    offset + PACKET_SIZE <= reader.length &&
    packetCount < maxPacketsToSearch &&
    !foundRequiredHeader
  ) {
    const packetStart = offset
    const syncByte = reader.data[offset]

    // Every TS packet must start with 0x47
    if (syncByte !== SYNC_BYTE) {
      offset += PACKET_SIZE
      continue
    }

    // Extract 13-bit PID from header bytes 1-2
    const pidHigh = reader.data[offset + 1]
    const pidLow = reader.data[offset + 2]
    const packetPid = ((pidHigh & 0x1f) << 8) | pidLow

    if (packetPid !== videoPid) {
      offset += PACKET_SIZE
      continue
    }

    // Parse TS packet header flags (byte 3)
    const flags = reader.data[offset + 3]
    const hasPayload = (flags & 0x10) !== 0 // Payload present
    const adaptationField = (flags & 0x20) !== 0 // Adaptation field present
    const payloadUnitStart = (flags & 0x40) !== 0 // Start of PES packet

    if (!hasPayload) {
      offset += PACKET_SIZE
      continue
    }

    // Calculate payload start position
    let payloadOffset = offset + 4 // Skip TS header
    if (adaptationField) {
      const adaptationLength = reader.data[payloadOffset]
      payloadOffset += adaptationLength > 0 ? adaptationLength + 1 : 1
    }

    if (payloadUnitStart) {
      // Save previous PES packet if we have one
      if (currentPESLength > 0) {
        // Check for required headers based on stream type
        let hasRequiredHeader = false
        for (let i = 0; i < currentPESLength - 4; i++) {
          // Look for start code (0x000001)
          if (pesBuffer[i] === 0x00 && pesBuffer[i + 1] === 0x00 && pesBuffer[i + 2] === 0x01) {
            const nalType = pesBuffer[i + 3]
            if (
              (isMPEG2 && nalType === 0xb3) || // MPEG-2 sequence header
              (isH264 && (nalType & 0x1f) === 7) || // H.264 SPS (NAL type = 7)
              (isHEVC && ((nalType >> 1) & 0x3f) === 33) // HEVC SPS (NAL type = 33)
            ) {
              hasRequiredHeader = true
              foundRequiredHeader = true
              break
            }
          }
        }

        packets.push(pesBuffer.slice(0, currentPESLength))

        // For MPEG-2, we can exit early after finding sequence header
        // For H.264/HEVC, we need more NAL units for complete parsing
        if (hasRequiredHeader && isMPEG2) {
          return packets
        }
      }

      // Reset for new PES packet
      currentPESLength = 0

      // Skip PES header (9 bytes + optional header length)
      const pesHeaderLength = reader.data[payloadOffset + 8]
      payloadOffset += 9 + pesHeaderLength
    }

    // Copy payload to buffer
    const payloadEnd = packetStart + PACKET_SIZE
    const payloadLength = payloadEnd - payloadOffset
    if (payloadLength > 0 && currentPESLength + payloadLength <= maxPESSize) {
      pesBuffer.set(reader.data.subarray(payloadOffset, payloadEnd), currentPESLength)
      currentPESLength += payloadLength
    }

    offset += PACKET_SIZE
  }

  // Add the last PES packet if we have one
  if (currentPESLength > 0) {
    packets.push(pesBuffer.slice(0, currentPESLength))
  }

  return packets
}

/**
 * Parses Network Abstraction Layer (NAL) units from video packets.
 * Supports both H.264 and HEVC NAL unit formats.
 *
 * NAL unit structure:
 * H.264: [Start Code (3-4 bytes)] [NAL Header (1 byte)] [Payload]
 * HEVC:  [Start Code (3-4 bytes)] [NAL Header (2 bytes)] [Payload]
 *
 * Start code patterns:
 * - 0x000001 (3 bytes)
 * - 0x00000001 (4 bytes)
 *
 * @param packets - Array of PES packet payloads
 * @returns Array of NAL units
 */
export function parseNALUnits(packets: Uint8Array[]): Uint8Array[] {
  const nalUnits: Uint8Array[] = []
  let currentNAL: number[] | null = null
  let nalCount = 0

  // Process each packet
  for (const packet of packets) {
    // Look for NAL unit start codes
    for (let i = 0; i < packet.length - 3; i++) {
      // Check for 3-byte (0x000001) or 4-byte (0x00000001) start code
      if (
        packet[i] === 0x00 &&
        packet[i + 1] === 0x00 &&
        packet[i + 2] === 0x01 &&
        (i === 0 || packet[i - 1] === 0x00)
      ) {
        // Save previous NAL unit if we have one
        if (currentNAL !== null && currentNAL.length > 0) {
          nalUnits.push(new Uint8Array(currentNAL))
          nalCount++
        }

        // Start new NAL unit
        currentNAL = []
        // Skip start code
        i += 2 // Will be incremented to 3 by loop
        continue
      }

      // Add byte to current NAL unit if we're collecting one
      if (currentNAL !== null) {
        currentNAL.push(packet[i])
      }
    }

    // Add remaining bytes of packet to current NAL
    if (currentNAL !== null) {
      for (let i = Math.max(0, packet.length - 3); i < packet.length; i++) {
        currentNAL.push(packet[i])
      }
    }
  }

  // Add the last NAL unit if we have one
  if (currentNAL !== null && currentNAL.length > 0) {
    nalUnits.push(new Uint8Array(currentNAL))
    nalCount++
  }

  // Log NAL unit types for debugging
  const nalTypes = nalUnits.map((nal) => {
    // For HEVC, NAL unit type is in upper 6 bits of first byte
    // For H.264, NAL unit type is in lower 5 bits
    const isHEVC = ((nal[0] >> 1) & 0x3f) === 33 // Check if it's an HEVC SPS
    return isHEVC ? (nal[0] >> 1) & 0x3f : nal[0] & 0x1f
  })

  console.debug('NAL parsing complete:', {
    nalCount,
    firstNalType: nalTypes[0],
    nalTypes: nalTypes.join(','),
    hevcNalTypes: nalUnits.map((nal) => (nal[0] >> 1) & 0x3f).join(','),
    avcNalTypes: nalUnits.map((nal) => nal[0] & 0x1f).join(','),
  })

  return nalUnits
}

/**
 * Finds Sequence Parameter Set (SPS) NAL unit in array of NAL units.
 * SPS contains essential video parameters like dimensions and timing.
 *
 * NAL unit types:
 * H.264: SPS = 7 (in lower 5 bits)
 * HEVC:  SPS = 33 (in upper 6 bits)
 *
 * @param nalUnits - Array of NAL units
 * @param streamType - Stream type to determine NAL format
 * @returns SPS NAL unit or null if not found
 */
export function findSPS(nalUnits: Uint8Array[], streamType: number): Uint8Array | null {
  if (streamType === STREAM_TYPES.VIDEO_HEVC) {
    // For HEVC, NAL unit type is in upper 6 bits
    // SPS NAL unit type is 33 (0x21)
    const sps = nalUnits.find((nal) => ((nal[0] >> 1) & 0x3f) === 33)
    console.debug('HEVC SPS search:', {
      found: !!sps,
      length: sps?.length ?? 0,
      firstNalByte: sps ? `0x${sps[0].toString(16)}` : null,
      nalType: sps ? (sps[0] >> 1) & 0x3f : null,
    })
    return sps || null
  }

  // For H.264, NAL unit type is in lower 5 bits
  // SPS NAL unit type is 7
  const sps = nalUnits.find((nal) => (nal[0] & 0x1f) === 7)
  console.debug('H.264 SPS search:', {
    found: !!sps,
    length: sps?.length ?? 0,
    firstNalByte: sps ? `0x${sps[0].toString(16)}` : null,
    nalType: sps ? sps[0] & 0x1f : null,
  })
  return sps || null
}

/**
 * Parses Sequence Parameter Set (SPS) based on stream type.
 * Delegates to format-specific parsers for H.264 and HEVC.
 *
 * @param sps - SPS NAL unit data
 * @param streamType - Stream type to determine parsing method
 * @returns Promise<VideoTrackMetadata> Video format and properties
 */
export async function parseSPS(sps: Uint8Array, streamType: number): Promise<VideoTrackMetadata> {
  try {
    // Delegate to format-specific parsers
    if (streamType === STREAM_TYPES.VIDEO_H264) {
      return parseH264SPS(sps)
    }
    if (streamType === STREAM_TYPES.VIDEO_HEVC) {
      return parseHEVCSPS(sps)
    }
  } catch (error) {
    console.debug('Error parsing SPS:', error)
  }

  // Return default values if parsing fails
  // Default to 1080p resolution as a safe fallback
  return {
    width: 1920,
    height: 1080,
    rotation: 0,
    displayAspectWidth: 1920,
    displayAspectHeight: 1080,
    colorInfo: getDefaultColorInfo(),
    codec: 'unknown',
  }
}

/**
 * Maps stream type to standardized codec string.
 * Codec strings follow common container format conventions.
 *
 * Common mappings:
 * - H.264/AVC  -> 'avc1'
 * - H.265/HEVC -> 'hev1'
 * - MPEG-4     -> 'mp4v'
 * - MPEG-2     -> 'mp2v'
 * - MPEG-1     -> 'mp1v'
 *
 * @param streamType - Stream type from PMT
 * @returns Codec string identifier
 */
export function streamTypeToCodec(streamType: number): string {
  switch (streamType) {
    case STREAM_TYPES.VIDEO_H264:
      return 'avc1' // Advanced Video Coding
    case STREAM_TYPES.VIDEO_HEVC:
      return 'hev1' // High Efficiency Video Coding
    case STREAM_TYPES.VIDEO_MPEG4:
      return 'mp4v' // MPEG-4 Visual
    case STREAM_TYPES.VIDEO_MPEG2:
      return 'mp2v' // MPEG-2 Video
    case STREAM_TYPES.VIDEO_MPEG1:
      return 'mp1v' // MPEG-1 Video
    default:
      return 'unknown'
  }
}
