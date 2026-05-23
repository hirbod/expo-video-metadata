import * as ImagePicker from "expo-image-picker";
import { getVideoInfoAsync } from "expo-video-metadata";
import type {
  AudioTrackInfo,
  MediaTrackInfo,
  MetadataImageInfo,
  VideoInfoResult,
  VideoTrackInfo,
} from "expo-video-metadata";
import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";

type DisplayValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | MetadataImageInfo
  | DisplayValue[]
  | { [key: string]: DisplayValue };

const DEMO_OPTIONS = {
  includeMetadataTags: true,
};

function isMetadataImage(value: unknown): value is MetadataImageInfo {
  return (
    value !== null &&
    typeof value === "object" &&
    "mimeType" in value &&
    "data" in value
  );
}

function isVideoTrack(track: MediaTrackInfo): track is VideoTrackInfo {
  return track.type === "video" && "codedWidth" in track;
}

function isAudioTrack(track: MediaTrackInfo): track is AudioTrackInfo {
  return track.type === "audio" && "numberOfChannels" in track;
}

function bytesToBase64(bytes: Uint8Array) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const triplet = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    output += alphabet[(triplet >> 18) & 63];
    output += alphabet[(triplet >> 12) & 63];
    output += second === undefined ? "=" : alphabet[(triplet >> 6) & 63];
    output += third === undefined ? "=" : alphabet[triplet & 63];
  }

  return output;
}

function formatSeconds(value: number) {
  return `${value} seconds`;
}

function formatPixels(value: number) {
  return `${value} pixels`;
}

function toDisplayObject(result: VideoInfoResult): DisplayValue {
  return {
    Format: result.format,
    "Full MIME type": result.mimeType,
    "Starts at": formatSeconds(result.start),
    "Ends at": formatSeconds(result.end),
    "File size": result.fileSize ? `${result.fileSize} bytes` : undefined,
    Tracks: result.tracks.map((track) => {
      const displayTrack: { [key: string]: DisplayValue } = {
        Type: track.type,
        Codec: track.codec,
        "Full codec string": track.codecParameterString,
        "Starts at": formatSeconds(track.start),
        "Ends at": formatSeconds(track.end),
        "Language code": track.languageCode,
      };

      if (isVideoTrack(track)) {
        displayTrack["Coded width"] = formatPixels(track.codedWidth);
        displayTrack["Coded height"] = formatPixels(track.codedHeight);
        displayTrack.Rotation = `${track.rotation}° clockwise`;
        displayTrack["Pixel aspect ratio"] =
          `${track.pixelAspectRatio.num}:${track.pixelAspectRatio.den}`;
        displayTrack["Display width"] = formatPixels(track.displayWidth);
        displayTrack["Display height"] = formatPixels(track.displayHeight);
        displayTrack.Transparency = track.transparency;
        displayTrack["Color space"] = {
          "Color primaries": track.colorSpace.primaries ?? "Unknown",
          "Transfer characteristics": track.colorSpace.transfer ?? "Unknown",
          "Matrix coefficients": track.colorSpace.matrix ?? "Unknown",
          "Full range": track.colorSpace.fullRange ?? "Unknown",
          HDR: track.colorSpace.hdr ?? "Unknown",
        };
      }

      if (isAudioTrack(track)) {
        displayTrack["Number of channels"] = track.numberOfChannels;
        displayTrack["Sample rate"] = `${track.sampleRate} Hz`;
      }

      displayTrack["Packet statistics"] = track.packetStats
        ? {
            "Packet count": track.packetStats.packetCount,
            "Average packet rate": `${track.packetStats.averagePacketRate} Hz${
              isVideoTrack(track) ? " (FPS)" : ""
            }`,
            "Average bitrate": `${track.packetStats.averageBitrate} bps`,
          }
        : undefined;

      return displayTrack;
    }),
    "Metadata tags": result.metadataTags
      ? {
          Title: result.metadataTags.title,
          Description: result.metadataTags.description,
          Artist: result.metadataTags.artist,
          Album: result.metadataTags.album,
          "Album artist": result.metadataTags.albumArtist,
          "Track number": result.metadataTags.trackNumber,
          "Tracks total": result.metadataTags.tracksTotal,
          "Disc number": result.metadataTags.discNumber,
          "Discs total": result.metadataTags.discsTotal,
          Genre: result.metadataTags.genre,
          Date: result.metadataTags.date,
          Lyrics: result.metadataTags.lyrics,
          Comment: result.metadataTags.comment,
          Images: result.metadataTags.images,
          "Raw tag count": result.metadataTags.rawTagCount,
        }
      : undefined,
  };
}

function MetadataImage({ image }: { image: MetadataImageInfo }) {
  return (
    <Image
      source={{ uri: `data:${image.mimeType};base64,${bytesToBase64(image.data)}` }}
      style={styles.image}
    />
  );
}

function MetadataValue({
  depth = 0,
  isGroupValue = false,
  value,
}: {
  depth?: number;
  isGroupValue?: boolean;
  value: DisplayValue;
}) {
  if (value === undefined) {
    return null;
  }

  if (isMetadataImage(value)) {
    return <MetadataImage image={value} />;
  }

  if (Array.isArray(value)) {
    return (
      <View
        style={[
          styles.list,
          isGroupValue && styles.groupList,
          depth === 1 && styles.topLevelGroup,
        ]}
      >
        {value.map((item, index) => (
          <MetadataRow
            key={index}
            depth={depth + 1}
            label={`${index + 1}`}
            value={item}
          />
        ))}
      </View>
    );
  }

  if (value && typeof value === "object") {
    return (
      <View
        style={[
          styles.list,
          isGroupValue && styles.groupList,
          depth === 1 && styles.topLevelGroup,
        ]}
      >
        {Object.entries(value).map(([key, item]) => (
          <MetadataRow key={key} depth={depth + 1} label={key} value={item} />
        ))}
      </View>
    );
  }

  return <Text style={styles.value}>{String(value)}</Text>;
}

