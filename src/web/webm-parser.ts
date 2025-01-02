// WebM parser with full support for video/audio codecs and metadata parsing
import { BinaryReaderImpl } from "./binary-reader";
import { HdrDetector } from "./hdr-detector";
import { FpsDetector } from "./fps-detector";
import type {
	WebMElement,
	VideoTrackMetadata,
	ParsedVideoMetadata,
	VideoColorInfo,
} from "../ExpoVideoMetadata.types";

export class WebMParser {
	protected reader: BinaryReaderImpl;

	// EBML element IDs for WebM container format
	protected static readonly ELEMENTS = {
		EBML: 0x1a45dfa3,
		Segment: 0x18538067,
		Info: 0x1549a966,
		Tracks: 0x1654ae6b,
		TrackEntry: 0xae,
		TrackType: 0x83,
		TrackNumber: 0xd7,
		TrackUID: 0x73c5,
		FlagLacing: 0x9c,
		Language: 0x22b59c,
		CodecID: 0x86,
		CodecName: 0x258688,
		CodecPrivate: 0x63a2,
		Video: 0xe0,
		Audio: 0xe1,
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
		TimecodeScale: 0x2ad7b1,
		Duration: 0x4489,
	};

	constructor(data: Uint8Array) {
		this.reader = new BinaryReaderImpl(data);
	}

	public async parse(): Promise<ParsedVideoMetadata> {
		const ebml = this.readElement();
		if (!ebml || ebml.id !== WebMParser.ELEMENTS.EBML) {
			throw new Error("Not a valid WebM file");
		}

		const segment = this.readElement();
		if (!segment || segment.id !== WebMParser.ELEMENTS.Segment) {
			throw new Error("No Segment element found");
		}

		// Parse duration info
		const info = this.findElement(segment.data, WebMParser.ELEMENTS.Info);
		let duration = 0;
		let timecodeScale = 1000000; // Default microseconds

		if (info) {
			const timeScale = this.findElement(
				info.data,
				WebMParser.ELEMENTS.TimecodeScale,
			);
			if (timeScale) {
				timecodeScale = this.readUintFromElement(timeScale);
			}

			const durationElement = this.findElement(
				info.data,
				WebMParser.ELEMENTS.Duration,
			);
			if (durationElement) {
				const rawDuration = this.readUintFromElement(durationElement);
				duration = (rawDuration * timecodeScale) / 1000000000; // Convert to seconds
			}
		}

		// Parse tracks
		const tracks = this.findElement(segment.data, WebMParser.ELEMENTS.Tracks);
		if (!tracks) {
			throw new Error("No Tracks element found");
		}

		const videoTrack = this.findVideoTrack(tracks.data);
		if (!videoTrack) {
			throw new Error("No video track found");
		}

		const metadata = this.parseVideoTrack(videoTrack);
		const audioTrack = await this.findAudioTrack(tracks.data);
		const audioInfo = audioTrack
			? this.parseAudioTrack(audioTrack)
			: {
					hasAudio: false,
					audioChannels: 0,
					audioSampleRate: 0,
					audioCodec: "",
					audioBitrate: undefined,
				};

		// Calculate overall bitrate
		const bitrate = duration
			? Math.floor((this.reader.length * 8) / duration)
			: undefined;

		return {
			...metadata,
			...audioInfo,
			duration,
			fileSize: this.reader.length,
			bitrate,
			container: "webm",
		};
	}

	protected readElement(): WebMElement | null {
		try {
			if (this.reader.remaining() < 2) {
				console.debug("Not enough bytes remaining for element");
				return null;
			}

			const id = this.reader.readVint();
			console.debug("Read ID:", id.toString(16));

			if (this.reader.remaining() < 1) {
				console.debug("Not enough bytes remaining for size");
				return null;
			}

			const size = this.reader.readVint();
			console.debug("Read size:", size);

			if (size > this.reader.remaining()) {
				console.debug("Size larger than remaining bytes");
				return null;
			}

			const data = this.reader.read(Number(size));

			return {
				id,
				size: Number(size),
				data,
				offset: this.reader.offset,
			};
		} catch (error) {
			console.debug("Error reading EBML element:", error);
			return null;
		}
	}

	protected findElement(
		data: Uint8Array,
		targetId: number,
	): WebMElement | null {
		try {
			const localReader = new BinaryReaderImpl(data);

			while (localReader.remaining() >= 2) {
				const id = localReader.readVint();
				if (localReader.remaining() < 1) break;

				const size = localReader.readVint();
				if (size > localReader.remaining()) break;

				if (id === targetId) {
					return {
						id,
						size: Number(size),
						data: localReader.read(Number(size)),
						offset: localReader.offset,
					};
				}

				localReader.skip(Number(size));
			}
		} catch (error) {
			console.debug("Error finding EBML element:", error);
		}

		return null;
	}

