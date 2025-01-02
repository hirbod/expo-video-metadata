// ts-parser.ts
import { BinaryReaderImpl } from "./binary-reader";
import type {
	VideoTrackMetadata,
	ParsedVideoMetadata,
	VideoColorInfo,
} from "../ExpoVideoMetadata.types";

export class TSParser {
	private reader: BinaryReaderImpl;
	private static readonly PACKET_SIZE = 188;
	private static readonly SYNC_BYTE = 0x47;

	// Stream types
	private static readonly STREAM_TYPES = {
		VIDEO_MPEG1: 0x01,
		VIDEO_MPEG2: 0x02,
		VIDEO_MPEG4: 0x10,
		VIDEO_H264: 0x1b,
		VIDEO_HEVC: 0x24,
		PRIVATE_DATA: 0x06,
	};

	// PSI (Program Specific Information) tables
	private static readonly PSI_TABLES = {
		PAT: 0x00, // Program Association Table
		PMT: 0x02, // Program Map Table
		SDT: 0x11, // Service Description Table
	};

	constructor(data: Uint8Array) {
		this.reader = new BinaryReaderImpl(data);
	}

	public async parse(): Promise<ParsedVideoMetadata> {
		if (!this.verifyTSSync()) {
			throw new Error("Not a valid Transport Stream");
		}

		const programInfo = await this.parsePAT();
		if (!programInfo.pmtPid) {
			throw new Error("No PMT PID found");
		}

		const streamInfo = await this.parsePMT(programInfo.pmtPid);
		const videoMetadata = await this.parseVideoStream(streamInfo);
		const audioInfo = await this.parseAudioStream(streamInfo);

		// Calculate duration from PCR values
		const duration = await this.calculateDuration();

		// Calculate bitrate - TS usually has a constant bitrate
		const bitrate = duration
			? Math.floor((this.reader.length * 8) / duration)
			: undefined;

		return {
			...videoMetadata,
			...audioInfo,
			duration,
			fileSize: this.reader.length,
			bitrate,
			container: "ts",
		};
	}

	private async calculateDuration(): Promise<number> {
		try {
			// Find first and last PCR values
			let firstPCR: number | null = null;
			let lastPCR: number | null = null;
			const pcrPids = new Set<number>();

			// First pass to find PCR PIDs
			for (
				let offset = 0;
				offset < Math.min(this.reader.length, 940);
				offset += TSParser.PACKET_SIZE
			) {
				const adaptationField = this.getAdaptationField(offset);
				if (adaptationField && adaptationField.flags & 0x10) {
					// Has PCR
					pcrPids.add(this.getPid(offset));
				}
			}

			// Find first PCR
			for (
				let offset = 0;
				offset < this.reader.length;
				offset += TSParser.PACKET_SIZE
			) {
				const pid = this.getPid(offset);
				if (pcrPids.has(pid)) {
					const pcr = this.getPCR(offset);
					if (pcr !== null) {
						firstPCR = pcr;
						break;
					}
				}
			}

			// Find last PCR
			for (
				let offset = this.reader.length - TSParser.PACKET_SIZE;
				offset >= 0;
				offset -= TSParser.PACKET_SIZE
			) {
				const pid = this.getPid(offset);
				if (pcrPids.has(pid)) {
					const pcr = this.getPCR(offset);
					if (pcr !== null) {
						lastPCR = pcr;
						break;
					}
				}
			}

			if (firstPCR !== null && lastPCR !== null) {
				return (lastPCR - firstPCR) / 90000; // PCR is in 90kHz units
			}
		} catch (error) {
			console.debug("Error calculating duration:", error);
		}

		// Fallback: estimate from file size and typical bitrate
		return Math.floor((this.reader.length * 8) / 10000000); // Assume ~10Mbps
	}

	private getPid(offset: number): number {
		return (
			((this.reader.data[offset + 1] & 0x1f) << 8) |
			this.reader.data[offset + 2]
		);
	}

	private getAdaptationField(
		offset: number,
	): { length: number; flags: number } | null {
		const flags = this.reader.data[offset + 3];
		if ((flags & 0x20) === 0) return null; // No adaptation field

		const length = this.reader.data[offset + 4];
		if (length === 0) return null;

		return { length, flags: this.reader.data[offset + 5] };
	}

