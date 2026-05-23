# expo-video-metadata

Video metadata for Expo apps, powered by [Mediabunny](https://mediabunny.dev) on iOS, Android, and web.

This package reads duration, dimensions, frame rate, codecs, audio track info, orientation, HDR, aspect ratio, file size, and location metadata when the file contains it.

It is currently maintained against **Expo SDK 56**.

<img src="https://raw.githubusercontent.com/hirbod/expo-video-metadata/assets/preview_2026_mediabunny.png" width="800" />

## Install

```sh
npx expo install expo-video-metadata
```

This package does not ship custom native code. It uses Mediabunny for parsing and `expo-file-system` for efficient local file reads on iOS and Android.

For bare React Native apps, install and configure Expo modules first:

https://docs.expo.dev/bare/installing-expo-modules/

## Platform Notes

### iOS and Android

iOS and Android use Mediabunny through a small `expo-file-system` source adapter. Local `file://` and `content://` videos are read with byte-range file handle reads, so large videos do not need to be loaded fully into memory.

Remote URLs are read through Mediabunny's URL source. Request headers can be passed through the `headers` option.

On iOS, picking videos with `expo-image-picker` is fastest when you keep the original asset representation:

```ts
preferredAssetRepresentationMode:
  ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current
```

That avoids unnecessary copying or transcoding before metadata is read.

### Web

Web uses the same Mediabunny parser. It parses the media file in the browser instead of relying on `<video>` metadata events, which keeps the result shape aligned with iOS and Android for codecs, audio channels, audio sample rate, rotation, HDR, frame rate, and metadata tags.

Local web sources can be passed as `File`, `Blob`, `blob:` URLs, or `data:` URLs.

Remote web sources are read with `fetch`, so browser rules apply:

- The server must allow CORS, for example with `Access-Control-Allow-Origin`.
- The server should support byte-range requests with `Accept-Ranges: bytes`.
- If the video needs auth, pass headers through `VideoInfoOptions`.

If a remote URL works on iOS or Android but fails on web, it is usually a CORS issue. Native networking is not subject to browser CORS.

## Usage

```ts
import { getVideoInfoAsync } from "expo-video-metadata";

const info = await getVideoInfoAsync(videoUri);
```

With headers for a remote file:

```ts
const info = await getVideoInfoAsync("https://example.com/video.mp4", {
  headers: {
    Authorization: "Bearer token",
  },
});
```

On web, you can also pass a `File` or `Blob`:

```ts
const info = await getVideoInfoAsync(file);
```

## API

```ts
getVideoInfoAsync(
  source: string | File | Blob,
  options?: {
    headers?: Record<string, string>;
  }
): Promise<VideoInfoResult>
```

`source` can be:

- a local `file://` or `content://` URI on iOS and Android
- a remote URL
- a `File` or `Blob` on web
- a `blob:` or `data:` URL on web

Base64/data URLs work on web, but they are not ideal for large videos.

## Result

```ts
type VideoInfoResult = {
  duration: number;
  hasAudio: boolean;
  isHDR: boolean | null;
  width: number;
  height: number;
  fps: number;
  bitRate: number;
  fileSize: number;
  codec: string;
  orientation:
    | "Portrait"
    | "PortraitUpsideDown"
    | "Landscape"
    | "LandscapeRight"
    | "LandscapeLeft";
  naturalOrientation: "Portrait" | "Landscape";
  aspectRatio: number;
  is16_9: boolean;
  audioSampleRate: number;
  audioChannels: number;
  audioCodec: string;
  location: {
    latitude: number;
    longitude: number;
    altitude?: number;
  } | null;
};
```

Some fields depend on what the file actually exposes. For example, location metadata is only returned when the video contains a readable GPS tag.

## Example With Expo Image Picker

```ts
import * as ImagePicker from "expo-image-picker";
import { getVideoInfoAsync } from "expo-video-metadata";

const result = await ImagePicker.launchImageLibraryAsync({
  mediaTypes: "videos",
  base64: false,
  exif: true,
  legacy: false,
  videoQuality: ImagePicker.UIImagePickerControllerQualityType.High,
  preferredAssetRepresentationMode:
    ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
});

if (!result.canceled) {
  const info = await getVideoInfoAsync(result.assets[0].uri);
  console.log(info);
}
```

`expo-image-picker` may not expose location data unless `legacy` is enabled, even when the original video contains it.
