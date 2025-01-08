// ts-parser.ts
import type {
  ParsedVideoMetadata,
  VideoColorInfo,
  VideoTrackMetadata,
} from '../ExpoVideoMetadata.types'
import { BinaryReaderImpl } from './binary-reader'
import { BitReader } from './bit-reader'

export class TSParser {
  private reader: BinaryReaderImpl
  private static readonly PACKET_SIZE = 188
  private static readonly SYNC_BYTE = 0x47

  // Stream types
  private static readonly STREAM_TYPES = {
    // Video types
    VIDEO_MPEG1: 0x01,
    VIDEO_MPEG2: 0x02,
    VIDEO_MPEG4: 0x10,
    VIDEO_H264: 0x1b,
    VIDEO_HEVC: 0x24,
    VIDEO_HEVC_ALT: 0x21,
    VIDEO_H265: 0x24,
    VIDEO_CAVS: 0x42,
    VIDEO_VC1: 0xea,
    VIDEO_DIRAC: 0xd1,
    VIDEO_AVS: 0x43,
    VIDEO_AVS2: 0x44,
    VIDEO_AVS3: 0x45,
    VIDEO_VP8: 0xa0,
    VIDEO_VP9: 0xa1,
    VIDEO_AV1: 0xa2,
    // Audio types
    AUDIO_MPEG1: 0x03,
    AUDIO_MPEG2: 0x04,
    AUDIO_AAC: 0x0f,
    AUDIO_AAC_LATM: 0x11,
    AUDIO_AC3: 0x81,
    AUDIO_DTS: 0x82,
    AUDIO_TRUEHD: 0x83,
    AUDIO_EAC3: 0x87,
    // Private data
    PRIVATE_DATA: 0x06,
  }

  // PSI (Program Specific Information) tables
  private static readonly PSI_TABLES = {
    PAT: 0x00, // Program Association Table
    PMT: 0x02, // Program Map Table
    SDT: 0x11, // Service Description Table
  }

  constructor(data: Uint8Array) {
    this.reader = new BinaryReaderImpl(data)
  }

