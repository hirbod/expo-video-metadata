import type { BinaryReaderImpl } from '../../binary-reader'

/**
 * Program Specific Information (PSI) table identifiers.
 * As defined in ISO/IEC 13818-1 section 2.4.4.
 */
export const PSI_TABLES = {
  PAT: 0x00, // Program Association Table
  PMT: 0x02, // Program Map Table
  SDT: 0x11, // Service Description Table
}

/**
 * Program information extracted from PAT.
 * Contains PMT PID for further stream information parsing.
 */
export interface ProgramInfo {
  pmtPid: number | null
}

/**
 * Elementary stream information extracted from PMT.
 * Contains stream type and PID for each elementary stream.
 */
export interface StreamInfo {
  streamType: number
  elementaryPid: number
}

// Standard TS packet size as defined by ISO/IEC 13818-1
const PACKET_SIZE = 188
// Sync byte that marks the start of each TS packet
const SYNC_BYTE = 0x47

/**
 * Parses Program Association Table (PAT) to find PMT PID.
 * PAT structure is defined in ISO/IEC 13818-1 section 2.4.4.3.
 *
 * PAT contains:
 * - Transport stream ID
 * - Version number
 * - Program number to PMT PID mappings
 *
 * @param reader - Binary reader containing TS data
 * @returns ProgramInfo containing PMT PID or null if not found
 */
export function parsePAT(reader: BinaryReaderImpl): ProgramInfo {
  let pmtPid: number | null = null
  const packets = findPSIPackets(reader, PSI_TABLES.PAT)

  console.debug('PAT parsing:', { packetCount: packets.length })

  for (const packet of packets) {
    const tableId = packet[0]
    if (tableId !== PSI_TABLES.PAT) {
      console.debug('Skipping non-PAT packet:', `0x${tableId.toString(16)}`)
      continue
    }

    // Parse PAT header fields
    const sectionLength = ((packet[1] & 0x0f) << 8) | packet[2]
    const transportStreamId = (packet[3] << 8) | packet[4]
    const versionNumber = (packet[5] >> 1) & 0x1f
    const currentNextIndicator = packet[5] & 0x01
    const sectionNumber = packet[6]
    const lastSectionNumber = packet[7]
    const programCount = Math.floor((sectionLength - 9) / 4)

    console.debug('PAT header:', {
      sectionLength,
      transportStreamId,
      versionNumber,
      currentNextIndicator,
      sectionNumber,
      lastSectionNumber,
      programCount,
    })

    // Log all programs for debugging
    const programs: { programNumber: number; pid: number }[] = []
    let validProgramFound = false

    // Parse program entries
    for (let i = 0; i < programCount; i++) {
      const offset = 8 + i * 4
      if (offset + 4 > packet.length) {
        console.debug('PAT packet too short for program entry')
        break
      }

      const programNumber = (packet[offset] << 8) | packet[offset + 1]
      const pid = ((packet[offset + 2] & 0x1f) << 8) | packet[offset + 3]
      programs.push({ programNumber, pid })

      // Skip network_PID (program_number == 0) and invalid PIDs (0x1FFF)
      if (programNumber !== 0 && pid !== 0x1fff) {
        // Prefer program number 1, but take any valid program if 1 isn't found
        if (!validProgramFound || programNumber === 1) {
          pmtPid = pid
          validProgramFound = true
          console.debug('Found PMT PID:', {
            programNumber,
            pid: `0x${pid.toString(16)}`,
            preferred: programNumber === 1,
          })
          if (programNumber === 1) {
            break // Found ideal program, no need to continue
          }
        }
      }
    }

    console.debug(
      'All programs:',
      programs.map((p) => ({
        programNumber: p.programNumber,
        pid: `0x${p.pid.toString(16)}`,
        isNetworkPID: p.programNumber === 0,
        isInvalidPID: p.pid === 0x1fff,
      }))
    )

    if (validProgramFound) {
      break
    }
  }

  if (pmtPid === null) {
    console.debug('No valid PMT PID found in PAT')
  }

  return { pmtPid }
}

/**
 * Parses Program Map Table (PMT) to find stream information.
 * PMT structure is defined in ISO/IEC 13818-1 section 2.4.4.8.
 *
 * PMT contains:
 * - Program number
 * - PCR PID
 * - Stream type and PID for each elementary stream
 *
 * @param reader - Binary reader containing TS data
 * @param pmtPid - PID of the PMT to parse
 * @returns Array of StreamInfo for each elementary stream
 */