	protected findVideoTrack(data: Uint8Array): WebMElement | null {
		try {
			const localReader = new BinaryReaderImpl(data);

			while (localReader.remaining() >= 2) {
				const id = localReader.readVint();
				if (localReader.remaining() < 1) break;

				const size = localReader.readVint();
				if (size > localReader.remaining()) break;

				const trackData = localReader.read(Number(size));

				if (id === WebMParser.ELEMENTS.TrackEntry) {
					const type = this.findElement(
						trackData,
						WebMParser.ELEMENTS.TrackType,
					);
					if (type && type.data[0] === 1) {
						// 1 = video track
						return {
							id,
							size: Number(size),
							data: trackData,
							offset: localReader.offset,
						};
					}
				} else {
					localReader.skip(Number(size));
				}
			}
		} catch (error) {
			console.debug("Error finding video track:", error);
		}

		return null;
	}

	protected parseVideoTrack(track: WebMElement): VideoTrackMetadata {
		let width = 0;
		let height = 0;
		let displayWidth = 0;
		let displayHeight = 0;
		let fps: number | undefined;
		let codec = "";
		let videoBitrate: number | undefined;

		try {
			const video = this.findElement(track.data, WebMParser.ELEMENTS.Video);
			if (!video) {
				throw new Error("No video element found in track");
			}

			// Get dimensions
			const pixelWidth = this.findElement(
				video.data,
				WebMParser.ELEMENTS.PixelWidth,
			);
			const pixelHeight = this.findElement(
				video.data,
				WebMParser.ELEMENTS.PixelHeight,
			);
			const displayWidthElem = this.findElement(
				video.data,
				WebMParser.ELEMENTS.DisplayWidth,
			);
			const displayHeightElem = this.findElement(
				video.data,
				WebMParser.ELEMENTS.DisplayHeight,
			);

			width = pixelWidth ? this.readUintFromElement(pixelWidth) : 0;
			height = pixelHeight ? this.readUintFromElement(pixelHeight) : 0;
			displayWidth = displayWidthElem
				? this.readUintFromElement(displayWidthElem)
				: width;
			displayHeight = displayHeightElem
				? this.readUintFromElement(displayHeightElem)
				: height;

			// Parse codec with advanced codec info
			const codecId = this.findElement(track.data, WebMParser.ELEMENTS.CodecID);
			if (codecId) {
				const codecStr = new TextDecoder().decode(codecId.data).trim();
				switch (codecStr) {
					case "V_VP8":
						codec = "vp8";
						break;
					case "V_VP9":
						codec = "vp9";
						break;
					case "V_AV1":
						codec = "av1";
						break;
					case "V_MPEG4/ISO/AVC":
						codec = "avc1";
						break;
					case "V_MPEGH/ISO/HEVC":
						codec = "hevc";
						break;
					default:
						codec = codecStr.toLowerCase().replace("v_", "");
				}

				// Parse codec private data for more details
				const codecPrivate = this.findElement(
					track.data,
					WebMParser.ELEMENTS.CodecPrivate,
				);
				if (codecPrivate?.data) {
					if (codec === "avc1") {
						const profile = codecPrivate.data[1];
						const level = codecPrivate.data[3];
						codec = `avc1.${profile.toString(16).padStart(2, "0")}${level.toString(16).padStart(2, "0")}`;
					} else if (codec === "hevc") {
						const profile = codecPrivate.data[1] & 0x1f;
						const level = codecPrivate.data[12];
						codec = `hvc1.${profile.toString(16)}${level.toString(16)}`;
					}
				}
			}

			// Get FPS from duration
			const defaultDuration = this.findElement(
				track.data,
				WebMParser.ELEMENTS.DefaultDuration,
			);
			if (defaultDuration) {
				const duration = this.readUintFromElement(defaultDuration);
				if (duration > 0) {
					fps = Math.round((1_000_000_000 / duration) * 1000) / 1000;
				}
			}

			// Get video bitrate if available
			const bitrate = this.findElement(
				track.data,
				WebMParser.ELEMENTS.VideoBitrate,
			);
			if (bitrate) {
				videoBitrate = this.readUintFromElement(bitrate);
			}

			// Get color info
			const colour = this.findElement(video.data, WebMParser.ELEMENTS.Colour);
			const colorInfo = colour
				? HdrDetector.parseWebMColorInfo(colour.data)
				: this.getDefaultColorInfo();

			return {
				width,
				height,
				rotation: 0, // WebM doesn't support rotation metadata
				displayAspectWidth: displayWidth,
				displayAspectHeight: displayHeight,
				colorInfo,
				codec,
				fps,
				videoBitrate,
			};
		} catch (error) {
			console.debug("Error parsing video track:", error);
			return {
				width,
				height,
				rotation: 0,
				displayAspectWidth: displayWidth,
				displayAspectHeight: displayHeight,
				colorInfo: this.getDefaultColorInfo(),
				codec,
				fps,
				videoBitrate,
			};
		}
	}

