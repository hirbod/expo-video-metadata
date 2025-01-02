import * as ImagePicker from "expo-image-picker";
import { Platform, Alert } from "react-native";

const getWebImageSize = (file: File) => {
  const img = new Image();
  img.src = window.URL.createObjectURL(file);
  const promise = new Promise<
    { width: number; height: number } | null | undefined
  >((resolve, reject) => {
    img.onload = () => {
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      resolve({ width, height });
    };
    img.onerror = reject;
  });
  return promise;
};

type Props = {
  mediaTypes?: ImagePicker.MediaType
  option?: ImagePicker.ImagePickerOptions;
};

export type FilePickerResolveValue =
  | {
      file: File | string;
      type?: ImagePicker.ImagePickerAsset['type'];
      size?: number;
    }
  | Array<{
      file: File | string;
      type?: ImagePicker.ImagePickerAsset['type'];
      size?: number;
    }>;

const MAX_WIDTH_PIXEL = 10000;
const MAX_HEIGHT_PIXEL = 10000;

const MAX_FILE_PIXEL = MAX_WIDTH_PIXEL * MAX_HEIGHT_PIXEL;

export const pickFile = ({ mediaTypes, option = {} }: Props) => {
  return new Promise<FilePickerResolveValue>((resolve, reject) => {
    if (Platform.OS === "web") {
      const input = document.createElement("input");
      input.type = "file";
      input.hidden = true;
      input.multiple = true;
      const accepts: string[] = [];

      accepts.push("*/*");
      input.accept = accepts.join(",");

      input.onchange = (e) => {
        const files = (e.target as HTMLInputElement)?.files;

        if (files && files.length > 0) {
          const processFiles = async () => {
            const results: Array<{ file: File; type: "image" | "video"; size: number }> = [];

            for (const file of Array.from(files)) {
              const fileType = file.type.split("/")[0] as "image" | "video";

              if (fileType === "image") {
                const img = await getWebImageSize(file);
                if (img && img.width * img.height > MAX_FILE_PIXEL) {
                  Alert.alert(
                    "One or more images exceed the maximum allowed size of 100 megapixels. Please choose smaller images and try again."
                  );
                  reject(new Error("Image exceeds maximum pixel size"));
                  input.remove();
                  return;
                }
              }

              results.push({ file, type: fileType, size: file.size });
            }

            resolve(results); // Resolving an array of results
            input.remove();
          };

          processFiles().catch(reject);
        } else {
          reject(new Error("No file selected"));
          input.remove();
        }
      };

      document.body.appendChild(input);
      input.click();
    } else {
      const handleNativePicker = async () => {
        if (Platform.OS === "ios") {
          const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (status !== "granted") {
            Alert.alert("Sorry, we need camera roll permissions to make this work!");
            reject(new Error("Permissions not granted"));
            return;
          }
        }

        try {
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes:
              mediaTypes === "images"
                ? "images"
                : mediaTypes === "videos"
                  ? "videos"
                  : undefined,
            allowsMultipleSelection: false,
            quality: 1,
            preferredAssetRepresentationMode:
              ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
            base64: false,
            ...option,
          });

          if (result.canceled) {
            reject(new Error("Selection canceled"));
            return;
          }

          const file = result.assets[0];
          if (file) {
            if (file.width * file.height > MAX_FILE_PIXEL) {
              Alert.alert(
                "Your image exceeds the maximum allowed size of 100 megapixels. Please choose a smaller image and try again."
              );
              reject(new Error("Image exceeds maximum pixel size"));
              return;
            }

            resolve({ file: file.uri, type: file.type, size: file.fileSize });
          } else {
            reject(new Error("No file selected"));
          }
        } catch (error) {
          reject(error);
          console.error(error);
        }
      };

      handleNativePicker().catch(reject);
    }
  });
};


export const useFilePicker = () => {
  return pickFile;
};