export function parsePMT(reader: BinaryReaderImpl, pmtPid: number): StreamInfo[] {
  const streams: StreamInfo[] = []
  const pmtPackets = findPSIPackets(reader, PSI_TABLES.PMT, pmtPid)

  console.debug('PMT packets found:', pmtPackets.length)

  if (pmtPackets.length === 0) {
    // If we can't find PMT packets, check for typical PIDs
    console.debug('No PMT packets found, checking for typical PIDs')

    // Get PID statistics to find most common PIDs
    const pidStats = new Map<number, number>()
    let offset = 0
    while (offset + PACKET_SIZE <= reader.length) {
      const pid = ((reader.data[offset + 1] & 0x1f) << 8) | reader.data[offset + 2]
      pidStats.set(pid, (pidStats.get(pid) || 0) + 1)
      offset += PACKET_SIZE
    }

    // Sort PIDs by frequency
    const sortedPids = Array.from(pidStats.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([pid]) => pid)

    console.debug(
      'Found PIDs:',
      sortedPids.map((pid) => ({
        pid: `0x${pid.toString(16)}`,
        count: pidStats.get(pid),
      }))
    )

    // Check for typical video PIDs (0x100-0x1FF)
    const typicalVideoPids = sortedPids.filter((pid) => pid >= 0x100 && pid <= 0x1ff)
    // Check for typical audio PIDs (usually right after video PIDs)
    const typicalAudioPids = sortedPids.filter((pid) => pid >= 0x200 && pid <= 0x2ff)

    console.debug('Typical PIDs found:', {
      video: typicalVideoPids.map((pid) => ({
        pid: `0x${pid.toString(16)}`,
        count: pidStats.get(pid),
      })),
      audio: typicalAudioPids.map((pid) => ({
        pid: `0x${pid.toString(16)}`,
        count: pidStats.get(pid),
      })),
    })

    // Add video streams first
    for (const pid of typicalVideoPids) {
      // Check first few packets of this PID to detect stream type
      const streamType = detectStreamType(reader, pid)
      if (streamType) {
        console.debug('Adding video stream:', {
          pid: `0x${pid.toString(16)}`,
          type: `0x${streamType.toString(16)}`,
        })
        streams.push({ streamType, elementaryPid: pid })
      }
    }

    // Then add audio streams
    for (const pid of typicalAudioPids) {
      const streamType = detectStreamType(reader, pid)
      if (streamType) {
        console.debug('Adding audio stream:', {
          pid: `0x${pid.toString(16)}`,
          type: `0x${streamType.toString(16)}`,
        })
        streams.push({ streamType, elementaryPid: pid })
      }
    }

    // If we found any streams, return them
    if (streams.length > 0) {
      console.debug('Found streams using typical PIDs:', streams.length)
      return streams
    }

    // Last resort: try common PIDs if we haven't found any streams
    const commonPids = [0x100, 0x101, 0x102, 0x103, 0x1011]
    for (const pid of commonPids) {
      if (pidStats.has(pid)) {
        const streamType = detectStreamType(reader, pid)
        if (streamType) {
          console.debug('Adding stream from common PID:', {
            pid: `0x${pid.toString(16)}`,
            type: `0x${streamType.toString(16)}`,
          })
          streams.push({ streamType, elementaryPid: pid })
        }
      }
    }
    return streams
  }

  // Normal PMT parsing
  for (const packet of pmtPackets) {
    const tableId = packet[0]
    if (tableId === PSI_TABLES.PMT || tableId === 0x02) {
      // Parse PMT header fields
      const sectionLength = ((packet[1] & 0x0f) << 8) | packet[2]
      const programNumber = (packet[3] << 8) | packet[4]
      const versionNumber = (packet[5] >> 1) & 0x1f
      const currentNextIndicator = packet[5] & 0x01
      const sectionNumber = packet[6]
      const lastSectionNumber = packet[7]
      const pcrPid = ((packet[8] & 0x1f) << 8) | packet[9]
      const programInfoLength = ((packet[10] & 0x0f) << 8) | packet[11]

      console.debug('PMT header:', {
        sectionLength,
        programNumber,
        versionNumber,
        currentNextIndicator,
        sectionNumber,
        lastSectionNumber,
        pcrPid: `0x${pcrPid.toString(16)}`,
        programInfoLength,
      })

      // Skip program info descriptors
      let pos = 12 + programInfoLength

      // Process stream entries until we reach the end of the section
      const sectionEnd = 3 + sectionLength - 4 // -4 for CRC at end
      while (pos < sectionEnd && pos < packet.length - 4) {
        const streamType = packet[pos]
        const elementaryPid = ((packet[pos + 1] & 0x1f) << 8) | packet[pos + 2]
        const esInfoLength = ((packet[pos + 3] & 0x0f) << 8) | packet[pos + 4]

        console.debug('Found stream in PMT:', {
          streamType: `0x${streamType.toString(16)}`,
          elementaryPid: `0x${elementaryPid.toString(16)}`,
          esInfoLength,
        })

        streams.push({ streamType, elementaryPid })

        pos += 5 + esInfoLength
      }
    }
  }

  return streams
}

