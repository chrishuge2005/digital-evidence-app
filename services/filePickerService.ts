import * as DocumentPicker from 'expo-document-picker';
import { Alert } from 'react-native';

export const pickEvidenceFiles = async () => {
  try {
    const result = await DocumentPicker.getDocumentAsync({
      type: [
        'image/jpeg',
        'image/png',
        'image/webp',
        'video/mp4',
        'video/quicktime',
        'application/pdf'
      ],
      multiple: true,
      // CRITICAL: Copies file to app-private cache so Expo FileSystem can read it for SHA-256
      copyToCacheDirectory: true, 
    });

    if (result.canceled) {
      return null; // Handled gracefully, no crash
    }

    return result.assets;
  } catch (error) {
    console.error("Document picker error:", error);
    Alert.alert("Selection Failed", "An error occurred while opening the file picker.");
    return null;
  }
};