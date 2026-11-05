import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Alert,
  ActivityIndicator,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Pressable,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { ScreenContainer } from '../../components/ScreenContainer';
import { PrimaryButton } from '../../components/PrimaryButton';
import { teamService, TeamMemberWithProfile } from '../../services/teamService';
import { invitationService, OfficerInvitationRecord } from '../../services/invitationService';

export default function HOTeamScreen() {
  const router = useRouter();
  const [team, setTeam] = useState<{ id: string; name: string; team_code: string } | null>(null);
  const [members, setMembers] = useState<TeamMemberWithProfile[]>([]);
  const [invitations, setInvitations] = useState<OfficerInvitationRecord[]>([]);
  
  // Loading & Refreshing States
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);

  // Form State: Create Team (fallback when Higher Officer has no team yet)
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamCode, setNewTeamCode] = useState('');

  // Form State: Invite Officer (Only Name & Email)
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');

  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ACTIVE');

  useFocusEffect(
    React.useCallback(() => {
      fetchTeamData();
    }, [])
  );

  const fetchTeamData = async () => {
    try {
      const currentTeam = await teamService.getMyTeamHO();
      setTeam(currentTeam);

      if (currentTeam) {
        const [teamMembers, teamInvites] = await Promise.all([
          teamService.getTeamMembers(currentTeam.id),
          invitationService.getTeamInvitations(currentTeam.id),
        ]);
        setMembers(teamMembers);
        setInvitations(teamInvites);
      } else {
        setMembers([]);
        setInvitations([]);
      }
    } catch (error: any) {
      console.error('Error fetching team data:', error.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = () => {
    setRefreshing(true);
    fetchTeamData();
  };

  const handleCreateTeam = async () => {
    if (!newTeamName.trim() || !newTeamCode.trim()) {
      Alert.alert('Missing Fields', 'Please enter both the Department Name and Team Code.');
      return;
    }

    try {
      setCreatingTeam(true);
      const created = await teamService.createTeam(newTeamName.trim(), newTeamCode.trim().toUpperCase());
      if (created) {
        Alert.alert('Department Created', `Department "${created.name}" (${created.team_code}) has been registered.`);
        setNewTeamName('');
        setNewTeamCode('');
        await fetchTeamData();
      }
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to create department team.');
    } finally {
      setCreatingTeam(false);
    }
  };

  const handleInviteOfficer = async () => {
    if (!team) {
      Alert.alert('No Team', 'You must create or be assigned to a department team first.');
      return;
    }

    const cleanEmail = inviteEmail.trim().toLowerCase();
    const cleanName = inviteName.trim();

    if (!cleanName) {
      Alert.alert('Missing Name', "Please enter the officer's full name.");
      return;
    }

    if (cleanName.length > 100) {
      Alert.alert('Name Too Long', 'Officer full name must be 100 characters or less.');
      return;
    }

    const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    if (!cleanEmail || !emailRegex.test(cleanEmail)) {
      Alert.alert('Invalid Email', 'Please enter a valid officer email address (e.g. officer@department.gov).');
      return;
    }

    setSubmitting(true);
    try {
      const result = await invitationService.sendOfficerInvitation({
        teamId: team.id,
        email: cleanEmail,
        displayName: cleanName,
      });

      Alert.alert('Invitation Sent', result.message || `Official invitation email dispatched to ${cleanEmail}.`);
      setInviteName('');
      setInviteEmail('');
      setShowInviteModal(false);

      // Refresh team invitations and members
      await fetchTeamData();
    } catch (error: any) {
      Alert.alert('Invitation Failed', error.message || 'Failed to dispatch officer invitation.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevokeInvitation = (invitationId: string, officerEmail: string) => {
    Alert.alert(
      'Revoke Invitation?',
      `Are you sure you want to revoke the pending invitation for "${officerEmail}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: async () => {
            try {
              setLoading(true);
              await invitationService.revokeInvitation(invitationId);
              Alert.alert('Invitation Revoked', `The invitation for ${officerEmail} has been cancelled.`);
              await fetchTeamData();
            } catch (err: any) {
              Alert.alert('Error', err.message || 'Failed to revoke invitation.');
            } finally {
              setLoading(false);
            }
          },
        },
      ]
    );
  };

  const handleDeactivateMember = (userId: string, officerName: string) => {
    if (!team) return;

    Alert.alert(
      'Deactivate Officer?',
      `Are you sure you want to deactivate ${officerName}? The officer's custody history and recorded evidence will be preserved for compliance.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Deactivate',
          style: 'destructive',
          onPress: async () => {
            try {
              setLoading(true);
              await teamService.deactivateOfficer(team.id, userId, 'Deactivated by supervising Higher Officer');
              Alert.alert('Officer Deactivated', `${officerName} has been deactivated from the team.`);
              const updatedMembers = await teamService.getTeamMembers(team.id);
              setMembers(updatedMembers);
            } catch (err: any) {
              Alert.alert('Error', err.message || 'Failed to deactivate officer.');
            } finally {
              setLoading(false);
            }
          },
        },
      ]
    );
  };

  // Filter members based on search and status tab
  const filteredMembers = members.filter((item) => {
    const profile = Array.isArray(item.profiles) ? item.profiles[0] : item.profiles;
    const name = (profile?.display_name || '').toLowerCase();
    const email = (profile?.email || '').toLowerCase();
    const badge = (profile?.badge_number || '').toLowerCase();
    const query = searchQuery.trim().toLowerCase();

    const matchesSearch = !query || name.includes(query) || email.includes(query) || badge.includes(query);
    const matchesStatus = statusFilter === 'ALL' || item.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const activeCount = members.filter((m) => m.status === 'ACTIVE').length;
  const inactiveCount = members.filter((m) => m.status === 'INACTIVE').length;

  if (loading && !team && !refreshing) {
    return (
      <ScreenContainer>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Loading team details...</Text>
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      <ScrollView
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <Text style={styles.title}>Team Oversight & Members</Text>

        {!team ? (
          // Initial Department Team Creation Form
          <View style={styles.card}>
            <Text style={styles.cardHeader}>Department Team Setup</Text>
            <Text style={styles.subtitle}>
              No department team is currently associated with your Higher Officer profile. Create your department team below to start managing officers.
            </Text>

            <Text style={styles.inputLabel}>Department Name</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Special Investigation Division"
              placeholderTextColor="#94A3B8"
              value={newTeamName}
              onChangeText={setNewTeamName}
              editable={!creatingTeam}
            />

            <Text style={styles.inputLabel}>Department Team Code</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. SID-01"
              placeholderTextColor="#94A3B8"
              autoCapitalize="characters"
              value={newTeamCode}
              onChangeText={setNewTeamCode}
              editable={!creatingTeam}
            />

            <PrimaryButton
              title={creatingTeam ? 'Registering Department...' : 'Create Department Team'}
              onPress={handleCreateTeam}
              disabled={creatingTeam}
              style={{ marginTop: 16, backgroundColor: '#007AFF' }}
            />
          </View>
        ) : (
          <View>
            {/* Team Info Card */}
            <View style={styles.card}>
              <View style={styles.teamHeaderRow}>
                <View>
                  <Text style={styles.badgeText}>ACTIVE DEPARTMENT</Text>
                  <Text style={styles.cardHeader}>{team.name}</Text>
                </View>
                <View style={styles.codeBadge}>
                  <Text style={styles.codeBadgeText}>{team.team_code}</Text>
                </View>
              </View>
              <Text style={styles.label}>
                Department Team ID: <Text style={styles.valueSecondary}>{team.id}</Text>
              </Text>
            </View>

            {/* Action Bar: Invite Officer Button */}
            <View style={styles.actionBarRow}>
              <PrimaryButton
                title={showInviteModal ? 'Close Invite Form' : '+ Invite Officer by Email'}
                onPress={() => setShowInviteModal(!showInviteModal)}
                style={{ backgroundColor: showInviteModal ? '#64748B' : '#007AFF' }}
              />
            </View>

            {/* Invite Officer Form (Phase 2 & Phase 3) */}
            {showInviteModal && (
              <View style={[styles.card, { marginTop: 16, borderColor: '#007AFF' }]}>
                <View style={styles.inviteHeaderRow}>
                  <Text style={styles.cardHeader}>Invite Officer to Team</Text>
                  <TouchableOpacity onPress={() => setShowInviteModal(false)}>
                    <Text style={styles.cancelText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.subtitle}>
                  Enter the officer's name and email. An official invitation will be sent with a secure link to join {team.name}.
                </Text>

                <Text style={styles.inputLabel}>Officer Full Name *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Officer Alex Rivera"
                  placeholderTextColor="#94A3B8"
                  value={inviteName}
                  onChangeText={setInviteName}
                  maxLength={100}
                  editable={!submitting}
                />

                <Text style={styles.inputLabel}>Official Email Address *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. arivera@department.gov"
                  placeholderTextColor="#94A3B8"
                  autoCapitalize="none"
                  keyboardType="email-address"
                  value={inviteEmail}
                  onChangeText={setInviteEmail}
                  editable={!submitting}
                />

                <View style={styles.inviteButtonGroup}>
                  <PrimaryButton
                    title={submitting ? 'Sending Invitation...' : 'Send Official Invitation'}
                    onPress={handleInviteOfficer}
                    disabled={submitting}
                    style={{ flex: 1, backgroundColor: '#007AFF', marginTop: 16 }}
                  />
                  <TouchableOpacity
                    style={styles.cancelBtn}
                    onPress={() => {
                      setShowInviteModal(false);
                      setInviteName('');
                      setInviteEmail('');
                    }}
                    disabled={submitting}
                  >
                    <Text style={styles.cancelBtnText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Pending Invitations Section */}
            {invitations.filter((i) => i.status === 'PENDING').length > 0 && (
              <View style={[styles.card, { marginTop: 16 }]}>
                <Text style={styles.cardHeader}>
                  Pending Invitations ({invitations.filter((i) => i.status === 'PENDING').length})
                </Text>
                <Text style={styles.subtitle}>
                  Officers who have been invited and have not yet completed team verification.
                </Text>

                <View style={{ marginTop: 8 }}>
                  {invitations
                    .filter((i) => i.status === 'PENDING')
                    .map((inv) => (
                      <View key={inv.id} style={styles.memberRow}>
                        <View style={{ flex: 1 }}>
                          <View style={styles.memberNameRow}>
                            <Text style={styles.memberName}>{inv.display_name}</Text>
                            <View style={[styles.statusBadge, styles.pendingBadge]}>
                              <Text style={[styles.statusBadgeText, styles.pendingBadgeText]}>PENDING</Text>
                            </View>
                          </View>
                          <Text style={styles.memberEmail}>{inv.email}</Text>
                          <Text style={styles.badgeInfo}>
                            Expires: {new Date(inv.expires_at).toLocaleDateString()}
                          </Text>
                        </View>

                        <TouchableOpacity
                          style={styles.revokeBtn}
                          onPress={() => handleRevokeInvitation(inv.id, inv.email)}
                        >
                          <Text style={styles.revokeBtnText}>Revoke</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                </View>
              </View>
            )}

            {/* Search & Filter Section */}
            <View style={[styles.card, { marginTop: 16 }]}>
              <Text style={styles.cardHeader}>
                Department Personnel ({members.length})
              </Text>

              {/* Status Tabs */}
              <View style={styles.tabContainer}>
                <Pressable
                  style={[styles.tab, statusFilter === 'ACTIVE' && styles.activeTab]}
                  onPress={() => setStatusFilter('ACTIVE')}
                >
                  <Text style={[styles.tabText, statusFilter === 'ACTIVE' && styles.activeTabText]}>
                    Active ({activeCount})
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.tab, statusFilter === 'INACTIVE' && styles.activeTab]}
                  onPress={() => setStatusFilter('INACTIVE')}
                >
                  <Text style={[styles.tabText, statusFilter === 'INACTIVE' && styles.activeTabText]}>
                    Inactive ({inactiveCount})
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.tab, statusFilter === 'ALL' && styles.activeTab]}
                  onPress={() => setStatusFilter('ALL')}
                >
                  <Text style={[styles.tabText, statusFilter === 'ALL' && styles.activeTabText]}>
                    All ({members.length})
                  </Text>
                </Pressable>
              </View>

              {/* Search Bar */}
              <TextInput
                style={[styles.input, { marginTop: 10 }]}
                placeholder="Search by name, email, or badge number..."
                placeholderTextColor="#94A3B8"
                value={searchQuery}
                onChangeText={setSearchQuery}
              />

              {/* Members List */}
              <View style={{ marginTop: 12 }}>
                {filteredMembers.length === 0 ? (
                  <View style={styles.emptyContainer}>
                    <Text style={styles.emptyText}>
                      {members.length === 0
                        ? 'No officers registered in this department yet.'
                        : 'No officers match your search/filter.'}
                    </Text>
                  </View>
                ) : (
                  filteredMembers.map((item, index) => {
                    const profile = Array.isArray(item.profiles) ? item.profiles[0] : item.profiles;
                    const displayName = profile?.display_name || 'Officer';
                    const email = profile?.email || 'N/A';
                    const badge = profile?.badge_number;
                    const isActive = item.status === 'ACTIVE';

                    return (
                      <View key={item.user_id || index} style={styles.memberRow}>
                        <Pressable
                          style={{ flex: 1 }}
                          onPress={() =>
                            router.push({
                              pathname: '/(higher-officer)/officer-details',
                              params: { userId: item.user_id },
                            })
                          }
                        >
                          <View style={styles.memberNameRow}>
                            <Text style={styles.memberName}>{displayName}</Text>
                            <View style={[styles.statusBadge, isActive ? styles.activeBadge : styles.inactiveBadge]}>
                              <Text style={[styles.statusBadgeText, isActive ? styles.activeBadgeText : styles.inactiveBadgeText]}>
                                {item.status}
                              </Text>
                            </View>
                          </View>
                          <Text style={styles.memberEmail}>{email}</Text>
                          {badge ? <Text style={styles.badgeInfo}>Badge: {badge}</Text> : null}
                        </Pressable>

                        {isActive ? (
                          <TouchableOpacity
                            style={styles.deactivateBtn}
                            onPress={() => handleDeactivateMember(item.user_id, displayName)}
                          >
                            <Text style={styles.deactivateBtnText}>Deactivate</Text>
                          </TouchableOpacity>
                        ) : (
                          <View style={styles.inactivePill}>
                            <Text style={styles.inactivePillText}>Inactive</Text>
                          </View>
                        )}
                      </View>
                    );
                  })
                )}
              </View>
            </View>
          </View>
        )}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, flexGrow: 1, paddingBottom: 40 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#0F172A', marginBottom: 16 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 10, color: '#64748B' },
  card: { backgroundColor: '#FFF', padding: 20, borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0', elevation: 2 },
  cardHeader: { fontSize: 18, fontWeight: 'bold', color: '#1E293B' },
  teamHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 },
  badgeText: { color: '#0284C7', fontSize: 11, fontWeight: 'bold', letterSpacing: 1, marginBottom: 2 },
  codeBadge: { backgroundColor: '#F1F5F9', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: '#CBD5E1' },
  codeBadgeText: { fontWeight: 'bold', color: '#0F172A', fontSize: 13, letterSpacing: 1 },
  subtitle: { fontSize: 13, color: '#64748B', marginTop: 4, marginBottom: 14, lineHeight: 18 },
  label: { fontSize: 12, color: '#64748B', marginTop: 6 },
  valueSecondary: { fontSize: 12, color: '#0F172A', fontFamily: 'monospace' },
  inputLabel: { fontSize: 13, fontWeight: '600', color: '#334155', marginBottom: 5, marginTop: 10 },
  passwordLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, marginBottom: 5 },
  togglePasswordText: { fontSize: 12, color: '#007AFF', fontWeight: '600' },
  helperText: { fontSize: 11, color: '#64748B', marginTop: 4, fontStyle: 'italic' },
  input: { backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: '#0F172A' },
  tabContainer: { flexDirection: 'row', backgroundColor: '#F1F5F9', borderRadius: 8, padding: 3, marginTop: 10 },
  tab: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 6 },
  activeTab: { backgroundColor: '#FFF', elevation: 1 },
  tabText: { fontSize: 12, fontWeight: '600', color: '#64748B' },
  activeTabText: { color: '#0F172A' },
  emptyContainer: { paddingVertical: 20, alignItems: 'center' },
  emptyText: { color: '#94A3B8', fontStyle: 'italic', fontSize: 13 },
  memberRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  memberNameRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  memberName: { fontSize: 15, fontWeight: '600', color: '#1E293B', marginRight: 8 },
  memberEmail: { fontSize: 13, color: '#64748B', marginTop: 2 },
  badgeInfo: { fontSize: 11, color: '#0284C7', fontWeight: '500', marginTop: 2 },
  statusBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  activeBadge: { backgroundColor: '#DCFCE7' },
  inactiveBadge: { backgroundColor: '#FEE2E2' },
  statusBadgeText: { fontSize: 10, fontWeight: 'bold' },
  activeBadgeText: { color: '#166534' },
  inactiveBadgeText: { color: '#991B1B' },
  deactivateBtn: { backgroundColor: '#FEE2E2', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, marginLeft: 8 },
  deactivateBtnText: { color: '#DC2626', fontSize: 12, fontWeight: '600' },
  inactivePill: { backgroundColor: '#F1F5F9', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, marginLeft: 8 },
  inactivePillText: { color: '#94A3B8', fontSize: 11, fontWeight: '500' },
  actionBarRow: { marginTop: 12 },
  inviteHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cancelText: { color: '#EF4444', fontWeight: '600', fontSize: 13 },
  inviteButtonGroup: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  cancelBtn: { marginTop: 16, marginLeft: 12, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: '#CBD5E1', alignItems: 'center', justifyContent: 'center' },
  cancelBtnText: { color: '#64748B', fontWeight: '600', fontSize: 14 },
  pendingBadge: { backgroundColor: '#FEF3C7' },
  pendingBadgeText: { color: '#B45309' },
  revokeBtn: { backgroundColor: '#FEF2F2', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, marginLeft: 8 },
  revokeBtnText: { color: '#B91C1C', fontSize: 11, fontWeight: '600' },
});