/**
 * Detects stream type by analyzing PES packet contents.
 * Looks for stream-specific markers:
 * - MPEG-2: Sequence header (0xB3)
 * - H.264: SPS NAL unit (type 7)
 * - HEVC: VPS NAL unit (type 32)
 * - MPEG Audio: Sync word (0xFFF...)
 * - AAC: ADTS sync word
 *
 * @param reader - Binary reader containing TS data
 * @param pid - PID to analyze
 * @returns Stream type value or null if not detected
 */
function detectStreamType(reader: BinaryReaderImpl, pid: number): number | null {
  console.debug('Detecting stream type for PID:', `0x${pid.toString(16)}`)
  // Look at first few packets to try to detect stream type
  let offset = 0
  const maxPackets = 100
  let packetCount = 0

  while (offset + PACKET_SIZE <= reader.length && packetCount < maxPackets) {
    const packetPid = ((reader.data[offset + 1] & 0x1f) << 8) | reader.data[offset + 2]
    if (packetPid === pid) {
      const flags = reader.data[offset + 3]
      const hasPayload = (flags & 0x10) !== 0
      const adaptationField = (flags & 0x20) !== 0
      const payloadStart = offset + 4 + (adaptationField ? reader.data[offset + 4] + 1 : 0)

      // Check for PES header
      const payload = reader.data.slice(payloadStart)
      if (payload.length > 9 && payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
        const streamId = payload[3]
        console.debug('Found PES packet:', {
          pid: `0x${pid.toString(16)}`,
          streamId: `0x${streamId.toString(16)}`,
          payloadLength: payload.length,
        })

        // Check for audio stream IDs first
        if (streamId >= 0xc0 && streamId <= 0xdf) {
          // Look for audio sync words
          for (let i = 0; i < payload.length - 4; i++) {
            // MPEG audio sync (0xFFF...)
            if (payload[i] === 0xff && (payload[i + 1] & 0xe0) === 0xe0) {
              // Check for MPEG Audio Layer 2
              // Bits 13-14 (layer): 10 = Layer 2
              const layer = (payload[i + 1] & 0x06) >> 1
              if (layer === 2) {
                console.debug('Found MPEG Audio Layer 2 sync word')
                return 0x04 // AUDIO_MPEG2
              }
              // Check for AAC ADTS pattern
              // In AAC, after sync word:
              // - Layer = 0 at bits 13-14
              const isADTS = (payload[i + 1] & 0x06) === 0x00
              if (isADTS) {
                console.debug('Found AAC ADTS sync word')
                return 0x0f // AAC
              }
              console.debug('Found MPEG audio sync word')
              return 0x04 // AUDIO_MPEG2
            }
          }
          // If we found an audio stream ID but no sync word yet,
          // default to MPEG Audio as it's more common in MPEG-TS
          console.debug('Found audio stream ID, assuming MPEG Audio')
          return 0x04 // AUDIO_MPEG2
        }

        // Only check for video headers if it's a video stream ID
        if (streamId >= 0xe0 && streamId <= 0xef) {
          // Look for sequence header start code (0x000001B3) for MPEG-2
          // or NAL units for H.264/HEVC
          for (let i = 0; i < payload.length - 4; i++) {
            if (payload[i] === 0 && payload[i + 1] === 0 && payload[i + 2] === 1) {
              const nalType = payload[i + 3]
              console.debug('Found start code:', {
                pid: `0x${pid.toString(16)}`,
                nalType: `0x${nalType.toString(16)}`,
                offset: i,
              })

              // For HEVC, NAL unit header is 2 bytes
              // First byte: forbidden_zero_bit (1) + nal_unit_type (6) + nuh_layer_id (6)
              // Second byte: nuh_temporal_id_plus1 (3) + reserved_zero_5bits (5)
              if ((nalType & 0x7e) === 0x40) {
                // VPS NAL unit type (32) in upper 6 bits
                console.debug('Found HEVC VPS NAL unit')
                return 0x24 // VIDEO_HEVC
              }

              // For H.264, NAL unit type is in lower 5 bits
              if ((nalType & 0x1f) === 7) {
                // SPS NAL unit
                console.debug('Found H.264 SPS NAL unit')
                return 0x1b // VIDEO_H264
              }

              // For MPEG-2, look for sequence header
              if (nalType === 0xb3) {
                console.debug('Found MPEG-2 sequence header')
                return 0x02 // VIDEO_MPEG2
              }
            }
          }
          // If we found a video stream ID but no specific headers yet,
          // check more packets
          console.debug('Found video stream ID, continuing search')
          packetCount++
          offset += PACKET_SIZE
          continue
        }
      }
    }
    offset += PACKET_SIZE
  }

  console.debug('No stream type detected for PID:', `0x${pid.toString(16)}`)
  return null
}

