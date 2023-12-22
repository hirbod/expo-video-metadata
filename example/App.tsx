import { StyleSheet, Text, View } from 'react-native';

import * as ExpoVideoMetadata from 'expo-video-metadata';

export default function App() {
  return (
    <View style={styles.container}>
      <Text>{ExpoVideoMetadata.hello()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
