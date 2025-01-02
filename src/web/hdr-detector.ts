// hdr-detector.ts
import type { VideoColorInfo } from "../ExpoVideoMetadata.types";
import { BinaryReaderImpl } from "./binary-reader";

export class HdrDetector {
	static parseMP4ColorInfo(data: Uint8Array): VideoColorInfo {
		try {
			const reader = new BinaryReaderImpl(data);
			console.debug(
				"Parsing color data of length:",
				data.length,
				"First bytes:",
				Array.from(data.slice(0, 4)),
			);

			// Check for HEVC/AVC/AV1/VP9 configs first
			if (data[0] === 1) {
				if (data[1] === 0x22) return HdrDetector.parseHEVCConfig(reader);
				if (data[1] === 0x64 || data[1] === 0x4d || data[1] === 0x42)
					return HdrDetector.parseAVCConfig(reader);
				if (data[1] === 0x81) return HdrDetector.parseAV1Config(reader);
				if (data[1] === 0x91) return HdrDetector.parseVP9Config(reader);
			}

			const colourType = reader.readString(4);
			console.debug("Color type:", colourType, "Data length:", data.length);
			console.debug(
				"Raw data:",
				Array.from(data).map((b) => b.toString(16)),
			);

			switch (colourType) {
				case "nclx":
				case "nclc": {
					const primaries = reader.readUint16();
					const transfer = reader.readUint16();
					const matrix = reader.readUint16();
					const fullRange =
						colourType === "nclx" ? (reader.readUint8() & 0x80) !== 0 : null;
					return {
						matrixCoefficients: HdrDetector.mapMatrixCoefficients(matrix),
						transferCharacteristics: HdrDetector.mapTransferCharacteristics(transfer),
						primaries: HdrDetector.mapColorPrimaries(primaries),
						fullRange,
					};
				}
				case "mdcv":
					return HdrDetector.parseMasteringDisplayColorVolume(reader);
				case "clli":
					return HdrDetector.parseContentLightLevel(reader);
				case "dovi":
					return HdrDetector.parseDolbyVision(reader);
				case "rICC":
				case "prof":
					return {
						matrixCoefficients: "rgb",
						transferCharacteristics: null,
						primaries: null,
						fullRange: true,
					};
			}
		} catch (error) {
			console.debug("Error parsing color info:", error);
		}
		return HdrDetector.getDefaultColorInfo();
	}

	private static parseAV1Config(reader: BinaryReaderImpl): VideoColorInfo {
		try {
			const marker = reader.readUint8();
			const version = reader.readUint8();
			const profileAndLevel = reader.readUint8();
			const flags = reader.readUint8();

			const profile = (profileAndLevel >> 5) & 0x7;
			const hasHDR = (flags & 0x4) !== 0;
			const highBitDepth = (flags & 0x2) !== 0;

			if (hasHDR || (profile >= 2 && highBitDepth)) {
				return {
					matrixCoefficients: "bt2020nc",
					transferCharacteristics: "smpte2084",
					primaries: "bt2020",
					fullRange: true,
				};
			}
		} catch (error) {
			console.debug("Error parsing AV1 config:", error);
		}
		return HdrDetector.getDefaultColorInfo();
	}

	private static parseVP9Config(reader: BinaryReaderImpl): VideoColorInfo {
		try {
			const profile = reader.readUint8();
			const level = reader.readUint8();
			const bitDepth = reader.readUint8();
			const colorConfig = reader.readUint8();

			const hasHDR =
				(profile >= 2 && bitDepth >= 10) || (colorConfig & 0x4) !== 0; // Check for HDR flag

			if (hasHDR) {
				return {
					matrixCoefficients: "bt2020nc",
					transferCharacteristics: "smpte2084",
					primaries: "bt2020",
					fullRange: true,
				};
			}

			return {
				matrixCoefficients: "bt709",
				transferCharacteristics: "bt709",
				primaries: "bt709",
				fullRange: false,
			};
		} catch (error) {
			console.debug("Error parsing VP9 config:", error);
		}
		return HdrDetector.getDefaultColorInfo();
	}

	private static parseDolbyVision(reader: BinaryReaderImpl): VideoColorInfo {
		try {
			const dvProfile = reader.readUint8();
			const dvLevel = reader.readUint8();
			const rpuFlag = reader.readUint8();
			const elFlag = reader.readUint8();
			const blFlag = reader.readUint8();

			// Dolby Vision always uses HDR
			return {
				matrixCoefficients: "ictcp",
				transferCharacteristics: dvProfile <= 7 ? "smpte2084" : "bt1361",
				primaries: "bt2020",
				fullRange: true,
			};
		} catch (error) {
			console.debug("Error parsing Dolby Vision config:", error);
		}
		return HdrDetector.getDefaultColorInfo();
	}