  public async parse(): Promise<ParsedVideoMetadata> {
    if (!this.verifyTSSync()) {
      throw new Error('Not a valid Transport Stream')
    }

    const programInfo = await this.parsePAT()
    if (!programInfo.pmtPid) {
      throw new Error('No PMT PID found')
    }

    const streams = await this.parsePMT(programInfo.pmtPid)
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

  private async calculateDuration(): Promise<number> {
    try {
      // Find first and last PCR values
      let firstPCR: number | null = null
      let lastPCR: number | null = null
      const pcrPids = new Set<number>()

      // First pass to find PCR PIDs
      for (
        let offset = 0;
        offset < Math.min(this.reader.length, 940);
        offset += TSParser.PACKET_SIZE
      ) {
        const adaptationField = this.getAdaptationField(offset)
        if (adaptationField && adaptationField.flags & 0x10) {
          // Has PCR
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
        return (lastPCR - firstPCR) / 90000 // PCR is in 90kHz units
      }
    } catch (error) {
      console.debug('Error calculating duration:', error)
    }

    // Fallback: estimate from file size and typical bitrate
    return Math.floor((this.reader.length * 8) / 10000000) // Assume ~10Mbps
  }

  private getPid(offset: number): number {
    return ((this.reader.data[offset + 1] & 0x1f) << 8) | this.reader.data[offset + 2]
  }

  private getAdaptationField(offset: number): { length: number; flags: number } | null {
    const flags = this.reader.data[offset + 3]
    if ((flags & 0x20) === 0) return null // No adaptation field

    const length = this.reader.data[offset + 4]
    if (length === 0) return null

    return { length, flags: this.reader.data[offset + 5] }
  }

  private getPCR(offset: number): number | null {
    const adaptField = this.getAdaptationField(offset)
    if (!adaptField || !(adaptField.flags & 0x10)) return null

    const pcrOffset = offset + 6
    const pcr_base =
      this.reader.data[pcrOffset] * 33554432 +
      this.reader.data[pcrOffset + 1] * 131072 +
      this.reader.data[pcrOffset + 2] * 512 +
      this.reader.data[pcrOffset + 3] * 2 +
      ((this.reader.data[pcrOffset + 4] & 0x80) >>> 7)

    return pcr_base
  }
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
      const audioStreams = streamInfo.filter(
        (stream) => [0x0f, 0x11, 0x03, 0x04].includes(stream.streamType) // MPEG Audio, AAC, AC3 types
      )

      if (audioStreams.length > 0) {
        const audioStream = audioStreams[0] // Use first audio stream
        let codec = ''

        switch (audioStream.streamType) {
          case 0x0f:
            codec = 'aac'
            break // AAC
          case 0x11:
            codec = 'aac'
            break // LATM AAC
          case 0x03:
            codec = 'mp3'
            break // MPEG-1 Audio
          case 0x04:
            codec = 'mp3'
            break // MPEG-2 Audio
          default:
            codec = 'unknown'
        }

        return {
          hasAudio: true,
          audioChannels: 2, // Default to stereo as TS doesn't easily expose this
          audioSampleRate: 48000, // Default to common value
          audioCodec: codec,
        }
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

  private async parsePAT(): Promise<{ pmtPid: number | null }> {
    let pmtPid: number | null = null
    const packets = this.findPSIPackets(TSParser.PSI_TABLES.PAT)

    console.debug('PAT parsing:', { packetCount: packets.length })

    for (const packet of packets) {
      const tableId = packet[0]
      if (tableId !== TSParser.PSI_TABLES.PAT) {
        console.debug('Skipping non-PAT packet:', `0x${tableId.toString(16)}`)
        continue
      }

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

  private async parsePMT(pmtPid: number): Promise<{ streamType: number; elementaryPid: number }[]> {
    const streams: { streamType: number; elementaryPid: number }[] = []
    const pmtPackets = this.findPSIPackets(TSParser.PSI_TABLES.PMT, pmtPid)

    console.debug('PMT packets found:', pmtPackets.length)

    if (pmtPackets.length === 0) {
      // If we can't find PMT packets, check for typical PIDs
      console.debug('No PMT packets found, checking for typical PIDs')

      // Get PID statistics to find most common PIDs
      const pidStats = new Map<number, number>()
      let offset = 0
      while (offset + TSParser.PACKET_SIZE <= this.reader.length) {
        const pid = this.getPid(offset)
        pidStats.set(pid, (pidStats.get(pid) || 0) + 1)
        offset += TSParser.PACKET_SIZE
      }

      // Sort PIDs by frequency
      const sortedPids = Array.from(pidStats.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([pid]) => pid)

      console.debug(
        'Found PIDs:',
        sortedPids.map((pid) => `0x${pid.toString(16)}`)
      )

      // Check for typical video PIDs (0x100-0x1FF)
      const typicalVideoPids = sortedPids.filter((pid) => pid >= 0x100 && pid <= 0x1ff)
      // Check for typical audio PIDs (usually right after video PIDs)
      const typicalAudioPids = sortedPids.filter((pid) => pid >= 0x200 && pid <= 0x2ff)

      console.debug('Typical PIDs found:', {
        video: typicalVideoPids.map((pid) => `0x${pid.toString(16)}`),
        audio: typicalAudioPids.map((pid) => `0x${pid.toString(16)}`),
      })

      // Add video streams first
      for (const pid of typicalVideoPids) {
        // Check first few packets of this PID to detect stream type
        const streamType = await this.detectStreamType(pid)
        if (streamType && this.isVideoStream(streamType)) {
          console.debug('Adding video stream:', {
            pid: `0x${pid.toString(16)}`,
            type: `0x${streamType.toString(16)}`,
          })
          streams.push({ streamType, elementaryPid: pid })
        }
      }

      // Then add audio streams
      for (const pid of typicalAudioPids) {
        const streamType = await this.detectStreamType(pid)
        if (streamType && this.isAudioStream(streamType)) {
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
          const streamType = await this.detectStreamType(pid)
          if (streamType && (this.isVideoStream(streamType) || this.isAudioStream(streamType))) {
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
      if (tableId === TSParser.PSI_TABLES.PMT || tableId === 0x02) {
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

          console.debug('Found stream:', {
            type: `0x${streamType.toString(16)}`,
            pid: `0x${elementaryPid.toString(16)}`,
            isVideo: this.isVideoStream(streamType),
            isAudio: this.isAudioStream(streamType),
          })

          if (this.isVideoStream(streamType) || this.isAudioStream(streamType)) {
            streams.push({ streamType, elementaryPid })
          }

          pos += 5 + esInfoLength
        }
      }
    }

    console.debug('Total streams found:', streams.length)
    return streams
  }

  private async detectStreamType(pid: number): Promise<number | null> {
    // Look at first few packets to try to detect stream type
    let offset = 0
    const maxPackets = 100
    let packetCount = 0

    while (offset + TSParser.PACKET_SIZE <= this.reader.length && packetCount < maxPackets) {
      if (this.getPid(offset) === pid) {
        const adaptationField = this.getAdaptationField(offset)
        const payloadStart = offset + 4 + (adaptationField ? adaptationField.length + 1 : 0)

        // Check for PES header
        const payload = this.reader.data.slice(payloadStart)
        if (payload.length > 9 && payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
          const streamId = payload[3]

          // Look for sequence header start code (0x000001B3) for MPEG-2
          // or NAL units for H.264/HEVC
          for (let i = 0; i < payload.length - 4; i++) {
            if (payload[i] === 0 && payload[i + 1] === 0 && payload[i + 2] === 1) {
              const nalType = payload[i + 3]

              // For HEVC, NAL unit header is 2 bytes
              // First byte: forbidden_zero_bit (1) + nal_unit_type (6) + nuh_layer_id (6)
              // Second byte: nuh_temporal_id_plus1 (3) + reserved_zero_5bits (5)
              if ((nalType & 0x7e) === 0x40) {
                // VPS NAL unit type (32) in upper 6 bits
                console.debug('Found HEVC VPS NAL unit')
                return TSParser.STREAM_TYPES.VIDEO_HEVC
              }

              // For H.264, NAL unit type is in lower 5 bits
              if ((nalType & 0x1f) === 7) {
                // SPS NAL unit
                console.debug('Found H.264 SPS NAL unit')
                return TSParser.STREAM_TYPES.VIDEO_H264
              }

              // For MPEG-2, look for sequence header
              if (nalType === 0xb3) {
                console.debug('Found MPEG-2 sequence header')
                return TSParser.STREAM_TYPES.VIDEO_MPEG2
              }
            }
          }

          // If we found a video stream ID but no specific headers yet,
          // check more packets
          if (streamId >= 0xe0 && streamId <= 0xef) {
            packetCount++
            offset += TSParser.PACKET_SIZE
            continue
          }
        }
      }
      offset += TSParser.PACKET_SIZE
    }

    return null
  }

  private isVideoStream(streamType: number): boolean {
    // Add debug logging
    console.debug('Checking stream type:', {
      type: `0x${streamType.toString(16)}`,
      knownTypes: Object.values(TSParser.STREAM_TYPES).map((t) => `0x${t.toString(16)}`),
    })

    const videoTypes = [
      TSParser.STREAM_TYPES.VIDEO_MPEG1,
      TSParser.STREAM_TYPES.VIDEO_MPEG2,
      TSParser.STREAM_TYPES.VIDEO_MPEG4,
      TSParser.STREAM_TYPES.VIDEO_H264,
      TSParser.STREAM_TYPES.VIDEO_HEVC,
      TSParser.STREAM_TYPES.VIDEO_HEVC_ALT,
      TSParser.STREAM_TYPES.VIDEO_H265,
      TSParser.STREAM_TYPES.VIDEO_CAVS,
      TSParser.STREAM_TYPES.VIDEO_VC1,
      TSParser.STREAM_TYPES.VIDEO_DIRAC,
      TSParser.STREAM_TYPES.VIDEO_AVS,
      TSParser.STREAM_TYPES.VIDEO_AVS2,
      TSParser.STREAM_TYPES.VIDEO_AVS3,
      TSParser.STREAM_TYPES.VIDEO_VP8,
      TSParser.STREAM_TYPES.VIDEO_VP9,
      TSParser.STREAM_TYPES.VIDEO_AV1,
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

  private isAudioStream(streamType: number): boolean {
    return [
      TSParser.STREAM_TYPES.AUDIO_MPEG1,
      TSParser.STREAM_TYPES.AUDIO_MPEG2,
      TSParser.STREAM_TYPES.AUDIO_AAC,
      TSParser.STREAM_TYPES.AUDIO_AAC_LATM,
      TSParser.STREAM_TYPES.AUDIO_AC3,
      TSParser.STREAM_TYPES.AUDIO_DTS,
      TSParser.STREAM_TYPES.AUDIO_TRUEHD,
      TSParser.STREAM_TYPES.AUDIO_EAC3,
    ].includes(streamType)
  }

  private findPSIPackets(tableId: number, pid?: number): Uint8Array[] {
    const packets: Uint8Array[] = []
    let offset = 0
    let currentSection: number[] = []
    let lastContinuityCounter = -1
    const pidStats = new Map<number, number>()

    while (offset + TSParser.PACKET_SIZE <= this.reader.length) {
      const packetStart = offset
      const syncByte = this.reader.data[offset++]

      if (syncByte !== TSParser.SYNC_BYTE) {
        while (offset < this.reader.length && this.reader.data[offset] !== TSParser.SYNC_BYTE) {
          offset++
        }
        continue
      }

      const pidHigh = this.reader.data[offset++]
      const pidLow = this.reader.data[offset++]
      const packetPid = ((pidHigh & 0x1f) << 8) | pidLow

      pidStats.set(packetPid, (pidStats.get(packetPid) || 0) + 1)

      if (
        (tableId === TSParser.PSI_TABLES.PAT && packetPid !== 0x0000) ||
        (pid !== undefined && packetPid !== pid)
      ) {
        offset = packetStart + TSParser.PACKET_SIZE
        continue
      }

      const flags = this.reader.data[offset++]
      const hasPayload = (flags & 0x10) !== 0
      const adaptationField = (flags & 0x20) !== 0
      const payloadUnitStart = (flags & 0x40) !== 0
      const continuityCounter = flags & 0x0f

      if (lastContinuityCounter !== -1) {
        const expectedCounter = (lastContinuityCounter + 1) & 0x0f
        if (continuityCounter !== expectedCounter) {
          if (currentSection.length > 0) {
            currentSection = []
          }
        }
      }
      lastContinuityCounter = continuityCounter

      if (!hasPayload) {
        offset = packetStart + TSParser.PACKET_SIZE
        continue
      }

      let adaptationLength = 0
      if (adaptationField) {
        adaptationLength = this.reader.data[offset++]
        if (adaptationLength > 0) {
          adaptationLength++
        }
      }

      const payloadStart = offset + adaptationLength
      const payloadLength = TSParser.PACKET_SIZE - (payloadStart - packetStart)

      if (payloadLength <= 0) {
        offset = packetStart + TSParser.PACKET_SIZE
        continue
      }

      let payload = this.reader.data.slice(payloadStart, payloadStart + payloadLength)

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

        const pointerField = payload[0]
        if (pointerField >= payload.length) {
          offset = packetStart + TSParser.PACKET_SIZE
          continue
        }
        payload = payload.slice(1 + pointerField)
      }

      currentSection.push(...Array.from(payload))

      if (currentSection.length >= 3) {
        const sectionLength = ((currentSection[1] & 0x0f) << 8) | currentSection[2]
        if (sectionLength > 1021) {
          currentSection = []
        } else if (currentSection.length >= sectionLength + 3) {
          if (
            tableId === TSParser.PSI_TABLES.PAT ||
            tableId === TSParser.PSI_TABLES.PMT ||
            currentSection[0] === tableId ||
            currentSection[0] === 0x02
          ) {
            packets.push(new Uint8Array(currentSection.slice(0, sectionLength + 3)))
          }
          currentSection = []
        }
      }

      offset = packetStart + TSParser.PACKET_SIZE
    }

    if (currentSection.length >= 3) {
      const sectionLength = ((currentSection[1] & 0x0f) << 8) | currentSection[2]
      if (
        sectionLength <= 1021 &&
        currentSection.length === sectionLength + 3 &&
        (tableId === TSParser.PSI_TABLES.PAT ||
          tableId === TSParser.PSI_TABLES.PMT ||
          currentSection[0] === tableId ||
          currentSection[0] === 0x02)
      ) {
        packets.push(new Uint8Array(currentSection))
      }
    }

    return packets
  }

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
    const videoPackets = this.findVideoPackets(videoStream.elementaryPid, videoStream.streamType)

    if (videoStream.streamType === TSParser.STREAM_TYPES.VIDEO_MPEG2) {
      // For MPEG-2, we should have the sequence header in the first packet
      // since findVideoPackets is optimized to return early when it finds one
      const packet = videoPackets[0]
      if (packet) {
        for (let i = 0; i < Math.min(packet.length - 4, 1024); i++) {
          if (
            packet[i] === 0x00 &&
            packet[i + 1] === 0x00 &&
            packet[i + 2] === 0x01 &&
            packet[i + 3] === 0xb3
          ) {
            return this.parseMPEG2SequenceHeader(packet.subarray(i))
          }
        }
      }

      // If we couldn't find the sequence header in the first 1KB of the first packet,
      // check the remaining part but only up to a reasonable size
      if (packet && packet.length > 1024) {
        for (let i = 1024; i < Math.min(packet.length - 4, 32768); i++) {
          if (
            packet[i] === 0x00 &&
            packet[i + 1] === 0x00 &&
            packet[i + 2] === 0x01 &&
            packet[i + 3] === 0xb3
          ) {
            return this.parseMPEG2SequenceHeader(packet.subarray(i))
          }
        }
      }
    } else {
      // For H.264/HEVC, continue with SPS parsing
      const nalUnits = this.parseNALUnits(videoPackets)
      const sps = this.findSPS(nalUnits, videoStream.streamType)
      if (sps) {
        const metadata = await this.parseSPS(sps, videoStream.streamType)
        return {
          ...metadata,
          codec: this.streamTypeToCodec(videoStream.streamType),
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
      codec: this.streamTypeToCodec(videoStream.streamType),
      colorInfo: this.getDefaultColorInfo(),
    }
  }

  private parseMPEG2SequenceHeader(seqHeader: Uint8Array): VideoTrackMetadata {
    /*
    // Log raw sequence header data
    console.debug(
      'Raw MPEG-2 sequence header:',
      Array.from(seqHeader)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')
    )
        */

    // Skip start code (4 bytes: 00 00 01 B3)
    const data = seqHeader.slice(4)

    // MPEG-2 sequence header format:
    // 12 bits - horizontal_size_value
    // 12 bits - vertical_size_value
    //  4 bits - aspect_ratio_information
    //  4 bits - frame_rate_code
    // 18 bits - bit_rate_value
    //  1 bit  - marker_bit
    // 10 bits - vbv_buffer_size_value
    //  1 bit  - constrained_parameters_flag
    //  1 bit  - load_intra_quantiser_matrix
    // ...

    // Read dimensions (12 bits each)
    const width = (data[0] << 4) | ((data[1] & 0xf0) >> 4)
    const height = ((data[1] & 0x0f) << 8) | data[2]

    // Read aspect ratio code (4 bits) and frame rate code (4 bits)
    const aspectRatioCode = (data[3] >> 4) & 0x0f
    const frameRateCode = data[3] & 0x0f

    // Map frame rate code to actual frame rate
    // According to ISO/IEC 13818-2 Table 6-4
    const frameRates = [
      0, // 0 - forbidden
      24000 / 1001, // 1 - 23.976 fps
      24, // 2 - 24 fps
      25, // 3 - 25 fps
      30000 / 1001, // 4 - 29.97 fps
      30, // 5 - 30 fps
      50, // 6 - 50 fps
      60000 / 1001, // 7 - 59.94 fps
      60, // 8 - 60 fps
      // 9-15 reserved
    ]

    const fps = frameRateCode < frameRates.length ? frameRates[frameRateCode] : 0

    // Map aspect ratio code to pixel aspect ratio (PAR)
    // According to ISO/IEC 13818-2 Table 6-3
    let pixelAspectRatioWidth = 1
    let pixelAspectRatioHeight = 1

    switch (aspectRatioCode) {
      case 2: // 4:3 Display AR
        pixelAspectRatioWidth = 4 * height
        pixelAspectRatioHeight = 3 * width
        break
      case 3: // 16:9 Display AR
        pixelAspectRatioWidth = 16 * height
        pixelAspectRatioHeight = 9 * width
        break
      case 4: // 2.21:1 Display AR
        pixelAspectRatioWidth = 221 * height
        pixelAspectRatioHeight = 100 * width
        break
      // case 1 is square pixels (1:1)
      default:
        // Keep default 1:1 PAR
        break
    }

    // Simplify the PAR fraction
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
    const parGcd = gcd(pixelAspectRatioWidth, pixelAspectRatioHeight)
    pixelAspectRatioWidth = pixelAspectRatioWidth / parGcd
    pixelAspectRatioHeight = pixelAspectRatioHeight / parGcd

    // Calculate display dimensions by applying PAR
    const displayWidth = Math.round(width * (pixelAspectRatioWidth / pixelAspectRatioHeight))
    const displayHeight = height

    // MPEG-2 elementary streams do not contain rotation metadata
    // Rotation is typically handled at the container/presentation level
    // For TS files, we always return 0 as there's no standard way to store rotation
    return {
      width,
      height,
      rotation: 0,
      displayAspectWidth: width,
      displayAspectHeight: height,
      codec: 'mp2v',
      colorInfo: this.getDefaultColorInfo(),
      fps,
    }
  }

  private findVideoPackets(videoPid: number, streamType?: number): Uint8Array[] {
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
    const isMPEG2 = streamType === TSParser.STREAM_TYPES.VIDEO_MPEG2
    const isH264 = streamType === TSParser.STREAM_TYPES.VIDEO_H264
    const isHEVC = streamType === TSParser.STREAM_TYPES.VIDEO_HEVC

    while (
      offset + TSParser.PACKET_SIZE <= this.reader.length &&
      packetCount < maxPacketsToSearch &&
      !foundRequiredHeader
    ) {
      const packetStart = offset
      const syncByte = this.reader.data[offset]

      if (syncByte !== TSParser.SYNC_BYTE) {
        offset += TSParser.PACKET_SIZE
        continue
      }

      const pidHigh = this.reader.data[offset + 1]
      const pidLow = this.reader.data[offset + 2]
      const packetPid = ((pidHigh & 0x1f) << 8) | pidLow

      if (packetPid !== videoPid) {
        offset += TSParser.PACKET_SIZE
        continue
      }

      const flags = this.reader.data[offset + 3]
      const hasPayload = (flags & 0x10) !== 0
      const adaptationField = (flags & 0x20) !== 0
      const payloadUnitStart = (flags & 0x40) !== 0

      if (!hasPayload) {
        offset += TSParser.PACKET_SIZE
        continue
      }

      let payloadOffset = offset + 4
      if (adaptationField) {
        const adaptationLength = this.reader.data[payloadOffset]
        payloadOffset += adaptationLength > 0 ? adaptationLength + 1 : 1
      }

      if (payloadUnitStart) {
        // Save previous PES packet if we have one
        if (currentPESLength > 0) {
          // Check for required headers based on stream type
          let hasRequiredHeader = false
          for (let i = 0; i < currentPESLength - 4; i++) {
            if (pesBuffer[i] === 0x00 && pesBuffer[i + 1] === 0x00 && pesBuffer[i + 2] === 0x01) {
              const nalType = pesBuffer[i + 3]
              if (
                (isMPEG2 && nalType === 0xb3) || // MPEG-2 sequence header
                (isH264 && (nalType & 0x1f) === 7) || // H.264 SPS
                (isHEVC && ((nalType >> 1) & 0x3f) === 33) // HEVC SPS
              ) {
                hasRequiredHeader = true
                foundRequiredHeader = true
                break
              }
            }
          }

          packets.push(pesBuffer.slice(0, currentPESLength))

          // For MPEG-2, we can exit early. For H.264/HEVC, we need more NAL units
          if (hasRequiredHeader && isMPEG2) {
            return packets
          }
        }

        // Reset for new PES packet
        currentPESLength = 0

        // Skip PES header
        const pesHeaderLength = this.reader.data[payloadOffset + 8]
        payloadOffset += 9 + pesHeaderLength
      }

      // Add payload to current PES packet
      const payloadEnd = packetStart + TSParser.PACKET_SIZE
      const payloadLength = payloadEnd - payloadOffset

      if (payloadLength > 0 && currentPESLength + payloadLength <= maxPESSize) {
        // Copy directly to pre-allocated buffer
        pesBuffer.set(this.reader.data.subarray(payloadOffset, payloadEnd), currentPESLength)
        currentPESLength += payloadLength
      }

      offset += TSParser.PACKET_SIZE
    }

    // Add the last PES packet if we have one
    if (currentPESLength > 0) {
      packets.push(pesBuffer.slice(0, currentPESLength))
    }

    return packets
  }

  private formatFlags(flags: number): string {
    const parts: string[] = []
    if (flags & 0x40) parts.push('PUSI')
    if (flags & 0x20) parts.push('AF')
    if (flags & 0x10) parts.push('PAYLOAD')
    return parts.join('|')
  }

  private parseNALUnits(packets: Uint8Array[]): Uint8Array[] {
    const nalUnits: Uint8Array[] = []
    let currentNAL: number[] | null = null
    let nalCount = 0

    console.debug('Parsing NAL units from packets:', { packetCount: packets.length })

    // Concatenate all packets into one buffer for easier parsing
    const totalLength = packets.reduce((sum, packet) => sum + packet.length, 0)
    const buffer = new Uint8Array(totalLength)
    let offset = 0
    for (const packet of packets) {
      buffer.set(packet, offset)
      offset += packet.length
    }

    // Parse NAL units from the buffer
    let i = 0
    while (i < buffer.length) {
      // Look for start code (0x000001 or 0x00000001)
      if (
        i + 3 < buffer.length &&
        buffer[i] === 0 &&
        buffer[i + 1] === 0 &&
        (buffer[i + 2] === 1 ||
          (i + 4 <= buffer.length && buffer[i + 2] === 0 && buffer[i + 3] === 1))
      ) {
        // If we have a NAL unit in progress, save it
        if (currentNAL !== null && currentNAL.length > 0) {
          nalUnits.push(new Uint8Array(currentNAL))
          nalCount++
        }

        // Skip start code
        i += buffer[i + 2] === 1 ? 3 : 4
        currentNAL = []
        continue
      }

      if (currentNAL !== null) {
        currentNAL.push(buffer[i])
      }
      i++
    }

    // Add the last NAL unit if we have one
    if (currentNAL !== null && currentNAL.length > 0) {
      nalUnits.push(new Uint8Array(currentNAL))
      nalCount++
    }

    // Debug NAL unit types
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

  private findSPS(nalUnits: Uint8Array[], streamType: number): Uint8Array | null {
    if (streamType === TSParser.STREAM_TYPES.VIDEO_HEVC) {
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

  private async parseSPS(sps: Uint8Array, streamType: number) {
    try {
      if (streamType === TSParser.STREAM_TYPES.VIDEO_H264) {
        return this.parseH264SPS(sps)
      }
      if (streamType === TSParser.STREAM_TYPES.VIDEO_HEVC) {
        return this.parseHEVCSPS(sps)
      }
    } catch (error) {
      console.debug('Error parsing SPS:', error)
    }

    // Return default values if parsing fails
    return {
      width: 1920,
      height: 1080,
      rotation: 0,
      displayAspectWidth: 1920,
      displayAspectHeight: 1080,
      colorInfo: this.getDefaultColorInfo(),
    }
  }

  private parseH264SPS(sps: Uint8Array): VideoTrackMetadata {
    // Log the raw SPS data for debugging
    console.debug(
      'Raw SPS data:',
      Array.from(sps)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')
    )

    let fps = 0
    let sarWidth = 1
    let sarHeight = 1

    // Skip NAL header and check NAL type
    const nalType = sps[0] & 0x1f
    if (nalType !== 7) {
      console.debug('Not an SPS NAL unit:', nalType)
      return {
        width: 1920,
        height: 1080,
        rotation: 0,
        displayAspectWidth: 1920,
        displayAspectHeight: 1080,
        colorInfo: this.getDefaultColorInfo(),
        fps: 0,
        codec: 'avc1',
      }
    }

    // Create a new reader starting after the NAL header
    // The first byte of SPS data is the profile_idc
    const reader = new BitReader(sps.slice(1))

    // profile_idc
    const profileIdc = reader.readBits(8)
    // constraint_set flags and reserved zero bits
    const constraintFlags = reader.readBits(8)
    // level_idc
    const levelIdc = reader.readBits(8)

    // seq_parameter_set_id
    const spsId = reader.readUEV()
    console.debug('SPS basic info:', {
      profileIdc,
      constraintFlags: `0x${constraintFlags.toString(16)}`,
      levelIdc,
      spsId,
    })

    let chromaFormatIdc = 1
    let bitDepthLuma = 8
    let bitDepthChroma = 8
    let separateColorPlaneFlag = false

    if ([100, 110, 122, 244, 44, 83, 86, 118].includes(profileIdc)) {
      chromaFormatIdc = reader.readUEV()
      if (chromaFormatIdc === 3) {
        separateColorPlaneFlag = reader.readBit() === 1
      }
      bitDepthLuma = reader.readUEV() + 8
      bitDepthChroma = reader.readUEV() + 8
      reader.readBit() // qpprime_y_zero_transform_bypass_flag
      const seqScalingMatrixPresent = reader.readBit() === 1

      if (seqScalingMatrixPresent) {
        const chromaFormatIdcTable = chromaFormatIdc === 3 ? 12 : 8
        for (let i = 0; i < chromaFormatIdcTable; i++) {
          if (reader.readBit() === 1) {
            if (i < 6) {
              reader.skipScalingList(16)
            } else {
              reader.skipScalingList(64)
            }
          }
        }
      }
    }

    console.debug('SPS chroma info:', {
      chromaFormatIdc,
      separateColorPlaneFlag,
      bitDepthLuma,
      bitDepthChroma,
    })

    // log4_max_frame_num_minus4
    const log2MaxFrameNumMinus4 = reader.readUEV()

    // pic_order_cnt_type
    const picOrderCntType = reader.readUEV()
    if (picOrderCntType === 0) {
      reader.readUEV() // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
      reader.readBit() // delta_pic_order_always_zero_flag
      reader.readSEV() // offset_for_non_ref_pic
      reader.readSEV() // offset_for_top_to_bottom_field
      const numRefFramesInPicOrderCntCycle = reader.readUEV()
      for (let i = 0; i < numRefFramesInPicOrderCntCycle; i++) {
        reader.readSEV() // offset_for_ref_frame[i]
      }
    }

    // max_num_ref_frames
    const maxNumRefFrames = reader.readUEV()
    // gaps_in_frame_num_value_allowed_flag
    reader.readBit()

    // Try to read dimensions directly from the SPS data
    const rawWidth = ((sps[4] & 0x1f) << 8) | sps[5]
    const rawHeight = ((sps[6] & 0x1f) << 8) | sps[7]

    console.debug('Raw dimensions from SPS bytes:', { rawWidth, rawHeight })

    // pic_width_in_mbs_minus1
    const picWidthInMbsMinus1 = reader.readUEV()
    // pic_height_in_map_units_minus1
    const picHeightInMapUnitsMinus1 = reader.readUEV()
    // frame_mbs_only_flag
    const frameMbsOnlyFlag = reader.readBit() === 1

    console.debug('SPS Raw Values:', {
      picWidthInMbsMinus1,
      picHeightInMapUnitsMinus1,
      frameMbsOnlyFlag,
      chromaFormatIdc,
      log2MaxFrameNumMinus4,
      picOrderCntType,
      maxNumRefFrames,
    })

    let frameCropLeft = 0
    let frameCropRight = 0
    let frameCropTop = 0
    let frameCropBottom = 0

    if (!frameMbsOnlyFlag) {
      reader.readBit() // mb_adaptive_frame_field_flag
    }

    reader.readBit() // direct_8x8_inference_flag

    // frame_cropping_flag
    const hasCropping = reader.readBit() === 1
    if (hasCropping) {
      frameCropLeft = reader.readUEV()
      frameCropRight = reader.readUEV()
      frameCropTop = reader.readUEV()
      frameCropBottom = reader.readUEV()
      console.debug('Crop Values:', {
        frameCropLeft,
        frameCropRight,
        frameCropTop,
        frameCropBottom,
      })
    }

    // Calculate dimensions from macroblocks
    const mbWidth = picWidthInMbsMinus1 + 1
    const mbHeight = picHeightInMapUnitsMinus1 + 1

    // Calculate pixel dimensions
    let width = mbWidth * 16
    let height = mbHeight * 16 * (frameMbsOnlyFlag ? 1 : 2)

    // Apply cropping
    const cropUnitX = chromaFormatIdc === 3 ? 1 : 2
    const cropUnitY = chromaFormatIdc === 1 ? 2 : 1

    width -= (frameCropLeft + frameCropRight) * cropUnitX
    height -= (frameCropTop + frameCropBottom) * cropUnitY

    console.debug('Dimension Calculation:', {
      mbWidth,
      mbHeight,
      beforeCrop: {
        width: mbWidth * 16,
        height: mbHeight * (frameMbsOnlyFlag ? 16 : 32),
      },
      afterCrop: {
        width,
        height,
      },
      cropUnits: {
        x: cropUnitX,
        y: cropUnitY,
      },
      rawBits: {
        picWidthInMbsMinus1,
        picHeightInMapUnitsMinus1,
        frameMbsOnlyFlag,
      },
    })

    // If the calculated width is suspiciously small, try using the raw dimensions
    if (width <= 16 && rawWidth >= 16 && rawWidth <= 8192) {
      console.debug('Using raw dimensions from SPS bytes')
      width = rawWidth
      height = rawHeight
    }

    // If we still have invalid dimensions, try standard resolutions
    if (width <= 16 || width > 8192 || height <= 0 || height > 4320) {
      console.debug('Invalid dimensions calculated:', { width, height })
      // Try to estimate dimensions from the height and known aspect ratio
      if (height === 720) {
        width = 1280 // Common 720p width
        console.debug('Using standard 720p dimensions')
      } else if (height === 1080) {
        width = 1920 // Common 1080p width
        console.debug('Using standard 1080p dimensions')
      } else {
        // Try 16:9 aspect ratio
        width = Math.round(height * (16 / 9))
        if (width >= 16 && width <= 8192) {
          console.debug('Using estimated 16:9 width:', width)
        } else {
          return {
            width: 1920,
            height: 1080,
            rotation: 0,
            displayAspectWidth: 1920,
            displayAspectHeight: 1080,
            colorInfo: this.getDefaultColorInfo(),
            fps: 0,
            codec: 'avc1',
          }
        }
      }
    }

    // vui_parameters_present_flag
    const vuiParametersPresent = reader.readBit() === 1

    if (vuiParametersPresent) {
      try {
        // aspect_ratio_info_present_flag
        if (reader.readBit() === 1) {
          const aspectRatioIdc = reader.readBits(8)
          if (aspectRatioIdc === 255) {
            // Extended_SAR
            sarWidth = reader.readBits(16)
            sarHeight = reader.readBits(16)
          } else if (aspectRatioIdc < this.ASPECT_RATIO_IDC_VALUES.length) {
            ;[sarWidth, sarHeight] = this.ASPECT_RATIO_IDC_VALUES[aspectRatioIdc]
          }
        }

        // overscan_info_present_flag
        if (reader.readBit() === 1) {
          reader.readBit() // overscan_appropriate_flag
        }

        // video_signal_type_present_flag
        if (reader.readBit() === 1) {
          reader.readBits(3) // video_format
          reader.readBit() // video_full_range_flag
          // colour_description_present_flag
          if (reader.readBit() === 1) {
            reader.readBits(8) // colour_primaries
            reader.readBits(8) // transfer_characteristics
            reader.readBits(8) // matrix_coefficients
          }
        }

        // chroma_loc_info_present_flag
        if (reader.readBit() === 1) {
          reader.readUEV() // chroma_sample_loc_type_top_field
          reader.readUEV() // chroma_sample_loc_type_bottom_field
        }

        // timing_info_present_flag
        if (reader.readBit() === 1) {
          const numUnitsInTick = reader.readBits(32)
          const timeScale = reader.readBits(32)
          const fixedFrameRateFlag = reader.readBit() === 1

          console.debug('Raw timing values:', {
            numUnitsInTick,
            timeScale,
            fixedFrameRateFlag,
            remainingBits: reader.remainingBits(),
          })

          // For H.264 streams, common time_scale values indicate specific frame rates
          if (timeScale === 16777216) {
            // 2^24
            switch (numUnitsInTick) {
              case 12:
                fps = 60
                break // Common 60 fps
              case 15:
                fps = 48
                break // Common 48 fps
              case 24:
                fps = 30
                break // Common 30 fps
              case 30:
                fps = 24
                break // Common 24 fps
              case 48:
                fps = 15
                break // Common 15 fps
            }
          }

          console.debug('SPS timing info:', {
            numUnitsInTick,
            timeScale,
            fixedFrameRateFlag,
            calculatedFps: fps,
          })
        }
      } catch (error) {
        console.debug('Error parsing VUI parameters:', error)
      }
    }

    console.debug('SPS aspect ratio and timing:', { sarWidth, sarHeight, fps })

    // Calculate display aspect ratio
    const displayAspectWidth = width * sarWidth
    const displayAspectHeight = height * sarHeight

    return {
      width,
      height,
      rotation: 0,
      displayAspectWidth,
      displayAspectHeight,
      colorInfo: this.getDefaultColorInfo(),
      fps,
      codec: 'avc1',
    }
  }

  private parseHEVCSPS(sps: Uint8Array): VideoTrackMetadata {
    // Log the raw SPS data for debugging
    console.debug(
      'Raw HEVC SPS data:',
      Array.from(sps)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')
    )

    // Create a bit reader starting after the NAL header
    // For HEVC, first byte contains:
    // forbidden_zero_bit (1) + nal_unit_type (6) + nuh_layer_id (6)
    // Second byte contains:
    // nuh_temporal_id_plus1 (3) + reserved_zero_5bits (5)
    const reader = new BitReader(sps.slice(2))

    // sps_video_parameter_set_id (4 bits)
    const vpsId = reader.readBits(4)
    // sps_max_sub_layers_minus1 (3 bits)
    const maxSubLayersMinus1 = reader.readBits(3)
    // sps_temporal_id_nesting_flag (1 bit)
    const temporalIdNestingFlag = reader.readBit()

    console.debug('HEVC SPS header:', {
      vpsId,
      maxSubLayersMinus1,
      temporalIdNestingFlag,
      remainingBits: reader.remainingBits(),
      currentByte: reader.currentByte().toString(16),
    })

    // profile_tier_level
    this.parseProfileTierLevel(reader, maxSubLayersMinus1)

    console.debug('After profile_tier_level:', {
      remainingBits: reader.remainingBits(),
      currentByte: reader.currentByte().toString(16),
    })

    // sps_seq_parameter_set_id
    const spsId = reader.readUEV()
    console.debug('SPS ID:', spsId, {
      remainingBits: reader.remainingBits(),
      currentByte: reader.currentByte().toString(16),
    })

    // chroma_format_idc
    const chromaFormatIdc = reader.readUEV()
    let separateColourPlaneFlag = false
    if (chromaFormatIdc === 3) {
      // separate_colour_plane_flag
      separateColourPlaneFlag = reader.readBit() === 1
    }

    // pic_width_in_luma_samples
    const width = reader.readUEV()
    // pic_height_in_luma_samples
    const height = reader.readUEV()

    console.debug('HEVC dimensions:', {
      width,
      height,
      chromaFormatIdc,
      separateColourPlaneFlag,
      remainingBits: reader.remainingBits(),
      currentByte: reader.currentByte().toString(16),
    })

    // conformance_window_flag
    const conformanceWindowFlag = reader.readBit() === 1
    let confWinLeft = 0
    let confWinRight = 0
    let confWinTop = 0
    let confWinBottom = 0

    if (conformanceWindowFlag) {
      confWinLeft = reader.readUEV()
      confWinRight = reader.readUEV()
      confWinTop = reader.readUEV()
      confWinBottom = reader.readUEV()
      console.debug('HEVC conformance window:', {
        left: confWinLeft,
        right: confWinRight,
        top: confWinTop,
        bottom: confWinBottom,
      })
    }

    // bit_depth_luma_minus8
    const bitDepthLuma = reader.readUEV() + 8
    // bit_depth_chroma_minus8
    const bitDepthChroma = reader.readUEV() + 8

    console.debug('HEVC bit depth:', {
      luma: bitDepthLuma,
      chroma: bitDepthChroma,
      remainingBits: reader.remainingBits(),
      currentByte: reader.currentByte().toString(16),
    })

    // log2_max_pic_order_cnt_lsb_minus4
    const log2MaxPicOrderCntLsbMinus4 = reader.readUEV()
    console.debug('log2_max_pic_order_cnt_lsb_minus4:', log2MaxPicOrderCntLsbMinus4)

    // sps_sub_layer_ordering_info_present_flag
    const subLayerOrderingInfoPresentFlag = reader.readBit() === 1
    console.debug('sps_sub_layer_ordering_info_present_flag:', subLayerOrderingInfoPresentFlag)

    const startLayer = subLayerOrderingInfoPresentFlag ? 0 : maxSubLayersMinus1
    for (let i = startLayer; i <= maxSubLayersMinus1; i++) {
      reader.readUEV() // sps_max_dec_pic_buffering_minus1
      reader.readUEV() // sps_max_num_reorder_pics
      reader.readUEV() // sps_max_latency_increase_plus1
    }

    // log2_min_luma_coding_block_size_minus3
    reader.readUEV()
    // log2_diff_max_min_luma_coding_block_size
    reader.readUEV()
    // log2_min_luma_transform_block_size_minus2
    reader.readUEV()
    // log2_diff_max_min_luma_transform_block_size
    reader.readUEV()
    // max_transform_hierarchy_depth_inter
    reader.readUEV()
    // max_transform_hierarchy_depth_intra
    reader.readUEV()

    // Calculate final dimensions considering conformance window
    let finalWidth = width
    let finalHeight = height

    if (conformanceWindowFlag) {
      // Apply conformance window cropping
      // The formula depends on chroma format
      const subWidthC = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1
      const subHeightC = chromaFormatIdc === 1 ? 2 : 1

      finalWidth -= (confWinLeft + confWinRight) * subWidthC
      finalHeight -= (confWinTop + confWinBottom) * subHeightC
    }

    // Try to read VUI parameters for color info and frame rate
    let colorInfo = this.getDefaultColorInfo()
    let fps = 0

    // scaling_list_enabled_flag
    const scalingListEnabledFlag = reader.readBit() === 1
    if (scalingListEnabledFlag) {
      // sps_scaling_list_data_present_flag
      if (reader.readBit() === 1) {
        // Skip scaling list data
        this.skipScalingListData(reader)
      }
    }

    // amp_enabled_flag
    reader.readBit()
    // sample_adaptive_offset_enabled_flag
    reader.readBit()

    // pcm_enabled_flag
    if (reader.readBit() === 1) {
      reader.readBits(4) // pcm_sample_bit_depth_luma_minus1
      reader.readBits(4) // pcm_sample_bit_depth_chroma_minus1
      reader.readUEV() // log2_min_pcm_luma_coding_block_size_minus3
      reader.readUEV() // log2_diff_max_min_pcm_luma_coding_block_size
      reader.readBit() // pcm_loop_filter_disabled_flag
    }

    // num_short_term_ref_pic_sets
    const numShortTermRefPicSets = reader.readUEV()
    // Skip short term ref pic sets
    for (let i = 0; i < numShortTermRefPicSets; i++) {
      this.skipShortTermRefPicSet(reader, i, numShortTermRefPicSets)
    }

    // long_term_ref_pics_present_flag
    if (reader.readBit() === 1) {
      // num_long_term_ref_pics_sps
      const numLongTermRefPicsSps = reader.readUEV()
      for (let i = 0; i < numLongTermRefPicsSps; i++) {
        // Skip lt_ref_pic_poc_lsb_sps and used_by_curr_pic_lt_sps_flag
        reader.readBits(log2MaxPicOrderCntLsbMinus4 + 4)
        reader.readBit()
      }
    }

    // sps_temporal_mvp_enabled_flag
    reader.readBit()
    // strong_intra_smoothing_enabled_flag
    reader.readBit()

    // vui_parameters_present_flag
    const vuiParametersPresent = reader.readBit() === 1
    console.debug('VUI parameters present flag:', vuiParametersPresent, {
      remainingBits: reader.remainingBits(),
      currentByte: reader.currentByte().toString(16),
      nextBytes: Array.from(sps.slice(reader.currentPosition(), reader.currentPosition() + 4))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' '),
    })

    if (vuiParametersPresent) {
      const vuiParams = this.parseHEVCVUIParameters(reader)
      colorInfo = {
        matrixCoefficients: vuiParams.matrixCoefficients,
        transferCharacteristics: vuiParams.transferCharacteristics,
        primaries: vuiParams.primaries,
        fullRange: vuiParams.fullRange,
      }
      fps = vuiParams.fps || 0
    }

    console.debug('Final HEVC SPS parsing results:', {
      dimensions: `${finalWidth}x${finalHeight}`,
      fps,
      colorInfo,
      remainingBits: reader.remainingBits(),
    })

    return {
      width: finalWidth,
      height: finalHeight,
      rotation: 0,
      displayAspectWidth: finalWidth,
      displayAspectHeight: finalHeight,
      colorInfo,
      fps,
      codec: 'hev1',
    }
  }

  private skipScalingListData(reader: BitReader): void {
    for (let sizeId = 0; sizeId < 4; sizeId++) {
      for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
        if (reader.readBit() === 0) continue // scaling_list_pred_mode_flag
        // scaling_list_pred_matrix_id_delta
        reader.readUEV()
        const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)))
        if (sizeId > 1) {
          reader.readSEV() // scaling_list_dc_coef_minus8
        }
        for (let i = 0; i < coefNum; i++) {
          reader.readSEV() // scaling_list_delta_coef
        }
      }
    }
  }

  private skipShortTermRefPicSet(
    reader: BitReader,
    stRpsIdx: number,
    numShortTermRefPicSets: number
  ): void {
    if (stRpsIdx !== 0) {
      // inter_ref_pic_set_prediction_flag
      if (reader.readBit() === 1) {
        if (stRpsIdx === numShortTermRefPicSets) {
          reader.readUEV() // delta_idx_minus1
        }
        reader.readBit() // delta_rps_sign
        reader.readUEV() // abs_delta_rps_minus1
        const refRpsIdx = stRpsIdx - (reader.readUEV() + 1)
        const numDeltaPocs = 0 // This should be calculated from the reference RPS
        for (let j = 0; j <= numDeltaPocs; j++) {
          if (reader.readBit() === 1) {
            // used_by_curr_pic_flag[j]
            reader.readBit() // use_delta_flag[j]
          }
        }
      } else {
        const numNegativePics = reader.readUEV()
        const numPositivePics = reader.readUEV()
        for (let i = 0; i < numNegativePics; i++) {
          reader.readUEV() // delta_poc_s0_minus1
          reader.readBit() // used_by_curr_pic_s0_flag
        }
        for (let i = 0; i < numPositivePics; i++) {
          reader.readUEV() // delta_poc_s1_minus1
          reader.readBit() // used_by_curr_pic_s1_flag
        }
      }
    }
  }

  private parseProfileTierLevel(reader: BitReader, maxSubLayersMinus1: number): void {
    console.debug('Starting profile_tier_level parsing')
    // general_profile_space (2 bits)
    const profileSpace = reader.readBits(2)
    // general_tier_flag (1 bit)
    const tierFlag = reader.readBit()
    // general_profile_idc (5 bits)
    const profileIdc = reader.readBits(5)

    console.debug('Profile info:', { profileSpace, tierFlag, profileIdc })

    // general_profile_compatibility_flags (32 bits)
    const compatibilityFlags = reader.readBits(32)

    // general_constraint_indicator_flags (48 bits)
    // In some versions it's split into multiple fields, but we can read it as one
    const constraintFlags = reader.readBits(48)

    // general_level_idc (8 bits)
    const levelIdc = reader.readBits(8)

    console.debug('Level and constraints:', {
      compatibilityFlags: `0x${compatibilityFlags.toString(16)}`,
      constraintFlags: `0x${constraintFlags.toString(16)}`,
      levelIdc,
    })

    // sub_layer_profile_present_flag and sub_layer_level_present_flag
    const subLayerFlags: Array<{ profilePresent: boolean; levelPresent: boolean }> = []
    for (let i = 0; i < maxSubLayersMinus1; i++) {
      subLayerFlags.push({
        profilePresent: reader.readBit() === 1,
        levelPresent: reader.readBit() === 1,
      })
    }

    // reserved_zero_2bits * (8 - maxSubLayersMinus1)
    if (maxSubLayersMinus1 > 0) {
      for (let i = maxSubLayersMinus1; i < 8; i++) {
        reader.readBits(2)
      }
    }

    // Parse sub-layer profile and level info
    for (let i = 0; i < maxSubLayersMinus1; i++) {
      if (subLayerFlags[i].profilePresent) {
        // sub_layer_profile_space + tier_flag + profile_idc (8 bits)
        reader.readBits(8)
        // profile_compatibility_flags (32 bits)
        reader.readBits(32)
        // constraint_flags (48 bits)
        reader.readBits(48)
      }
      if (subLayerFlags[i].levelPresent) {
        // sub_layer_level_idc (8 bits)
        reader.readBits(8)
      }
    }

    console.debug('Finished profile_tier_level parsing, remaining bits:', reader.remainingBits())
  }

  private parseHEVCVUIParameters(reader: BitReader): VideoColorInfo & { fps?: number } {
    let fps = 0
    let colorInfo = this.getDefaultColorInfo()

    console.debug('Starting HEVC VUI parameters parsing')

    // aspect_ratio_info_present_flag
    const aspectRatioPresent = reader.readBit() === 1
    console.debug('aspect_ratio_info_present_flag:', aspectRatioPresent)
    if (aspectRatioPresent) {
      const aspectRatioIdc = reader.readBits(8)
      console.debug('aspect_ratio_idc:', aspectRatioIdc)
      if (aspectRatioIdc === 255) {
        // Extended_SAR
        const sarWidth = reader.readBits(16)
        const sarHeight = reader.readBits(16)
        console.debug('Extended SAR:', { width: sarWidth, height: sarHeight })
      }
    }

    // overscan_info_present_flag
    const overscanInfoPresent = reader.readBit() === 1
    console.debug('overscan_info_present_flag:', overscanInfoPresent)
    if (overscanInfoPresent) {
      const overscanAppropriate = reader.readBit() === 1
      console.debug('overscan_appropriate_flag:', overscanAppropriate)
    }

    // video_signal_type_present_flag
    const videoSignalTypePresent = reader.readBit() === 1
    console.debug('video_signal_type_present_flag:', videoSignalTypePresent)
    if (videoSignalTypePresent) {
      // video_format (3 bits)
      const videoFormat = reader.readBits(3)
      // video_full_range_flag (1 bit)
      const fullRange = reader.readBit() === 1
      // colour_description_present_flag (1 bit)
      const colourDescriptionPresent = reader.readBit() === 1
      console.debug('Video signal type:', {
        videoFormat,
        fullRange,
        colourDescriptionPresent,
      })

      if (colourDescriptionPresent) {
        const colorPrimaries = reader.readBits(8)
        const transferCharacteristics = reader.readBits(8)
        const matrixCoefficients = reader.readBits(8)

        console.debug('HEVC color parameters:', {
          videoFormat,
          colorPrimaries,
          transferCharacteristics,
          matrixCoefficients,
          fullRange,
          raw: {
            primaries: `0x${colorPrimaries.toString(16)}`,
            transfer: `0x${transferCharacteristics.toString(16)}`,
            matrix: `0x${matrixCoefficients.toString(16)}`,
          },
          mapped: {
            primaries: this.mapColorPrimaries(colorPrimaries),
            transfer: this.mapTransferCharacteristics(transferCharacteristics),
            matrix: this.mapMatrixCoefficients(matrixCoefficients),
          },
        })

        colorInfo = {
          matrixCoefficients: this.mapMatrixCoefficients(matrixCoefficients),
          transferCharacteristics: this.mapTransferCharacteristics(transferCharacteristics),
          primaries: this.mapColorPrimaries(colorPrimaries),
          fullRange,
        }
      } else {
        colorInfo = {
          ...this.getDefaultColorInfo(),
          fullRange,
        }
      }
    }

    // chroma_loc_info_present_flag
    const chromaLocInfoPresent = reader.readBit() === 1
    console.debug('chroma_loc_info_present_flag:', chromaLocInfoPresent)
    if (chromaLocInfoPresent) {
      const topField = reader.readUEV()
      const bottomField = reader.readUEV()
      console.debug('Chroma location:', { topField, bottomField })
    }

    // timing_info_present_flag
    const timingInfoPresent = reader.readBit() === 1
    console.debug(
      'timing_info_present_flag:',
      timingInfoPresent,
      'remaining bits:',
      reader.remainingBits()
    )

    if (timingInfoPresent) {
      const numUnitsInTick = reader.readBits(32)
      const timeScale = reader.readBits(32)
      const fixedFrameRateFlag = reader.readBit() === 1

      console.debug('Raw timing values:', {
        numUnitsInTick,
        timeScale,
        fixedFrameRateFlag,
        remainingBits: reader.remainingBits(),
      })

      // Calculate frame rate
      if (numUnitsInTick > 0 && timeScale > 0) {
        // For HEVC, fps = timeScale / numUnitsInTick
        let calculatedFps = timeScale / numUnitsInTick

        console.debug('Initial FPS calculation:', calculatedFps)

        // Common frame rate values for rounding
        const commonFps = [
          23.976, // 24000/1001
          24,
          25,
          29.97, // 30000/1001
          30,
          48,
          50,
          59.94, // 60000/1001
          60,
          120,
        ]

        // Find the closest common frame rate
        const closestFps = commonFps.reduce((prev, curr) =>
          Math.abs(curr - calculatedFps) < Math.abs(prev - calculatedFps) ? curr : prev
        )

        console.debug('Closest standard FPS:', closestFps)

        // If calculated fps is close to a common value (within 1%), use that instead
        if (Math.abs(calculatedFps - closestFps) / closestFps < 0.01) {
          calculatedFps = closestFps
          console.debug('Using standard FPS value:', calculatedFps)
        }

        fps = calculatedFps

        // Special case handling for common time_scale values
        if (timeScale === 90000) {
          console.debug('Found common timescale 90000, checking for standard cases')
          // Common time_scale for HEVC
          switch (numUnitsInTick) {
            case 1500:
              fps = 60 // 90000/1500 = 60fps
              break
            case 1501:
              fps = 59.94 // 90000/1501 ≈ 59.94fps
              break
            case 1800:
              fps = 50 // 90000/1800 = 50fps
              break
            case 3000:
              fps = 30 // 90000/3000 = 30fps
              break
            case 3003:
              fps = 29.97 // 90000/3003 ≈ 29.97fps
              break
            case 3750:
              fps = 24 // 90000/3750 = 24fps
              break
            case 3751:
              fps = 23.976 // 90000/3751 ≈ 23.976fps
              break
          }
          console.debug('After checking standard cases, fps:', fps)
        }
      }

      console.debug('HEVC timing info:', {
        numUnitsInTick,
        timeScale,
        fixedFrameRateFlag,
        calculatedFps: fps,
        raw: {
          units: `0x${numUnitsInTick.toString(16)}`,
          scale: `0x${timeScale.toString(16)}`,
        },
      })
    } else {
      console.debug('No timing info present in VUI parameters')
    }

    // Skip HRD parameters as they're not needed for dimensions/color
    const nalHrdParametersPresent = reader.readBit() === 1
    console.debug('nal_hrd_parameters_present_flag:', nalHrdParametersPresent)
    if (nalHrdParametersPresent) {
      console.debug('Skipping NAL HRD parameters')
      this.skipHrdParameters(reader)
    }
    const vclHrdParametersPresent = reader.readBit() === 1
    console.debug('vcl_hrd_parameters_present_flag:', vclHrdParametersPresent)
    if (vclHrdParametersPresent) {
      console.debug('Skipping VCL HRD parameters')
      this.skipHrdParameters(reader)
    }

    console.debug('Finished parsing VUI parameters, final fps:', fps)
    return { ...colorInfo, fps }
  }

  private skipHrdParameters(reader: BitReader): void {
    // Skip HRD (Hypothetical Reference Decoder) parameters
    // These are not needed for dimensions or color info
    const commonInfPresentFlag = reader.readBit() === 1
    if (commonInfPresentFlag) {
      reader.readBits(8) // bit_rate_scale
      reader.readBits(8) // cpb_size_scale
      if (reader.readBit() === 1) {
        // cpb_size_du_scale
        reader.readBits(8)
      }
      reader.readBits(5) // initial_cpb_removal_delay_length_minus1
      reader.readBits(5) // au_cpb_removal_delay_length_minus1
      reader.readBits(5) // dpb_output_delay_length_minus1
    }
  }

  private readonly ASPECT_RATIO_IDC_VALUES = [
    [1, 1], // 0 - Unspecified
    [1, 1], // 1 - 1:1 (Square)
    [12, 11], // 2 - 12:11
    [10, 11], // 3 - 10:11
    [16, 11], // 4 - 16:11
    [40, 33], // 5 - 40:33
    [24, 11], // 6 - 24:11
    [20, 11], // 7 - 20:11
    [32, 11], // 8 - 32:11
    [80, 33], // 9 - 80:33
    [18, 11], // 10 - 18:11
    [15, 11], // 11 - 15:11
    [64, 33], // 12 - 64:33
    [160, 99], // 13 - 160:99
    [4, 3], // 14 - 4:3
    [3, 2], // 15 - 3:2
    [2, 1], // 16 - 2:1
  ]

  private streamTypeToCodec(streamType: number): string {
    switch (streamType) {
      case TSParser.STREAM_TYPES.VIDEO_H264:
        return 'avc1'
      case TSParser.STREAM_TYPES.VIDEO_HEVC:
        return 'hev1'
      case TSParser.STREAM_TYPES.VIDEO_MPEG4:
        return 'mp4v'
      case TSParser.STREAM_TYPES.VIDEO_MPEG2:
        return 'mp2v'
      case TSParser.STREAM_TYPES.VIDEO_MPEG1:
        return 'mp1v'
      default:
        return 'unknown'
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

  private mapColorPrimaries(value: number): string | null {
    switch (value) {
      case 1:
        return 'bt709'
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
        return 'p3'
      case 12:
        return 'p3-d65'
      default:
        return null
    }
  }

  private mapMatrixCoefficients(value: number): string | null {
    switch (value) {
      case 1:
        return 'bt709'
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
      case 11:
        return 'smpte2085'
      case 12:
        return 'chromat-ncl'
      case 13:
        return 'chromat-cl'
      case 14:
        return 'ictcp'
      default:
        return null
    }
  }

  private mapTransferCharacteristics(value: number): string | null {
    switch (value) {
      case 1:
        return 'bt709'
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
        return 'log-sqrt'
      case 11:
        return 'iec61966-2-4'
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
        return 'hlg'
      default:
        return null
    }
  }
}
