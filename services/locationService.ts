import * as Location from 'expo-location';
import { Alert } from 'react-native';

export interface LocationData {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

// 1. Gets the raw GPS coordinates
export const captureEvidenceLocation = async (): Promise<LocationData | null> => {
  try {
    const servicesEnabled = await Location.hasServicesEnabledAsync();
    if (!servicesEnabled) {
      Alert.alert(
        "Location Services Disabled",
        "Please enable device GPS/Location services to capture evidence location."
      );
      return null;
    }

    const { status } = await Location.requestForegroundPermissionsAsync();
    
    if (status !== 'granted') {
      Alert.alert(
        "Permission Denied",
        "Location permission is required to capture the evidence location."
      );
      return null;
    }

    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });

    return {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      accuracy: location.coords.accuracy,
    };

  } catch (error) {
    console.error("Failed to capture location:", error);
    Alert.alert("Location Error", "An error occurred while retrieving your location.");
    return null;
  }
};

// 2. NEW: Safely gets the street address without crashing on timeouts!
export const getReadableAddress = async (latitude: number, longitude: number): Promise<string> => {
  try {
    const geocode = await Location.reverseGeocodeAsync({ latitude, longitude });
    
    if (geocode && geocode.length > 0) {
      const address = geocode[0];
      // Format it nicely (e.g., "123 Main St, New York")
      const street = address.street || address.name || '';
      const city = address.city || address.subregion || '';
      
      if (street && city) return `${street}, ${city}`;
      if (city) return city;
    }
    
    // Fallback if google returns empty data
    return `Lat: ${latitude.toFixed(4)}, Lon: ${longitude.toFixed(4)}`;

  } catch (error) {
    // THIS STOPS THE APP FROM CRASHING WHEN THE EMULATOR TIMEOUTS
    console.warn('Reverse geocoding timed out. Using raw coordinates instead.');
    return `Lat: ${latitude.toFixed(4)}, Lon: ${longitude.toFixed(4)}`;
  }
};