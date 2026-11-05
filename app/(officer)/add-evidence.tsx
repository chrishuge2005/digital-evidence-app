import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Alert,
  Image,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
} from 'react-native';

import { useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system'; // <-- ADDED FOR CACHE CLEANUP
import { Ionicons } from '@expo/vector-icons';

import { ScreenContainer } from '../../components/ScreenContainer';
import { PrimaryButton } from '../../components/PrimaryButton';

import { useAuth } from '../../contexts/AuthContext';

import { teamService } from '../../services/teamService';
import { localEvidenceService } from '../../services/localEvidenceService';
import { hashService } from '../../services/hashService';
import { custodyService } from '../../services/custodyService';
import { syncService } from '../../services/syncService';
import { getReadableAddress } from '../../services/locationService';

import {
  Evidence,
  EvidenceAttachment,
  HashStatus,
} from '../../types/evidence';

export default function AddEvidence() {
  const router = useRouter();
  const { user, profile } = useAuth();

  const [investigationTitle, setInvestigationTitle] = useState('');
  const [description, setDescription] = useState('');

  // Human-readable location/address
  const [location, setLocation] = useState('');

  // Exact GPS coordinates
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);

  // Automatic date/time
  const [capturedAt, setCapturedAt] = useState('');

  const [isLocating, setIsLocating] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<any[]>([]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadingText, setLoadingText] = useState('Save Evidence');

  useEffect(() => {
    initializeFormDefaults();
  }, []);

  const initializeFormDefaults = async () => {
    // Automatically capture current device date/time
    const now = new Date();
    setCapturedAt(now.toLocaleString());

    // Start location loading
    setIsLocating(true);

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();

      if (status !== 'granted') {
        Alert.alert(
          'Permission Denied',
          'Location access is required to tag evidence accurately.'
        );
        setLocation('Permission Denied');
        setLatitude(null);
        setLongitude(null);
        setIsLocating(false);
        return;
      }

      const currentLoc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });

      const currentLatitude = currentLoc.coords.latitude;
      const currentLongitude = currentLoc.coords.longitude;

      setLatitude(currentLatitude);
      setLongitude(currentLongitude);

      const readableAddress = await getReadableAddress(currentLatitude, currentLongitude);
      setLocation(readableAddress);

    } catch (error) {
      console.error('Location error:', error);
      Alert.alert(
        'Location Error',
        'Could not fetch device location. Please try again or enter the location manually.'
      );
      setLocation('Unavailable');
      setLatitude(null);
      setLongitude(null);
    } finally {
      setIsLocating(false);
    }
  };

  const handleSelectFiles = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          'image/*',
          'video/*',
          'application/pdf',
        ],
        copyToCacheDirectory: true,
        multiple: true,
      });

      if (
        !result.canceled &&
        result.assets &&
        result.assets.length > 0
      ) {
        const newFiles = result.assets
          .filter((file) => {
            const mimeType = file.mimeType || '';
            return (
              mimeType.startsWith('image/') ||
              mimeType.startsWith('video/') ||
              mimeType === 'application/pdf'
            );
          })
          .map((file) => {
            let fileType: 'image' | 'video' | 'pdf' = 'pdf';
            const mime = file.mimeType || '';

            if (mime.startsWith('image/')) {
              fileType = 'image';
            } else if (mime.startsWith('video/')) {
              fileType = 'video';
            }

            return {
              id: Math.random().toString(36).substring(7),
              uri: file.uri,
              name: file.name,
              type: mime,
              fileTypeCategory: fileType,
              size: file.size || 0,
            };
          });

        if (newFiles.length === 0) {
          Alert.alert(
            'Unsupported File',
            'Please select images, videos, or PDF documents.'
          );
          return;
        }

        setSelectedFiles((previousFiles) => [
          ...previousFiles,
          ...newFiles,
        ]);
      }
    } catch (error) {
      console.error('File selection error:', error);
      Alert.alert(
        'Selection Error',
        'An unexpected error occurred while accessing the file system.'
      );
    }
  };

  const handleRemoveFile = (idToRemove: string) => {
    Alert.alert(
      'Delete File',
      'Are you sure you want to remove this evidence file?',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setSelectedFiles((previousFiles) =>
              previousFiles.filter((file) => file.id !== idToRemove)
            );
          },
        },
      ]
    );
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (
      parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
    );
  };

  const handleSubmit = async () => {
    if (!user) {
      Alert.alert('Authentication Error', 'You must be logged in to register evidence.');
      return;
    }

    setIsSubmitting(true);
    setLoadingText('Verifying Team Assignment...');

    try {
      const teamInfo = await teamService.getOfficerTeam();

      if (!teamInfo || !teamInfo.id) {
        setIsSubmitting(false);
        Alert.alert(
          'Access Denied', 
          'You are not assigned to an active team. Evidence registration is restricted to authorized team members.'
        );
        return;
      }

      if (selectedFiles.length === 0) {
        setIsSubmitting(false);
        Alert.alert('Missing Evidence', 'Please select at least one evidence file.');
        return;
      }

      if (!investigationTitle || !description || !location) {
        setIsSubmitting(false);
        Alert.alert(
          'Missing Fields',
          'Please fill out Investigation Title, Description, and Location.'
        );
        return;
      }

      const newEvidenceId = localEvidenceService.generateEvidenceId();
      const currentTime = new Date().toISOString();
      const persistedAttachments: EvidenceAttachment[] = [];

      for (const file of selectedFiles) {
        setLoadingText(`Copying ${file.name}...`);
        const permanentUri = await localEvidenceService.copyFileToLocalEvidence(
          file.uri,
          newEvidenceId,
          file.name
        );

        setLoadingText(`Generating SHA-256 for ${file.name}...`);
        let calculatedHash: string | null = null;
        let hashStatus: HashStatus = 'NOT_CALCULATED';

        try {
          calculatedHash = await hashService.calculateSha256(permanentUri);
          hashStatus = 'CALCULATED';
        } catch (hashError) {
          console.error('Hash error:', hashError);
          hashStatus = 'FAILED';
        }

        const attachmentId = localEvidenceService.generateAttachmentId();

        persistedAttachments.push({
          id: attachmentId,
          attachmentId,
          evidenceId: newEvidenceId,
          originalName: file.name,
          mimeType: file.type || 'application/octet-stream',
          fileSize: file.size,
          localUri: permanentUri,
          storageFileId: null,
          sha256: calculatedHash || '',
          uploadStatus: 'LOCAL_ONLY',
          createdAt: currentTime,
          updatedAt: currentTime,
        });
      }

      setLoadingText('Saving Evidence Locally...');

      const evidencePayload: Evidence = {
        id: newEvidenceId,
        evidenceId: newEvidenceId,
        teamId: teamInfo.id,
        ownerId: user.id,
        created_by: user.id,
        assignedOfficerId: user.id,
        title: investigationTitle.trim(),
        description: description.trim(),
        category: 'Multi-Type',
        location: location.trim(),
        capturedAt: capturedAt.trim() || currentTime,
        status: 'ACTIVE',
        verificationStatus: 'PENDING',
        syncStatus: 'PENDING',
        createdAt: currentTime,
        updatedAt: currentTime,
      };

      await localEvidenceService.saveEvidenceLocally(
        evidencePayload,
        persistedAttachments
      );

      // --- RECORD EVIDENCE_REGISTERED CUSTODY EVENT ---
      const uploaderName = profile?.display_name || user.user_metadata?.display_name || 'Officer';
      const userRole = profile?.role === 'HIGHER_OFFICER' ? 'HIGHER_OFFICER' : 'OFFICER';

      await custodyService.createCustodyEvent({
        evidenceId: newEvidenceId,
        teamId: teamInfo.id,
        action: 'EVIDENCE_REGISTERED',
        performedByUserId: user.id,
        performedBy: uploaderName,
        role: userRole,
        status: 'SUCCESS',
        notes: `Evidence registered locally with ${persistedAttachments.length} attachment(s).`,
      });

      // --- Trigger immediate background sync attempt ---
      syncService.syncEvidenceItem(newEvidenceId).catch(err => console.log('Auto-sync deferred:', err));

      // ==========================================
      // THE FIX: Cleanup the temporary DocumentPicker files 
      // so your phone's storage doesn't fill up!
      // ==========================================
      for (const file of selectedFiles) {
        try {
          await FileSystem.deleteAsync(file.uri, { idempotent: true });
        } catch (cleanupError) {
          console.log('Could not clean up cached file:', cleanupError);
        }
      }

      // Reset form
      setInvestigationTitle('');
      setDescription('');
      setLocation('');
      setLatitude(null);
      setLongitude(null);
      setSelectedFiles([]);
      setCapturedAt('');

      await initializeFormDefaults();

      Alert.alert(
        'Success',
        'Evidence registered and cryptographic fingerprints generated.',
        [
          {
            text: 'OK',
            onPress: () => router.back(),
          },
        ]
      );
    } catch (error: any) {
      console.error('UPLOAD ERROR:', error);
      Alert.alert(
        'Registration Failed',
        `Reason: ${error?.message || 'An unexpected error occurred.'}`
      );
    } finally {
      setIsSubmitting(false);
      setLoadingText('Save Evidence');
    }
  };

  const images = selectedFiles.filter((file) => file.fileTypeCategory === 'image');
  const videos = selectedFiles.filter((file) => file.fileTypeCategory === 'video');
  const documents = selectedFiles.filter((file) => file.fileTypeCategory === 'pdf');

  const renderFileGroup = (
    categoryTitle: string,
    files: any[],
    iconName: any
  ) => {
    if (files.length === 0) return null;

    return (
      <View style={styles.groupContainer}>
        <Text style={styles.groupTitle}>
          {categoryTitle} ({files.length})
        </Text>

        {files.map((file) => (
          <View key={file.id} style={styles.fileItem}>
            {file.fileTypeCategory === 'image' ? (
              <Image source={{ uri: file.uri }} style={styles.thumbnail} />
            ) : (
              <View style={styles.iconThumbnail}>
                <Ionicons name={iconName} size={24} color="#64748B" />
              </View>
            )}

            <View style={styles.fileInfo}>
              <Text style={styles.fileName} numberOfLines={1}>
                {file.name}
              </Text>
              <Text style={styles.fileMeta}>
                {file.type || 'File'} • {formatFileSize(file.size)}
              </Text>
            </View>

            <TouchableOpacity
              style={styles.deleteButton}
              onPress={() => handleRemoveFile(file.id)}
              disabled={isSubmitting}
            >
              <Ionicons name="trash-outline" size={18} color="#FFFFFF" />
              <Text style={styles.deleteButtonText}>Delete</Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>
    );
  };

  return (
    <ScreenContainer>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>Add Evidence</Text>

        <View style={styles.uploadSection}>
          <PrimaryButton
            title="Select Evidence Files"
            onPress={handleSelectFiles}
            disabled={isSubmitting}
          />
          <Text style={styles.helperText}>
            Select photos, videos, or documents to secure locally.
          </Text>
        </View>

        {renderFileGroup('Photographic Evidence', images, 'image')}
        {renderFileGroup('Video Footage', videos, 'videocam')}
        {renderFileGroup('Document Files', documents, 'document-text')}

        <Text style={styles.label}>Investigation Title / ID *</Text>
        <View style={styles.inputWrapper}>
          <TextInput
            style={styles.textInput}
            placeholder="e.g. Operation Alpha - Sector 4"
            placeholderTextColor="#888"
            value={investigationTitle}
            onChangeText={setInvestigationTitle}
            editable={!isSubmitting}
          />
        </View>

        <Text style={styles.label}>GPS Location</Text>
        <View style={styles.locationContainer}>
          <View style={[styles.inputWrapper, { flex: 1, marginBottom: 0 }]}>
            <TextInput
              style={styles.textInput}
              placeholder={isLocating ? 'Getting location...' : 'Location'}
              placeholderTextColor="#888"
              value={location}
              onChangeText={setLocation}
              editable={!isSubmitting}
            />
          </View>

          <TouchableOpacity
            style={styles.locationButton}
            onPress={initializeFormDefaults}
            disabled={isLocating || isSubmitting}
          >
            {isLocating ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Ionicons name="location" size={24} color="#FFFFFF" />
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.coordinatesContainer}>
          <View style={styles.coordinateBox}>
            <Text style={styles.coordinateLabel}>Latitude</Text>
            <Text style={styles.coordinateValue}>
              {latitude !== null ? latitude.toFixed(6) : 'Getting...'}
            </Text>
          </View>

          <View style={styles.coordinateBox}>
            <Text style={styles.coordinateLabel}>Longitude</Text>
            <Text style={styles.coordinateValue}>
              {longitude !== null ? longitude.toFixed(6) : 'Getting...'}
            </Text>
          </View>
        </View>

        <Text style={styles.label}>Captured Date/Time</Text>
        <View style={styles.inputWrapper}>
          <TextInput
            style={styles.textInput}
            value={capturedAt}
            placeholder="Getting device time..."
            placeholderTextColor="#888"
            editable={false}
          />
        </View>

        <Text style={styles.label}>Description & Notes</Text>
        <View style={[styles.inputWrapper, { height: 90 }]}>
          <TextInput
            style={[styles.textInput, { height: 90, textAlignVertical: 'top' }]}
            placeholder="Enter detailed notes..."
            placeholderTextColor="#888"
            value={description}
            onChangeText={setDescription}
            multiline
            editable={!isSubmitting}
          />
        </View>

        <PrimaryButton
          title={isSubmitting ? loadingText : 'Save Evidence'}
          onPress={handleSubmit}
          disabled={isSubmitting}
          style={{ marginTop: 10, marginBottom: 30 }}
        />
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  scrollContent: { paddingHorizontal: 20, paddingBottom: 20 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#333', marginBottom: 20 },
  uploadSection: { marginBottom: 20 },
  helperText: { color: '#666', fontSize: 12, textAlign: 'center', marginTop: 8 },
  groupContainer: { marginBottom: 20, backgroundColor: '#F0F4F8', padding: 12, borderRadius: 10, borderWidth: 1, borderColor: '#DDD' },
  groupTitle: { color: '#333', fontSize: 14, fontWeight: 'bold', marginBottom: 10, borderBottomWidth: 1, borderBottomColor: '#DDD', paddingBottom: 6 },
  fileItem: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, backgroundColor: '#FFF', padding: 8, borderRadius: 8, borderWidth: 1, borderColor: '#E2E8F0' },
  thumbnail: { width: 55, height: 55, borderRadius: 8, backgroundColor: '#000' },
  iconThumbnail: { width: 55, height: 55, borderRadius: 8, backgroundColor: '#F8FAFC', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#CBD5E1' },
  fileInfo: { flex: 1, marginLeft: 10, marginRight: 8 },
  fileName: { color: '#333', fontSize: 13, fontWeight: '600' },
  fileMeta: { color: '#007AFF', fontSize: 11, marginTop: 4 },
  deleteButton: { backgroundColor: '#DC2626', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10, height: 38, borderRadius: 7, gap: 5 },
  deleteButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  label: { fontSize: 14, fontWeight: '600', color: '#333', marginBottom: 6, marginTop: 12 },
  inputWrapper: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#DDD', borderRadius: 8, paddingHorizontal: 12, justifyContent: 'center', marginBottom: 16 },
  textInput: { fontSize: 16, color: '#333', paddingVertical: 12 },
  locationContainer: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  locationButton: { backgroundColor: '#007AFF', height: 50, width: 50, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  coordinatesContainer: { flexDirection: 'row', gap: 10, marginBottom: 4 },
  coordinateBox: { flex: 1, backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  coordinateLabel: { fontSize: 11, color: '#64748B', marginBottom: 4 },
  coordinateValue: { fontSize: 13, color: '#333', fontWeight: '600' },
});