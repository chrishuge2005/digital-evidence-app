import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, Alert, ActivityIndicator, StyleSheet, RefreshControl, TouchableOpacity } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { ScreenContainer } from '../../components/ScreenContainer';
import { PrimaryButton } from '../../components/PrimaryButton';
import { notificationService, AppNotification } from '../../services/notificationService';
import { transferService } from '../../services/transferService';
import { invitationService, PendingOfficerInvitation } from '../../services/invitationService';
import { useAuth } from '../../contexts/AuthContext';
import { safeFormatDate } from '../../utils/dateUtils';
import { Ionicons } from '@expo/vector-icons';

export default function NotificationsScreen() {
  const router = useRouter();
  const { refreshProfile } = useAuth();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<PendingOfficerInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      loadAllData();
    }, [])
  );

  const loadAllData = async () => {
    try {
      const [notifsData, invitesData] = await Promise.all([
        notificationService.getMyNotifications(),
        invitationService.getMyPendingInvitations(),
      ]);
      setNotifications(notifsData || []);
      setPendingInvitations(invitesData || []);
    } catch (err: any) {
      console.warn('Failed to load notifications/invitations:', err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadAllData();
  }, []);

  const handleTransferAction = async (item: AppNotification, action: 'ACCEPT' | 'REJECT') => {
    if (!item.transfer_request_id || !item.evidence_id) return;

    const isAccept = action === 'ACCEPT';
    const actionLabel = isAccept ? 'Accept Transfer' : 'Reject Transfer';
    const message = isAccept
      ? `Accept custody transfer of evidence ${item.evidence_id}? You will become the current custodian.`
      : `Reject custody transfer of evidence ${item.evidence_id}?`;

    Alert.alert(actionLabel, message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: isAccept ? 'Accept' : 'Reject',
        style: isAccept ? 'default' : 'destructive',
        onPress: async () => {
          setProcessingId(item.id);
          try {
            await notificationService.markAsRead(item.id);
            if (isAccept) {
              await transferService.acceptTransferRequest(item.transfer_request_id!, item.evidence_id!);
              Alert.alert('Transfer Accepted', `You have taken custody of evidence ${item.evidence_id}.`);
            } else {
              await transferService.rejectTransferRequest(item.transfer_request_id!, item.evidence_id!);
              Alert.alert('Transfer Rejected', `Evidence ${item.evidence_id} transfer was rejected.`);
            }
            await loadAllData();
          } catch (err: any) {
            Alert.alert('Action Error', err.message || 'Failed to process transfer action.');
          } finally {
            setProcessingId(null);
          }
        },
      },
    ]);
  };

  const handleAcceptInvitation = async (invitationId: string, teamName: string) => {
    Alert.alert(
      'Join Department Team',
      `Accept official invitation to join ${teamName}? You will be assigned to this department as an authorized Officer.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Accept Invitation',
          onPress: async () => {
            setProcessingId(invitationId);
            try {
              const res = await invitationService.acceptInvitationById(invitationId);
              await refreshProfile();
              Alert.alert('Team Membership Activated', res.message || `You are now an active member of ${teamName}.`, [
                {
                  text: 'Go to Dashboard',
                  onPress: () => router.replace('/(officer)/dashboard'),
                },
              ]);
              await loadAllData();
            } catch (err: any) {
              Alert.alert('Acceptance Error', err.message || 'Failed to accept department invitation.');
            } finally {
              setProcessingId(null);
            }
          },
        },
      ]
    );
  };

  const renderInvitationBanner = (inv: PendingOfficerInvitation) => {
    const isProcessing = processingId === inv.id;
    return (
      <View key={inv.id} style={styles.inviteBannerCard}>
        <View style={styles.cardHeader}>
          <View style={styles.inviteBadgeRow}>
            <View style={styles.inviteBadge}>
              <Text style={styles.inviteBadgeText}>TEAM INVITATION</Text>
            </View>
            <View style={styles.unreadDot} />
          </View>
          <Text style={styles.expiryText}>Expires: {safeFormatDate(inv.expires_at)}</Text>
        </View>

        <Text style={styles.inviteTitle}>Official Invitation: {inv.team_name}</Text>
        <Text style={styles.inviteMessage}>
          {inv.invited_by_name} has invited you to join <Text style={{ fontWeight: 'bold' }}>{inv.team_name}</Text> ({inv.team_code}) as an authorized Officer.
        </Text>

        <View style={styles.actionRow}>
          <PrimaryButton
            title={isProcessing ? 'Joining Team...' : 'Accept Invitation'}
            onPress={() => handleAcceptInvitation(inv.id, inv.team_name)}
            disabled={isProcessing}
            style={[styles.actionBtn, styles.acceptBtn]}
          />
        </View>
      </View>
    );
  };

  const renderItem = ({ item }: { item: AppNotification }) => {
    const isProcessing = processingId === item.id;
    const isTransferRequest = item.type === 'TRANSFER_REQUEST' && !item.is_read;
    const isTeamInviteNotification = item.type === 'TEAM_INVITATION';

    return (
      <View style={[styles.card, item.is_read && styles.readCard]}>
        <View style={styles.cardHeader}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={styles.cardTitle}>{item.title}</Text>
            {isTeamInviteNotification && (
              <View style={[styles.inviteBadge, { marginLeft: 8 }]}>
                <Text style={styles.inviteBadgeText}>INVITATION</Text>
              </View>
            )}
          </View>
          {item.is_read ? (
            <Text style={styles.readBadge}>Read</Text>
          ) : (
            <View style={styles.unreadDot} />
          )}
        </View>

        <Text style={styles.messageText}>{item.message}</Text>

        {item.evidence_id && (
          <Text style={styles.evidenceRef}>Evidence ID: {item.evidence_id}</Text>
        )}

        <Text style={styles.dateText}>{safeFormatDate(item.created_at)}</Text>

        {/* Transfer Action Row */}
        {isTransferRequest && (
          <View style={styles.actionRow}>
            <PrimaryButton
              title={isProcessing ? 'Processing...' : 'Accept'}
              onPress={() => handleTransferAction(item, 'ACCEPT')}
              disabled={isProcessing}
              style={[styles.actionBtn, styles.acceptBtn]}
            />
            <PrimaryButton
              title={isProcessing ? 'Processing...' : 'Reject'}
              onPress={() => handleTransferAction(item, 'REJECT')}
              disabled={isProcessing}
              style={[styles.actionBtn, styles.rejectBtn]}
            />
          </View>
        )}

        {/* In-App Invitation Action Row */}
        {isTeamInviteNotification && !item.is_read && item.invitation_id && (
          <View style={styles.actionRow}>
            <PrimaryButton
              title={isProcessing ? 'Joining...' : 'Accept Invitation'}
              onPress={() => handleAcceptInvitation(item.invitation_id!, item.title)}
              disabled={isProcessing}
              style={[styles.actionBtn, styles.acceptBtn]}
            />
          </View>
        )}
      </View>
    );
  };

  const totalActionableCount = pendingInvitations.length + notifications.filter(n => !n.is_read).length;

  return (
    <ScreenContainer>
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.title}>Notifications</Text>
            <Text style={styles.subtitle}>System alerts, invitations, and transfer requests</Text>
          </View>
          {totalActionableCount > 0 && (
            <View style={styles.totalBadge}>
              <Text style={styles.totalBadgeText}>{totalActionableCount} pending</Text>
            </View>
          )}
        </View>

        {loading && !refreshing ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={styles.loadingText}>Loading notifications & invitations...</Text>
          </View>
        ) : notifications.length === 0 && pendingInvitations.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="notifications-off-outline" size={48} color="#94A3B8" style={{ marginBottom: 12 }} />
            <Text style={styles.emptyTitle}>No Notifications</Text>
            <Text style={styles.emptySubtext}>You have no pending invitations or transfer requests.</Text>
          </View>
        ) : (
          <FlatList
            data={notifications}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            ListHeaderComponent={
              pendingInvitations.length > 0 ? (
                <View style={styles.invitationsHeaderContainer}>
                  <Text style={styles.sectionHeaderTitle}>
                    Pending Team Invitations ({pendingInvitations.length})
                  </Text>
                  {pendingInvitations.map(renderInvitationBanner)}
                  {notifications.length > 0 && (
                    <Text style={[styles.sectionHeaderTitle, { marginTop: 16 }]}>
                      General Notifications ({notifications.length})
                    </Text>
                  )}
                </View>
              ) : null
            }
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            removeClippedSubviews={true}
            windowSize={5}
            maxToRenderPerBatch={10}
            initialNumToRender={10}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          />
        )}
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#1E293B', marginBottom: 2 },
  subtitle: { fontSize: 13, color: '#64748B' },
  totalBadge: { backgroundColor: '#007AFF', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  totalBadgeText: { color: '#FFF', fontSize: 12, fontWeight: 'bold' },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 10, color: '#64748B', fontSize: 14 },
  listContent: { paddingBottom: 24 },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20, marginTop: 40 },
  emptyTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B', marginBottom: 4 },
  emptySubtext: { fontSize: 14, color: '#64748B', textAlign: 'center' },
  sectionHeaderTitle: { fontSize: 14, fontWeight: 'bold', color: '#475569', marginBottom: 10, letterSpacing: 0.5 },
  invitationsHeaderContainer: { marginBottom: 12 },
  inviteBannerCard: {
    backgroundColor: '#EFF6FF',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#3B82F6',
    marginBottom: 12,
    elevation: 2,
    shadowColor: '#3B82F6',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  inviteBadgeRow: { flexDirection: 'row', alignItems: 'center' },
  inviteBadge: { backgroundColor: '#DBEAFE', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 },
  inviteBadgeText: { color: '#1D4ED8', fontSize: 10, fontWeight: 'bold', letterSpacing: 0.5 },
  expiryText: { fontSize: 11, color: '#64748B' },
  inviteTitle: { fontSize: 16, fontWeight: 'bold', color: '#1E3A8A', marginTop: 8, marginBottom: 4 },
  inviteMessage: { fontSize: 13, color: '#1E293B', lineHeight: 18, marginBottom: 8 },
  card: {
    backgroundColor: '#FFF',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: 12,
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
  },
  readCard: {
    opacity: 0.7,
    backgroundColor: '#F8FAFC',
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  cardTitle: { fontSize: 15, fontWeight: 'bold', color: '#1E293B' },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#007AFF', marginLeft: 6 },
  readBadge: { fontSize: 11, color: '#94A3B8' },
  messageText: { fontSize: 13, color: '#334155', marginBottom: 8, lineHeight: 18 },
  evidenceRef: { fontSize: 11, color: '#007AFF', fontFamily: 'monospace', marginBottom: 4 },
  dateText: { fontSize: 11, color: '#94A3B8' },
  actionRow: { flexDirection: 'row', gap: 10, marginTop: 10 },
  actionBtn: { flex: 1, paddingVertical: 10, borderRadius: 8 },
  acceptBtn: { backgroundColor: '#16A34A' },
  rejectBtn: { backgroundColor: '#DC2626' },
});
