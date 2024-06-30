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
  mediaTypes?: "image" | "video" | "all";
  option?: ImagePicker.ImagePickerOptions;
};

export type FilePickerResolveValue = {
  file: File | string;
  type?: "video" | "image";
  size?: number;
};
const MAX_WIDTH_PIXEL = 10000;
const MAX_HEIGHT_PIXEL = 10000;

const MAX_FILE_PIXEL = MAX_WIDTH_PIXEL * MAX_HEIGHT_PIXEL;

export const pickFile = ({ mediaTypes = "all", option = {} }: Props) => {
  return new Promise<FilePickerResolveValue>(async (resolve, reject) => {
    if (Platform.OS === "web") {
      const input = document.createElement("input");
      input.type = "file";
      input.hidden = true;
      input.multiple = false;
      const accepts: string[] = [];
      if (mediaTypes === "all") {
        accepts.push("image/*");
        accepts.push("video/*");
      } else if (mediaTypes === "image") {
        accepts.push("image/*");
      } else if (mediaTypes === "video") {
        accepts.push("video/*");
      }

      input.accept = accepts.join(",");

      input.onchange = async (e) => {
        const files = (e.target as HTMLInputElement)?.files;
        const file = files ? files[0] : ({} as File);
        if (file) {
          const fileType = file.type.split("/")[0] as "image" | "video";
          if (fileType === "image") {
            const img = await getWebImageSize(file);
            if (img && img.width * img.height > MAX_FILE_PIXEL) {
              Alert.alert(
                "Your image exceeds the maximum allowed size of 100 megapixels. Please choose a smaller image and try again."
              );
              return;
            }
          }

          resolve({ file, type: fileType, size: file.size });
          input.remove();
        } else {
          reject(new Error("No file selected"));
          input.remove();
        }
      };
      document.body.appendChild(input);
      input.click();
    } else {
      if (Platform.OS === "ios") {
        const { status } =
          await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== "granted") {
          alert("Sorry, we need camera roll permissions to make this work!");
        }
      }

      try {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes:
            mediaTypes === "image"
              ? ImagePicker.MediaTypeOptions.Images
              : mediaTypes === "video"
                ? ImagePicker.MediaTypeOptions.Videos
                : ImagePicker.MediaTypeOptions.All,
          allowsMultipleSelection: false,
          quality: 1,
          preferredAssetRepresentationMode:
            ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
          base64: false,
          ...option,
        });
        if (result.canceled) return;
        const file = result.assets[0];
        if (file) {
          if (file.width * file.height > MAX_FILE_PIXEL) {
            Alert.alert(
              "Your image exceeds the maximum allowed size of 100 megapixels. Please choose a smaller image and try again."
            );
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
    }
  });
};

export const useFilePicker = () => {
  return pickFile;
};