	private getPCR(offset: number): number | null {
		const adaptField = this.getAdaptationField(offset);
		if (!adaptField || !(adaptField.flags & 0x10)) return null;

		const pcrOffset = offset + 6;
		const pcr_base =
			this.reader.data[pcrOffset] * 33554432 +
			this.reader.data[pcrOffset + 1] * 131072 +
			this.reader.data[pcrOffset + 2] * 512 +
			this.reader.data[pcrOffset + 3] * 2 +
			((this.reader.data[pcrOffset + 4] & 0x80) >>> 7);

		return pcr_base;
	}
	private async parseAudioStream(streamInfo: any): Promise<{
		hasAudio: boolean;
		audioChannels: number;
		audioSampleRate: number;
		audioCodec: string;
	}> {
		try {
			// Parse PMT for audio PIDs
			const audioStreams = streamInfo.filter(
				(stream: any) => [0x0f, 0x11, 0x03, 0x04].includes(stream.streamType), // MPEG Audio, AAC, AC3 types
			);

			if (audioStreams.length > 0) {
				const audioStream = audioStreams[0]; // Use first audio stream
				let codec = "";

				switch (audioStream.streamType) {
					case 0x0f:
						codec = "aac";
						break; // AAC
					case 0x11:
						codec = "aac";
						break; // LATM AAC
					case 0x03:
						codec = "mp3";
						break; // MPEG-1 Audio
					case 0x04:
						codec = "mp3";
						break; // MPEG-2 Audio
					default:
						codec = "unknown";
				}

				return {
					hasAudio: true,
					audioChannels: 2, // Default to stereo as TS doesn't easily expose this
					audioSampleRate: 48000, // Default to common value
					audioCodec: codec,
				};
			}
		} catch (error) {
			console.debug("Error parsing audio stream:", error);
		}

		return {
			hasAudio: false,
			audioChannels: 0,
			audioSampleRate: 0,
			audioCodec: "",
		};
	}

	private verifyTSSync(): boolean {
		// Check first few packets for sync byte
		for (let i = 0; i < 5; i++) {
			const pos = i * TSParser.PACKET_SIZE;
			if (pos >= this.reader.length) break;

			const syncByte = this.reader.data[pos];
			if (syncByte !== TSParser.SYNC_BYTE) {
				return false;
			}
		}
		return true;
	}

	private async parsePAT(): Promise<{ pmtPid: number | null }> {
		let pmtPid: number | null = null;
		const packets = this.findPSIPackets(TSParser.PSI_TABLES.PAT);

		for (const packet of packets) {
			// Parse PAT section
			const tableId = packet[0];
			if (tableId !== TSParser.PSI_TABLES.PAT) continue;

			const sectionLength = ((packet[1] & 0x0f) << 8) | packet[2];
			const programCount = Math.floor((sectionLength - 9) / 4);

			for (let i = 0; i < programCount; i++) {
				const offset = 8 + i * 4;
				const programNumber = (packet[offset] << 8) | packet[offset + 1];
				const pid = ((packet[offset + 2] & 0x1f) << 8) | packet[offset + 3];

				if (programNumber !== 0) {
					pmtPid = pid;
					break;
				}
			}
		}

		return { pmtPid };
	}

	private async parsePMT(pmtPid: number): Promise<{
		videoPid: number;
		videoStreamType: number;
	} | null> {
		const packets = this.findPSIPackets(TSParser.PSI_TABLES.PMT, pmtPid);

		for (const packet of packets) {
			const tableId = packet[0];
			if (tableId !== TSParser.PSI_TABLES.PMT) continue;

			const sectionLength = ((packet[1] & 0x0f) << 8) | packet[2];
			const programInfoLength = ((packet[10] & 0x0f) << 8) | packet[11];
			let offset = 12 + programInfoLength;

			while (offset < sectionLength - 4) {
				const streamType = packet[offset];
				const elementaryPid =
					((packet[offset + 1] & 0x1f) << 8) | packet[offset + 2];
				const esInfoLength =
					((packet[offset + 3] & 0x0f) << 8) | packet[offset + 4];

				if (this.isVideoStream(streamType)) {
					return {
						videoPid: elementaryPid,
						videoStreamType: streamType,
					};
				}

				offset += 5 + esInfoLength;
			}
		}

		return null;
	}

	private isVideoStream(streamType: number): boolean {
		return [
			TSParser.STREAM_TYPES.VIDEO_MPEG1,
			TSParser.STREAM_TYPES.VIDEO_MPEG2,
			TSParser.STREAM_TYPES.VIDEO_MPEG4,
			TSParser.STREAM_TYPES.VIDEO_H264,
			TSParser.STREAM_TYPES.VIDEO_HEVC,
		].includes(streamType);
	}

