import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { VerificationStatus } from '../types/evidence';

interface Props {
  status: VerificationStatus;
}

export function VerificationStatusBadge({ status }: Props) {
  const getBadgeStyle = () => {
    switch (status) {
      case 'VERIFIED': return { bg: '#D1E7DD', text: '#0F5132', label: 'VERIFIED' };
      case 'INTEGRITY_FAILED': return { bg: '#F8D7DA', text: '#842029', label: 'INTEGRITY FAILED' };
      case 'UNAVAILABLE': return { bg: '#FFF3CD', text: '#664D03', label: 'UNAVAILABLE' };
      case 'PARTIALLY_VERIFIED': return { bg: '#CFF4FC', text: '#055160', label: 'PARTIALLY VERIFIED' };
      default: return { bg: '#E2E3E5', text: '#383D41', label: 'NOT VERIFIED' };
    }
  };

  const styleConfig = getBadgeStyle();

  return (
    <View style={[styles.badge, { backgroundColor: styleConfig.bg }]}>
      <Text style={[styles.text, { color: styleConfig.text }]}>{styleConfig.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6, alignSelf: 'flex-start' },
  text: { fontSize: 11, fontWeight: 'bold', letterSpacing: 0.5 }
});