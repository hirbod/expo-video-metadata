import * as ImagePicker from "expo-image-picker";
import { VideoInfoResult, getVideoInfoAsync } from "expo-video-metadata";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { pickFile } from "./components/file-picker";

export default function App() {
  const [result, setResult] = useState<VideoInfoResult | null>(null);
  return (
    <View style={styles.container}>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "center",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 20,
        }}
      >
        <Pressable
          style={{
            backgroundColor: "black",
            borderRadius: 20,
            padding: 20,
            borderCurve: "continuous",
          }}
          onPress={() => {
            ImagePicker.launchImageLibraryAsync({
              mediaTypes: ImagePicker.MediaTypeOptions.Videos,
            }).then(async (result) => {
              if (result.canceled) {
                return;
              }
              const videoInfo = await getVideoInfoAsync(result.assets[0].uri);
              setResult(videoInfo);
            });
          }}
        >
          <Text style={{ fontSize: 15, fontWeight: "bold", color: "white" }}>
            Select Video with ImagePicker by Expo
          </Text>
        </Pressable>
        <Pressable
          style={{
            backgroundColor: "black",
            borderRadius: 20,
            padding: 20,
            borderCurve: "continuous",
          }}
          onPress={async () => {
            const videoFile = await pickFile({
              mediaTypes: "video",
            });
            console.log(videoFile.file);
            const videoInfo = await getVideoInfoAsync(videoFile.file);
            setResult(videoInfo);
          }}
        >
          <Text style={{ fontSize: 15, fontWeight: "bold", color: "white" }}>
            Select Video with custom picker
          </Text>
        </Pressable>
        <Pressable
          style={{
            backgroundColor: "black",
            borderRadius: 20,
            padding: 20,
            borderCurve: "continuous",
          }}
          onPress={async () => {
            const videoInfo = await getVideoInfoAsync(
              "https://download.samplelib.com/mp4/sample-5s.mp4"
            );
            setResult(videoInfo);
          }}
        >
          <Text style={{ fontSize: 15, fontWeight: "bold", color: "white" }}>
            Load remote video
          </Text>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
});