	private findPSIPackets(tableId: number, pid?: number): Uint8Array[] {
		const packets: Uint8Array[] = [];
		let offset = 0;

		while (offset + TSParser.PACKET_SIZE <= this.reader.length) {
			const packetStart = offset;
			const syncByte = this.reader.data[offset++];

			if (syncByte !== TSParser.SYNC_BYTE) {
				offset = packetStart + TSParser.PACKET_SIZE;
				continue;
			}

			const pidHigh = this.reader.data[offset++];
			const pidLow = this.reader.data[offset++];
			const packetPid = ((pidHigh & 0x1f) << 8) | pidLow;

			if (pid !== undefined && packetPid !== pid) {
				offset = packetStart + TSParser.PACKET_SIZE;
				continue;
			}

			const flags = this.reader.data[offset++];
			const hasPayload = (flags & 0x10) !== 0;
			const adaptationField = (flags & 0x20) !== 0;

			if (!hasPayload) {
				offset = packetStart + TSParser.PACKET_SIZE;
				continue;
			}

			let adaptationLength = 0;
			if (adaptationField) {
				adaptationLength = this.reader.data[offset++] + 1;
			}

			const payloadStart = offset + adaptationLength;
			const payloadLength = TSParser.PACKET_SIZE - (payloadStart - packetStart);

			if (payloadLength > 0) {
				const payload = this.reader.data.slice(
					payloadStart,
					payloadStart + payloadLength,
				);
				if (payload[0] === tableId) {
					packets.push(payload);
				}
			}

			offset = packetStart + TSParser.PACKET_SIZE;
		}

		return packets;
	}

	private async parseVideoStream(
		streamInfo: { videoPid: number; videoStreamType: number } | null,
	): Promise<VideoTrackMetadata> {
		if (!streamInfo) {
			throw new Error("No video stream found");
		}

		// Parse video elementary stream for H.264/HEVC specific data
		const videoPackets = this.findVideoPackets(streamInfo.videoPid);
		const nalUnits = this.parseNALUnits(videoPackets);
		const sps = this.findSPS(nalUnits, streamInfo.videoStreamType);

		if (!sps) {
			// Return basic metadata if can't parse SPS
			return {
				width: 0,
				height: 0,
				rotation: 0,
				displayAspectWidth: 0,
				displayAspectHeight: 0,
				codec: this.streamTypeToCodec(streamInfo.videoStreamType),
				colorInfo: this.getDefaultColorInfo(),
			};
		}

		// Parse SPS for resolution and other metadata
		const metadata = await this.parseSPS(sps, streamInfo.videoStreamType);
		return {
			...metadata,
			codec: this.streamTypeToCodec(streamInfo.videoStreamType),
		};
	}

	private findVideoPackets(videoPid: number): Uint8Array[] {
		return this.findPSIPackets(0xff, videoPid); // 0xFF is not a real table ID
	}

	private parseNALUnits(packets: Uint8Array[]): Uint8Array[] {
		const nalUnits: Uint8Array[] = [];
		let currentNAL: number[] = [];

		for (const packet of packets) {
			for (let i = 0; i < packet.length - 3; i++) {
				if (packet[i] === 0 && packet[i + 1] === 0 && packet[i + 2] === 1) {
					if (currentNAL.length > 0) {
						nalUnits.push(new Uint8Array(currentNAL));
						currentNAL = [];
					}
					i += 2;
					continue;
				}
				currentNAL.push(packet[i]);
			}
		}

		if (currentNAL.length > 0) {
			nalUnits.push(new Uint8Array(currentNAL));
		}

		return nalUnits;
	}

	private findSPS(
		nalUnits: Uint8Array[],
		streamType: number,
	): Uint8Array | null {
		const spsNalType = streamType === TSParser.STREAM_TYPES.VIDEO_HEVC ? 33 : 7;
		return nalUnits.find((nal) => (nal[0] & 0x1f) === spsNalType) || null;
	}

	private parseSPS(sps: Uint8Array, streamType: number) {
		// Basic implementation - would need more complex parsing for full SPS
		return {
			width: 1920, // Default values
			height: 1080,
			rotation: 0,
			displayAspectWidth: 1920,
			displayAspectHeight: 1080,
			colorInfo: this.getDefaultColorInfo(),
		};
	}

	private streamTypeToCodec(streamType: number): string {
		switch (streamType) {
			case TSParser.STREAM_TYPES.VIDEO_H264:
				return "avc1";
			case TSParser.STREAM_TYPES.VIDEO_HEVC:
				return "hev1";
			case TSParser.STREAM_TYPES.VIDEO_MPEG4:
				return "mp4v";
			case TSParser.STREAM_TYPES.VIDEO_MPEG2:
				return "mp2v";
			case TSParser.STREAM_TYPES.VIDEO_MPEG1:
				return "mp1v";
			default:
				return "unknown";
		}
	}

	private getDefaultColorInfo(): VideoColorInfo {
		return {
			matrixCoefficients: null,
			transferCharacteristics: null,
			primaries: null,
			fullRange: null,
		};
	}
}