	protected async findAudioTrack(
		data: Uint8Array,
	): Promise<WebMElement | null> {
		try {
			const localReader = new BinaryReaderImpl(data);

			while (localReader.remaining() >= 2) {
				const id = localReader.readVint();
				if (localReader.remaining() < 1) break;

				const size = localReader.readVint();
				if (size > localReader.remaining()) break;

				const trackData = localReader.read(Number(size));

				if (id === WebMParser.ELEMENTS.TrackEntry) {
					const type = this.findElement(
						trackData,
						WebMParser.ELEMENTS.TrackType,
					);
					if (type && type.data[0] === 2) {
						// 2 = audio track
						return {
							id,
							size: Number(size),
							data: trackData,
							offset: localReader.offset,
						};
					}
				} else {
					localReader.skip(Number(size));
				}
			}
		} catch (error) {
			console.debug("Error finding audio track:", error);
		}

		return null;
	}

	protected parseAudioTrack(track: WebMElement): {
		hasAudio: boolean;
		audioChannels: number;
		audioSampleRate: number;
		audioCodec: string;
		audioBitrate?: number;
	} {
		try {
			let channels = 0;
			let sampleRate = 0;
			let codec = "";
			let audioBitrate: number | undefined;

			const codecId = this.findElement(track.data, WebMParser.ELEMENTS.CodecID);
			if (codecId) {
				const codecStr = new TextDecoder().decode(codecId.data).trim();
				switch (codecStr) {
					case "A_AAC":
					case "A_AAC/MPEG2/LC":
					case "A_AAC/MPEG4/LC":
						codec = "aac";
						break;
					case "A_AAC/MPEG4/LC/SBR":
						codec = "aac-he";
						break;
					case "A_AC3":
						codec = "ac3";
						break;
					case "A_EAC3":
						codec = "eac3";
						break;
					case "A_DTS":
						codec = "dts";
						break;
					case "A_VORBIS":
						codec = "vorbis";
						break;
					case "A_OPUS":
						codec = "opus";
						break;
					case "A_MPEG/L3":
						codec = "mp3";
						break;
					case "A_FLAC":
						codec = "flac";
						break;
					case "A_ALAC":
						codec = "alac";
						break;
					case "A_PCM/INT/LIT":
					case "A_PCM/INT/BIG":
						codec = "pcm";
						break;
					default:
						codec = codecStr.toLowerCase().replace("a_", "");
				}
			}

			const audio = this.findElement(track.data, WebMParser.ELEMENTS.Audio);
			if (audio) {
				const channelsElem = this.findElement(
					audio.data,
					WebMParser.ELEMENTS.Channels,
				);
				if (channelsElem) {
					channels = this.readUintFromElement(channelsElem);
				}

				const sampleRateElem = this.findElement(
					audio.data,
					WebMParser.ELEMENTS.SamplingFrequency,
				);
				if (sampleRateElem) {
					sampleRate = this.readUintFromElement(sampleRateElem);
				}

				// Get audio bitrate if available
				const bitrate = this.findElement(
					audio.data,
					WebMParser.ELEMENTS.AudioBitrate,
				);
				if (bitrate) {
					audioBitrate = this.readUintFromElement(bitrate);
				}
			}

			return {
				hasAudio: true,
				audioChannels: channels,
				audioSampleRate: sampleRate,
				audioCodec: codec,
				audioBitrate,
			};
		} catch (error) {
			console.debug("Error parsing audio track:", error);
			return {
				hasAudio: false,
				audioChannels: 0,
				audioSampleRate: 0,
				audioCodec: "",
				audioBitrate: undefined,
			};
		}
	}

	protected readUintFromElement(element: WebMElement): number {
		try {
			const reader = new BinaryReaderImpl(element.data);
			let value = 0;
			while (reader.remaining() > 0) {
				value = (value << 8) | reader.readUint8();
			}
			return value;
		} catch (error) {
			console.debug("Error reading uint from element:", error);
			return 0;
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
