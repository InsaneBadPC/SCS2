import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/**
 * Supabase's session contains refresh tokens. Keep it in the platform keystore
 * on native devices instead of the general-purpose AsyncStorage database.
 *
 * AsyncStorage is intentionally used only as a one-time migration source. Once
 * a legacy session has been copied to SecureStore it is removed; a new session
 * is never written back to AsyncStorage on native platforms.
 */
const nativeStorage = {
  async getItem(key: string): Promise<string | null> {
    const secureValue = await SecureStore.getItemAsync(key);
    if (secureValue !== null) return secureValue;

    const legacyValue = await AsyncStorage.getItem(key);
    if (legacyValue === null) return null;

    try {
      await SecureStore.setItemAsync(key, legacyValue);
      await AsyncStorage.removeItem(key);
    } catch {
      // Do not silently keep a refresh token in plaintext if migration fails;
      // discard the legacy value so the next sign-in starts from SecureStore.
      await AsyncStorage.removeItem(key).catch(() => undefined);
      throw new Error("Supabase session could not be migrated to secure storage.");
    }
    return legacyValue;
  },

  async setItem(key: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(key, value);
  },

  async removeItem(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(key);
    // Clean up a legacy value if a previous version wrote one.
    await AsyncStorage.removeItem(key);
  },
};

export const supabaseSessionStorage = Platform.OS === "web" ? AsyncStorage : nativeStorage;