/**
 * Finds PSI packets in the transport stream.
 * PSI packets are identified by:
 * - Sync byte (0x47)
 * - Payload unit start indicator
 * - Specific PID (0 for PAT, PMT PID for PMT)
 * - Payload containing table ID
 *
 * @param reader - Binary reader containing TS data
 * @param tableId - PSI table ID to find
 * @param pid - Optional PID to match (required for PMT)
 * @returns Array of PSI section payloads
 */
function findPSIPackets(reader: BinaryReaderImpl, tableId: number, pid?: number): Uint8Array[] {
  const packets: Uint8Array[] = []
  let offset = 0
  let currentSection: number[] = []
  let lastContinuityCounter = -1
  const pidStats = new Map<number, number>()

  while (offset + PACKET_SIZE <= reader.length) {
    const packetStart = offset
    const syncByte = reader.data[offset++]

    // Check for sync byte and handle sync loss
    if (syncByte !== SYNC_BYTE) {
      while (offset < reader.length && reader.data[offset] !== SYNC_BYTE) {
        offset++
      }
      continue
    }

    // Extract PID from packet header
    const pidHigh = reader.data[offset++]
    const pidLow = reader.data[offset++]
    const packetPid = ((pidHigh & 0x1f) << 8) | pidLow

    pidStats.set(packetPid, (pidStats.get(packetPid) || 0) + 1)

    // Skip packets with wrong PID
    if (
      (tableId === PSI_TABLES.PAT && packetPid !== 0x0000) ||
      (pid !== undefined && packetPid !== pid)
    ) {
      offset = packetStart + PACKET_SIZE
      continue
    }

    // Parse transport stream packet header
    const flags = reader.data[offset++]
    const hasPayload = (flags & 0x10) !== 0
    const adaptationField = (flags & 0x20) !== 0
    const payloadUnitStart = (flags & 0x40) !== 0
    const continuityCounter = flags & 0x0f

    // Check continuity counter for packet loss
    if (lastContinuityCounter !== -1) {
      const expectedCounter = (lastContinuityCounter + 1) & 0x0f
      if (continuityCounter !== expectedCounter) {
        if (currentSection.length > 0) {
          currentSection = []
        }
      }
    }
    lastContinuityCounter = continuityCounter

    // Skip packets without payload
    if (!hasPayload) {
      offset = packetStart + PACKET_SIZE
      continue
    }

    // Handle adaptation field if present
    let adaptationLength = 0
    if (adaptationField) {
      adaptationLength = reader.data[offset++]
      if (adaptationLength > 0) {
        adaptationLength++
      }
    }

    // Calculate payload position and length
    const payloadStart = offset + adaptationLength
    const payloadLength = PACKET_SIZE - (payloadStart - packetStart)

    if (payloadLength <= 0) {
      offset = packetStart + PACKET_SIZE
      continue
    }

    // Extract payload
    let payload = reader.data.slice(payloadStart, payloadStart + payloadLength)

    // Handle payload unit start indicator
    if (payloadUnitStart) {
      if (currentSection.length > 0) {
        if (currentSection.length >= 3) {
          const sectionLength = ((currentSection[1] & 0x0f) << 8) | currentSection[2]
          if (currentSection.length === sectionLength + 3) {
            packets.push(new Uint8Array(currentSection))
          }
        }
        currentSection = []
      }

      // Skip pointer field
      const pointerField = payload[0]
      if (pointerField >= payload.length) {
        offset = packetStart + PACKET_SIZE
        continue
      }
      payload = payload.slice(1 + pointerField)
    }

    // Accumulate payload into current section
    currentSection.push(...Array.from(payload))

    // Check if section is complete
    if (currentSection.length >= 3) {
      const sectionLength = ((currentSection[1] & 0x0f) << 8) | currentSection[2]
      if (sectionLength > 1021) {
        currentSection = []
      } else if (currentSection.length >= sectionLength + 3) {
        if (
          tableId === PSI_TABLES.PAT ||
          tableId === PSI_TABLES.PMT ||
          currentSection[0] === tableId ||
          currentSection[0] === 0x02
        ) {
          packets.push(new Uint8Array(currentSection.slice(0, sectionLength + 3)))
        }
        currentSection = []
      }
    }

    offset = packetStart + PACKET_SIZE
  }

  // Handle any remaining complete section
  if (currentSection.length >= 3) {
    const sectionLength = ((currentSection[1] & 0x0f) << 8) | currentSection[2]
    if (
      sectionLength <= 1021 &&
      currentSection.length === sectionLength + 3 &&
      (tableId === PSI_TABLES.PAT ||
        tableId === PSI_TABLES.PMT ||
        currentSection[0] === tableId ||
        currentSection[0] === 0x02)
    ) {
      packets.push(new Uint8Array(currentSection))
    }
  }

  return packets
}