	private static parseMasteringDisplayColorVolume(
		reader: BinaryReaderImpl,
	): VideoColorInfo {
		try {
			// Skip display primaries (24 bytes)
			reader.skip(24);

			// Read white point (8 bytes)
			reader.skip(8);

			// Read max/min luminance
			const maxLuminance = reader.readUint32();
			const minLuminance = reader.readUint32();

			// If max luminance > 1000 nits, likely HDR
			const isHDR = maxLuminance > 1000000; // Value in 0.0001 nits

			if (isHDR) {
				return {
					matrixCoefficients: "bt2020nc",
					transferCharacteristics: "smpte2084",
					primaries: "bt2020",
					fullRange: true,
				};
			}
		} catch (error) {
			console.debug("Error parsing mastering display metadata:", error);
		}
		return HdrDetector.getDefaultColorInfo();
	}

	private static parseContentLightLevel(
		reader: BinaryReaderImpl,
	): VideoColorInfo {
		try {
			const maxCLL = reader.readUint16();
			const maxFALL = reader.readUint16();

			// If maxCLL > 1000 nits, likely HDR
			const isHDR = maxCLL > 1000;

			if (isHDR) {
				return {
					matrixCoefficients: "bt2020nc",
					transferCharacteristics: "smpte2084",
					primaries: "bt2020",
					fullRange: true,
				};
			}
		} catch (error) {
			console.debug("Error parsing content light level:", error);
		}
		return HdrDetector.getDefaultColorInfo();
	}

	private static parseAVCConfig(reader: BinaryReaderImpl): VideoColorInfo {
		try {
			const configurationVersion = reader.readUint8();
			const profileIdc = reader.readUint8();
			const profileCompatibility = reader.readUint8();
			const levelIdc = reader.readUint8();

			console.debug("AVC config:", {
				configurationVersion,
				profileIdc,
				profileCompatibility,
				levelIdc,
			});

			// Check profiles
			switch (profileIdc) {
				// High 10, High 10 Intra
				case 110:
				case 122:
					return {
						matrixCoefficients: "bt2020nc",
						transferCharacteristics: "bt2100-pq",
						primaries: "bt2020",
						fullRange: true,
					};

				// High, High Intra, High Progressive
				case 100:
				case 118:
				case 44:
					return {
						matrixCoefficients: "bt709",
						transferCharacteristics: "bt709",
						primaries: "bt709",
						fullRange: false,
					};

				// Main, Main Intra
        // Baseline, Extended, Constrained Baseline
				case 66:
				case 77:
        case 82:
				case 88:
					return {
						matrixCoefficients: "bt601",
						transferCharacteristics: "bt601",
						primaries: "bt601",
						fullRange: false,
					};

				default:
					return HdrDetector.getDefaultColorInfo();
			}
		} catch (error) {
			console.debug("Error parsing AVC config:", error);
		}
		return HdrDetector.getDefaultColorInfo();
	}

	static parseHEVCConfig(reader: BinaryReaderImpl): VideoColorInfo {
		try {
			const configVersion = reader.readUint8();
			console.debug("HEVC config version:", configVersion);

			const generalProfileSpace = reader.readUint8();
			console.debug("General profile space:", generalProfileSpace);

			const profileIdc = generalProfileSpace & 0x1f;
			console.debug("Profile IDC:", profileIdc);

			// Read compatibility and constraint flags
			const constraintFlags: number[] = [];
			for (let i = 0; i < 6; i++) {
				constraintFlags.push(reader.readUint8());
			}
			console.debug("Constraint flags:", constraintFlags);

			const levelIdc = reader.readUint8();
			console.debug("Level IDC:", levelIdc);

			if (profileIdc === 2 || constraintFlags[1] & 0x40) {
				return {
					matrixCoefficients: "bt2020nc",
					transferCharacteristics: "smpte2084",
					primaries: "bt2020",
					fullRange: true,
				};
			}
		} catch (error) {
			console.debug("Error parsing HEVC config:", error);
		}
		return HdrDetector.getDefaultColorInfo();
	}

	static parseWebMColorInfo(data: Uint8Array): VideoColorInfo {
		try {
			const reader = new BinaryReaderImpl(data);
			let matrixCoefficients: string | null = null;
			let transferCharacteristics: string | null = null;
			let primaries: string | null = null;
			let fullRange: boolean | null = null;

			while (reader.remaining() >= 2) {
				const id = reader.readVint();
				const size = reader.readVint();

				if (reader.remaining() < size) break;

				switch (id) {
					case 0x55b1: // MatrixCoefficients
						matrixCoefficients = HdrDetector.mapMatrixCoefficients(reader.readUint8());
						break;
					case 0x55b2: // BitsPerChannel
						fullRange = reader.readUint8() === 0;
						break;
					case 0x55b9: // TransferCharacteristics
						transferCharacteristics = HdrDetector.mapTransferCharacteristics(
							reader.readUint8(),
						);
						break;
					case 0x55ba: // Primaries
						primaries = HdrDetector.mapColorPrimaries(reader.readUint8());
						break;
					default:
						reader.skip(Number(size));
				}
			}

			return {
				matrixCoefficients,
				transferCharacteristics,
				primaries,
				fullRange,
			};
		} catch (error) {
			return HdrDetector.getDefaultColorInfo();
		}
	}

