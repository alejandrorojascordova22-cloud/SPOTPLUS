export {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native-web';

type AlertButton = {
  text?: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
};

export const Alert = {
  alert(title: string, message?: string, buttons?: AlertButton[]) {
    if (typeof window === 'undefined') return;

    const text = [title, message].filter(Boolean).join('\n\n');
    const actions = buttons?.filter((button) => button.onPress);

    if (!actions?.length) {
      window.alert(text);
      return;
    }

    if (window.confirm(text)) {
      actions.at(-1)?.onPress?.();
    } else {
      buttons?.find((button) => button.style === 'cancel')?.onPress?.();
    }
  },
};
