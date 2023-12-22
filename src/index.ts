import { NativeModulesProxy, EventEmitter, Subscription } from 'expo-modules-core';

// Import the native module. On web, it will be resolved to ExpoVideoMetadata.web.ts
// and on native platforms to ExpoVideoMetadata.ts
import ExpoVideoMetadataModule from './ExpoVideoMetadataModule';
import ExpoVideoMetadataView from './ExpoVideoMetadataView';
import { ChangeEventPayload, ExpoVideoMetadataViewProps } from './ExpoVideoMetadata.types';

// Get the native constant value.
export const PI = ExpoVideoMetadataModule.PI;

export function hello(): string {
  return ExpoVideoMetadataModule.hello();
}

export async function setValueAsync(value: string) {
  return await ExpoVideoMetadataModule.setValueAsync(value);
}

const emitter = new EventEmitter(ExpoVideoMetadataModule ?? NativeModulesProxy.ExpoVideoMetadata);

export function addChangeListener(listener: (event: ChangeEventPayload) => void): Subscription {
  return emitter.addListener<ChangeEventPayload>('onChange', listener);
}

export { ExpoVideoMetadataView, ExpoVideoMetadataViewProps, ChangeEventPayload };