function MetadataRow({
  depth = 0,
  label,
  value,
}: {
  depth?: number;
  label: string;
  value: DisplayValue;
}) {
  if (value === undefined) {
    return null;
  }

  const isNested = Array.isArray(value) || (value !== null && typeof value === "object");

  if (isNested) {
    return (
      <View
        style={[
          styles.groupRow,
          depth > 1 && { marginLeft: Math.min((depth - 1) * 4, 12) },
        ]}
      >
        <Text style={[styles.groupLabel, depth > 1 && styles.labelNested]}>
          {label}:
        </Text>
        <MetadataValue depth={depth} isGroupValue value={value} />
      </View>
    );
  }

  return (
    <View
      style={[
        styles.row,
        depth > 1 && { marginLeft: Math.min((depth - 1) * 4, 12) },
      ]}
    >
      <Text style={[styles.label, depth > 1 && styles.labelNested]}>
        {label}:{" "}
      </Text>
      <MetadataValue depth={depth} isGroupValue={isNested} value={value} />
    </View>
  );
}

function AppContent() {
  const insets = useSafeAreaInsets();
  const [result, setResult] = useState<VideoInfoResult | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function loadPickedVideo() {
    const pickerResult = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: "videos",
      base64: false,
      exif: true,
      legacy: false,
      videoQuality: ImagePicker.UIImagePickerControllerQualityType.High,
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
    });

    if (pickerResult.canceled) {
      return;
    }

    const asset = pickerResult.assets[0];
    setIsLoading(true);
    setFileName(asset.fileName ?? asset.uri);

    try {
      setResult(await getVideoInfoAsync(asset.file ?? asset.uri, DEMO_OPTIONS));
    } finally {
      setIsLoading(false);
    }
  }

  async function loadRemoteVideo() {
    const url =
      "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

    setIsLoading(true);
    setFileName(url);

    try {
      setResult(await getVideoInfoAsync(url, DEMO_OPTIONS));
    } finally {
      setIsLoading(false);
    }
  }

  function reset() {
    setResult(null);
    setFileName(null);
    setIsLoading(false);
  }

  return (
    <View
      style={[
        styles.safeArea,
        {
          paddingBottom: insets.bottom,
          paddingTop: insets.top,
        },
      ]}
    >
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.actions}>
          <Pressable
            style={styles.button}
            disabled={isLoading}
            onPress={loadPickedVideo}
          >
            <Text style={styles.buttonText}>Select file</Text>
          </Pressable>
          <Pressable
            style={styles.button}
            disabled={isLoading}
            onPress={loadRemoteVideo}
          >
            <Text style={styles.buttonText}>Load URL</Text>
          </Pressable>
          {(result || fileName || isLoading) && (
            <Pressable
              style={[styles.button, styles.secondaryButton]}
              onPress={reset}
            >
              <Text style={[styles.buttonText, styles.secondaryButtonText]}>
                Reset
              </Text>
            </Pressable>
          )}
        </View>

        {isLoading && (
          <View style={styles.loading}>
            <ActivityIndicator size="small" color="#111" />
            <Text style={styles.loadingText}>Loading...</Text>
          </View>
        )}

        {fileName && (
          <Text style={styles.fileName} numberOfLines={2}>
            {fileName}
          </Text>
        )}

        {result && (
          <View style={styles.metadata}>
            <MetadataValue value={toDisplayObject(result)} />
          </View>
        )}
      </ScrollView>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: "#fff",
    flex: 1,
  },
  container: {
    flexGrow: 1,
    backgroundColor: "#fff",
    gap: 12,
    paddingBottom: 28,
    paddingHorizontal: 18,
    paddingTop: 14,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  button: {
    backgroundColor: "#111",
    borderRadius: 6,
    minHeight: 42,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  secondaryButton: {
    backgroundColor: "#f1f1f1",
  },
  buttonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
  secondaryButtonText: {
    color: "#111",
  },
  loading: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  loadingText: {
    color: "#555",
    fontSize: 14,
  },
  fileName: {
    color: "#555",
    fontSize: 13,
    lineHeight: 18,
  },
  metadata: {
    borderTopColor: "#e6e6e6",
    borderTopWidth: 1,
    paddingTop: 10,
  },
  list: {
    gap: 4,
    marginTop: 3,
    width: "100%",
  },
  groupList: {
    backgroundColor: "#fafafa",
    borderColor: "#eeeeee",
    borderRadius: 6,
    borderWidth: 1,
    marginBottom: 4,
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  topLevelGroup: {
    backgroundColor: "#f7f8fa",
    borderColor: "#e9ebef",
  },
  row: {
    alignItems: "flex-start",
    flexDirection: "row",
    flexWrap: "wrap",
    width: "100%",
  },
  groupRow: {
    marginTop: 6,
    width: "100%",
  },
  label: {
    color: "#111",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
  },
  groupLabel: {
    color: "#111",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
  },
  labelNested: {
    color: "#222",
    fontWeight: "600",
  },
  value: {
    color: "#444",
    flexShrink: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  image: {
    height: 120,
    marginTop: 4,
    width: 120,
  },
});
