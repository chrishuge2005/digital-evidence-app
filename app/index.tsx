import { View, ActivityIndicator, StyleSheet } from 'react-native';

// This is essentially a fallback/splash.
// _layout.tsx will detect the state and immediately redirect correctly.
export default function Index() {
  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#007AFF" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F5F7FA' },
});