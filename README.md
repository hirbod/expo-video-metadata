# expo-video-metadata

Provides a function that let you get some metadata from video files, like the duration, width, height, fps, codec, hasAudio, orientation, audioChannels, audioCodec, audioSampleRate etc. Check the exported types for more information. Web support is not available yet but it is planned.

<video src="https://github.com/hirbod/expo-video-metadata/raw/assets/preview.mp4" width="500" height="200" playsinline muted autoplay></video>

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
 * @param sourceFilename An URI of the video, local or remote.
 * @param options Pass `headers` object in case `sourceFilename` is a remote URI, e.g { headers: "Authorization": "Bearer some-token" } etc.
 *
 * @return Returns a promise which fulfils with [`VideoInfoResult`](#Videoinforesult).
 */

const result = await getVideoInfoAsync(
  sourceFilename: string,
  options: VideoInfoOptions = {},
): Promise<VideoInfoResult> {
  return await ExpoVideoMetadataModule.getVideoInfo(sourceFilename, options);
}
```

See [VideoInfoResult](https://github.com/hirbod/expo-video-metadata/blob/b9239224eed46f455b2fb9f1b29e69ac49da6683/src/ExpoVideoMetadata.types.ts#L1) type for more information.