	private static mapMatrixCoefficients(value: number): string | null {
		switch (value) {
			case 0:
				return "rgb"; // Identity/RGB
			case 1:
				return "bt709"; // ITU-R BT.709
			case 2:
				return "unspecified";
			case 4:
				return "fcc"; // US FCC 73.682
			case 5:
				return "bt470bg"; // ITU-R BT.470BG
			case 6:
				return "bt601"; // ITU-R BT.601
			case 7:
				return "smpte240m"; // SMPTE 240M
			case 8:
				return "ycgco"; // YCgCo
			case 9:
				return "bt2020nc"; // BT.2020 non-constant
			case 10:
				return "bt2020c"; // BT.2020 constant
			case 11:
				return "smpte2085"; // SMPTE ST 2085
			case 12:
				return "chroma-derived-nc"; // Chromaticity-derived non-constant
			case 13:
				return "chroma-derived-c"; // Chromaticity-derived constant
			case 14:
				return "ictcp"; // ICtCp
			default:
				return null;
		}
	}

	private static mapTransferCharacteristics(value: number): string | null {
		switch (value) {
			case 0:
				return null;
			case 1:
				return "bt709"; // ITU-R BT.709
			case 2:
				return "unspecified";
			case 4:
				return "gamma22"; // Gamma 2.2
			case 5:
				return "gamma28"; // Gamma 2.8
			case 6:
				return "bt601"; // ITU-R BT.601
			case 7:
				return "smpte240m"; // SMPTE 240M
			case 8:
				return "linear"; // Linear
			case 9:
				return "log100"; // Logarithmic (100:1 range)
			case 10:
				return "log316"; // Logarithmic (316.22777:1 range)
			case 11:
				return "xvycc"; // IEC 61966-2-4
			case 12:
				return "bt1361"; // ITU-R BT.1361
			case 13:
				return "srgb"; // sRGB/sYCC
			case 14:
				return "bt2020-10"; // BT.2020 10-bit
			case 15:
				return "bt2020-12"; // BT.2020 12-bit
			case 16:
				return "smpte2084"; // SMPTE ST 2084 (PQ)
			case 17:
				return "smpte428"; // SMPTE ST 428-1
			case 18:
				return "hlg"; // HLG (Hybrid Log-Gamma)
			case 19:
				return "arib-std-b67"; // ARIB STD-B67
			default:
				return null;
		}
	}

	private static mapColorPrimaries(value: number): string | null {
		switch (value) {
			case 0:
				return null;
			case 1:
				return "bt709"; // ITU-R BT.709
			case 2:
				return "unspecified";
			case 4:
				return "bt470m"; // ITU-R BT.470M
			case 5:
				return "bt470bg"; // ITU-R BT.470BG
			case 6:
				return "bt601"; // ITU-R BT.601
			case 7:
				return "smpte240m"; // SMPTE 240M
			case 8:
				return "film"; // Generic film
			case 9:
				return "bt2020"; // ITU-R BT.2020
			case 10:
				return "smpte428"; // SMPTE ST 428-1
			case 11:
				return "smpte431"; // SMPTE RP 431-2
			case 12:
				return "smpte432"; // SMPTE EG 432-1
			case 22:
				return "jedec-p22"; // JEDEC P22
			default:
				return null;
		}
	}

	// Update isHdr method to include more formats
	static isHdr(colorInfo: VideoColorInfo): boolean {
		// HDR10
		const isHdr10 =
			colorInfo.primaries === "bt2020" &&
			colorInfo.transferCharacteristics === "smpte2084" &&
			(colorInfo.matrixCoefficients === "bt2020nc" ||
				colorInfo.matrixCoefficients === "bt2020c" ||
				colorInfo.matrixCoefficients === "ictcp");

		// HLG
		const isHlg =
			colorInfo.primaries === "bt2020" &&
			(colorInfo.transferCharacteristics === "hlg" ||
				colorInfo.transferCharacteristics === "arib-std-b67");

		// Dolby Vision
		const isDolbyVision =
			colorInfo.transferCharacteristics === "smpte2084" &&
			colorInfo.matrixCoefficients === "ictcp";

		return isHdr10 || isHlg || isDolbyVision;
	}

	private static getDefaultColorInfo(): VideoColorInfo {
		return {
			matrixCoefficients: null,
			transferCharacteristics: null,
			primaries: null,
			fullRange: null,
		};
	}
}
