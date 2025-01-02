// mkv-parser.ts
import { WebMParser } from "./webm-parser";
import { BinaryReaderImpl } from "./binary-reader";
import { HdrDetector } from "./hdr-detector";
import type {
	WebMElement,
	VideoTrackMetadata,
	ParsedVideoMetadata,
} from "../ExpoVideoMetadata.types";

export class MKVParser extends WebMParser {
	// Additional Matroska specific element IDs
	private static readonly MKV_ELEMENTS = {
		// Header elements
		SeekHead: 0x114d9b74,
		SegmentInfo: 0x1549a966,
		Attachments: 0x1941a469,
		Chapters: 0x1043a770,
		Tags: 0x1254c367,
		Cues: 0x1c53bb6b,

		// Track specific elements
		TrackOperation: 0xe2,
		TrackCombinePlanes: 0xe3,
		TrackJoinBlocks: 0xe9,
		TrackPlane: 0xe4,
		TrackPlaneUID: 0xe5,
		TrackPlaneType: 0xe6,

		// Video specific elements
		StereoMode: 0x53b8,
		AlphaMode: 0x53c0,
		OldStereoMode: 0x53b9,
		PixelCropBottom: 0x54aa,
		PixelCropTop: 0x54bb,
		PixelCropLeft: 0x54cc,
		PixelCropRight: 0x54dd,
		AspectRatioType: 0x54b3,
	};

	public async parse(): Promise<ParsedVideoMetadata> {
		const baseMetadata = await super.parse();
		return {
			...baseMetadata,
			container: "mkv",
		};
	}

	protected parseVideoTrack(track: WebMElement): VideoTrackMetadata {
		// Get base metadata from WebM parser
		const baseMetadata = super.parseVideoTrack(track);

		try {
			// Parse Matroska-specific enhancements
			const video = this.findElement(track.data, WebMParser.ELEMENTS.Video);
			if (video) {
				// Handle crop values
				const cropValues = this.parseCropValues(video.data);
				if (cropValues) {
					baseMetadata.displayAspectWidth =
						baseMetadata.width - (cropValues.left + cropValues.right);
					baseMetadata.displayAspectHeight =
						baseMetadata.height - (cropValues.top + cropValues.bottom);
				}

				// Handle aspect ratio type
				const aspectRatioType = this.findElement(
					video.data,
					MKVParser.MKV_ELEMENTS.AspectRatioType,
				);
				if (aspectRatioType && aspectRatioType.data.length > 0) {
					this.applyAspectRatioType(aspectRatioType.data[0], baseMetadata);
				}

				// Handle stereo mode
				const stereoMode = this.findElement(
					video.data,
					MKVParser.MKV_ELEMENTS.StereoMode,
				);
				if (stereoMode) {
					// Could adjust display width/height based on stereo mode
					this.applyStereoMode(stereoMode.data[0], baseMetadata);
				}
			}
		} catch (error) {
			console.debug("Error parsing MKV-specific metadata:", error);
		}

		return baseMetadata;
	}

	private parseCropValues(
		videoData: Uint8Array,
	): { top: number; bottom: number; left: number; right: number } | null {
		try {
			const cropTop = this.findElement(
				videoData,
				MKVParser.MKV_ELEMENTS.PixelCropTop,
			);
			const cropBottom = this.findElement(
				videoData,
				MKVParser.MKV_ELEMENTS.PixelCropBottom,
			);
			const cropLeft = this.findElement(
				videoData,
				MKVParser.MKV_ELEMENTS.PixelCropLeft,
			);
			const cropRight = this.findElement(
				videoData,
				MKVParser.MKV_ELEMENTS.PixelCropRight,
			);

			if (!cropTop && !cropBottom && !cropLeft && !cropRight) {
				return null;
			}

			return {
				top: cropTop ? this.readUintFromElement(cropTop) : 0,
				bottom: cropBottom ? this.readUintFromElement(cropBottom) : 0,
				left: cropLeft ? this.readUintFromElement(cropLeft) : 0,
				right: cropRight ? this.readUintFromElement(cropRight) : 0,
			};
		} catch (error) {
			console.debug("Error parsing crop values:", error);
			return null;
		}
	}

	private applyAspectRatioType(
		aspectRatioType: number,
		metadata: VideoTrackMetadata,
	): void {
		// 0: free resizing
		// 1: keep aspect ratio
		// 2: fixed dimensions
		if (aspectRatioType === 1 && metadata.width && metadata.height) {
			const gcd = this.calculateGCD(metadata.width, metadata.height);
			metadata.displayAspectWidth = metadata.width / gcd;
			metadata.displayAspectHeight = metadata.height / gcd;
		}
	}

	private applyStereoMode(
		stereoMode: number,
		metadata: VideoTrackMetadata,
	): void {
		// Matroska stereo modes that affect display dimensions
		switch (stereoMode) {
			case 1: // side-by-side (left eye first)
			case 2: // top-bottom (right eye first)
			case 3: // top-bottom (left eye first)
			case 4: // checkboard (right eye first)
			case 5: // checkboard (left eye first)
			case 6: // row interleaved (right eye first)
			case 7: // row interleaved (left eye first)
			case 8: // column interleaved (right eye first)
			case 9: // column interleaved (left eye first)
				// Adjust display dimensions based on stereo mode if needed
				if (stereoMode === 1) {
					metadata.displayAspectWidth = Math.floor(metadata.width / 2);
				} else if (stereoMode === 2 || stereoMode === 3) {
					metadata.displayAspectHeight = Math.floor(metadata.height / 2);
				}
				break;
		}
	}

	private calculateGCD(a: number, b: number): number {
		return b === 0 ? a : this.calculateGCD(b, a % b);
	}
}
