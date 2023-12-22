import * as React from 'react';

import { ExpoVideoMetadataViewProps } from './ExpoVideoMetadata.types';

export default function ExpoVideoMetadataView(props: ExpoVideoMetadataViewProps) {
  return (
    <div>
      <span>{props.name}</span>
    </div>
  );
}
