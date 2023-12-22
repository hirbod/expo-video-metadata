import { requireNativeViewManager } from 'expo-modules-core';
import * as React from 'react';

import { ExpoVideoMetadataViewProps } from './ExpoVideoMetadata.types';

const NativeView: React.ComponentType<ExpoVideoMetadataViewProps> =
  requireNativeViewManager('ExpoVideoMetadata');

export default function ExpoVideoMetadataView(props: ExpoVideoMetadataViewProps) {
  return <NativeView {...props} />;
}
