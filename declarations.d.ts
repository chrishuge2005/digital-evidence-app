declare module '@expo/vector-icons' {
  import { Component } from 'react';
  import { TextProps } from 'react-native';
  export class Ionicons extends Component<TextProps & { name: string; size?: number; color?: string }> {}
}

declare module 'expo-keep-awake' {
  export function activateKeepAwakeAsync(tag?: string): Promise<void>;
  export function deactivateKeepAwake(tag?: string): Promise<void>;
  export function useKeepAwake(tag?: string): void;
}
