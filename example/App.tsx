import * as ImagePicker from "expo-image-picker";
import { type VideoInfoResult, getVideoInfoAsync } from "expo-video-metadata";
import { useState } from "react";
import {
	ActivityIndicator,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";

import { parseMedia } from "@remotion/media-parser";
import { webFileReader } from "@remotion/media-parser/web-file";
import { pickFile } from "./components/file-picker";

export default function App() {
	const [result, setResult] = useState<
		VideoInfoResult | VideoInfoResult[] | null
	>(null);
	const [remoteVideoIsLoading, setRemoteVideoIsLoading] = useState(false);
	return (
		<ScrollView contentContainerStyle={styles.container}>
			<View
				style={{
					flexDirection: "column",
					justifyContent: "center",
					alignItems: "center",
					flexWrap: "wrap",
					gap: 15,
				}}
			>
				<Pressable
					style={styles.btn}
					onPress={() => {
						ImagePicker.launchImageLibraryAsync({
							mediaTypes: "videos",
							base64: false,
							exif: true,
							legacy: false,
							videoQuality: ImagePicker.UIImagePickerControllerQualityType.High,
							preferredAssetRepresentationMode:
								ImagePicker.UIImagePickerPreferredAssetRepresentationMode
									.Current,
						}).then(async (result) => {
							if (result.canceled) {
								return;
							}
							const videoInfo = await getVideoInfoAsync(result.assets[0].uri);
							setResult(videoInfo);
						});
					}}
				>
					<Text style={styles.btnText}>Pick with expo-image-picker</Text>
				</Pressable>
				<Pressable
					style={styles.btn}
					onPress={async () => {
						try {
							const videoFiles = await pickFile({
								mediaTypes: "videos",
							});

							if (Array.isArray(videoFiles)) {
								const videoInfos = await Promise.allSettled(
									videoFiles.map(async (videoFile) => {
										return await getVideoInfoAsync(videoFile.file);
									}),
								);

								console.log("files", videoFiles);
								console.log("videoInfos", videoInfos);

								setResult(videoInfos);
							} else {
								const videoInfo = await getVideoInfoAsync(videoFiles.file);
								console.log("file", videoFiles);
								console.log("videoInfo", videoInfo);

								setResult([videoInfo]); // Wrapping in an array to keep result consistent
							}
						} catch (error) {
							console.error("Error selecting video files:", error);
						}
					}}
				>
					<Text style={styles.btnText}>Custom Picker for web</Text>
				</Pressable>
				<Pressable
					style={styles.btn}
					disabled={remoteVideoIsLoading}
					onPress={async () => {
						try {
							setRemoteVideoIsLoading(true);
							const videoInfo = await getVideoInfoAsync(
								"https://download.samplelib.com/mp4/sample-5s.mp4",
							);
							setResult(videoInfo);
						} finally {
							setRemoteVideoIsLoading(false);
						}
					}}
				>
					<Text style={styles.btnText}>Load remote video</Text>
					{remoteVideoIsLoading && (
						<View
							style={{
								position: "absolute",
								right: 8,
								top: "50%",
								marginTop: 5,
								justifyContent: "center",
								alignItems: "center",
								transform: [{ scale: 0.7 }],
							}}
						>
							<ActivityIndicator size={"small"} color="white" />
						</View>
					)}
				</Pressable>
			</View>

			<View
				style={{
					flexDirection: "column",
					justifyContent: "center",
					alignItems: "center",
					flexWrap: "wrap",
					gap: 15,
					marginTop: 20,
				}}
			>
				<Pressable
					style={styles.btn}
					onPress={async () => {
						try {
							const videoFiles = await pickFile({
								mediaTypes: "videos",
							});

							if (Array.isArray(videoFiles)) {
								const videoInfos = await Promise.allSettled(
									videoFiles.map(async (videoFile) => {
										console.log("videoFile", videoFile);
										return await parseMedia({
											src: videoFile.file,
											fields: {
												durationInSeconds: true,
												dimensions: true,
											},
											reader: webFileReader,
										});
									}),
								);

								console.log("files", videoFiles);
								console.log("videoInfos", videoInfos);

								setResult(videoInfos);
							}
						} catch (error) {
							console.error("Error selecting video files:", error);
						}
					}}
				>
					<Text style={styles.btnText}>Parse with remotion/media-parser</Text>
				</Pressable>
			</View>

			<View
				style={{
					marginTop: 20,
					width: "100%",
					justifyContent: "center",
				}}
			>
				{result && (
					<View
						style={{
							backgroundColor: "#f5f5f5",
							alignItems: "center",
							padding: 15,
						}}
					>
						<Text style={{ fontSize: 15 }}>
							{JSON.stringify(result, null, 2)}
						</Text>
					</View>
				)}
			</View>
			{result && (
				<Pressable
					style={{
						marginTop: 20,
					}}
					onPress={async () => {
						setResult(null);
					}}
				>
					<Text style={{ fontSize: 15, fontWeight: "bold", color: "black" }}>
						Reset
					</Text>
				</Pressable>
			)}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	container: {
		backgroundColor: "#fff",
		alignItems: "center",
		justifyContent: "center",
	},
	btn: {
		backgroundColor: "black",
		borderRadius: 4,
		padding: 15,
		borderCurve: "continuous",
		width: 200,
	},
	btnText: {
		fontSize: 15,
		fontWeight: "bold",
		color: "white",
		textAlign: "center",
	},
});
