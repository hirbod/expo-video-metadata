# expo-video-metadata

This React Native (Expo) library provides a versatile function designed to extract a wide range of metadata from video files, including duration, width, height, frame rate, codec, audio availability, orientation, audio channels, audio codec, and audio sample rate. For comprehensive details, please refer to the listed exported types. Although the library is equipped with web support, its performance is reliant on specific platform APIs, leading to potential variability in its effectiveness across different browsers.

<img src="https://raw.githubusercontent.com/hirbod/expo-video-metadata/assets/preview.png" width="500" />

# Installation in bare React Native projects

This package needs **Expo SDK 50** or **higher**, as it uses FileSystem APIs that were added in that version. This package adds native code to your project and does not work with Expo Go. Please use a custom dev client or build a standalone app. Works with Fabric. Needs RN 0.73+ (Java JDK 17)

For bare React Native projects, you must ensure that you have [installed and configured the `expo` package](https://docs.expo.dev/bare/installing-expo-modules/) before continuing (SDK 50+). This just adds ~150KB to your final app size and is the easiest way to get started and it works with and without Expo projects.

### Add the package to your npm dependencies

```
npx expo install expo-video-metadata
```

### Configure for iOS

Run `npx pod-install` after installing the npm package.

### Configure for Android

No additional set up necessary.

# API

```ts
import { getVideoInfoAsync } from 'expo-video-metadata';

/**
 * Retrieves video metadata.
 *
 * @param sourceFilename An URI of the video, local or remote. On web, it can be a File or Blob object, too. base64 URIs are supported but not recommended, as they can be very large and cause performance issues.
 * @param options Pass `headers` object in case `sourceFilename` is a remote URI, e.g { headers: "Authorization": "Bearer some-token" } etc.
 *
 * @return Returns a promise which fulfils with [`VideoInfoResult`](#Videoinforesult).
 */

const result = await getVideoInfoAsync(sourceFilename: string | File | Blob, options: VideoInfoOptions = {}): Promise<VideoInfoResult>
```

See [VideoInfoResult](https://github.com/hirbod/expo-video-metadata/blob/main/src/ExpoVideoMetadata.types.ts#L1) type for more information.

## Hints

If you're using libraries like expo-image-picker, make sure to use [preferredAssetRepresentationMode](https://docs.expo.dev/versions/latest/sdk/imagepicker/#imagepickeroptions) option like this:

```ts
preferredAssetRepresentationMode: ImagePicker
  .UIImagePickerPreferredAssetRepresentationMode.Current;
```

when picking a video. This will avoid the need to copy or transcode the video file and thus be a lot faster on iOS. If you use a different library, make sure to use the equivalent option. Location data is not supported with expo-image-picker, unless you set `legacy` to `true`.
