import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { supabase } from "@/lib/supabase";
import { OnPrimary, Radius, Type } from "@/lib/design-tokens";

/**
 * SGS2 ma jednoho uzivatele a prihlaseni je fail-closed: zadny vyber uctu,
 * zadna registrace. E-mail musi projit allowlistem na serveru
 * (SONGCRAFT_ALLOWED_EMAILS), takze cizi ucet ani nejde pouzit.
 */
export default function AuthScreen() {
  const colors = useColors();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const signIn = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      Alert.alert("Doplň údaje", "Zadej e-mail i heslo.");
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: trimmedEmail, password });
    setLoading(false);

    if (error) {
      Alert.alert("Přihlášení se nezdařilo", "Zkontroluj e-mail a heslo.");
      return;
    }

    setPassword("");
    router.replace("/(tabs)" as never);
  };

  return (
    <ScreenContainer centered>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={[styles.icon, { backgroundColor: `${colors.primary}25` }]}>
          <MaterialIcons name="lock-person" size={29} color={colors.primary} />
        </View>
        <Text style={[styles.title, { color: colors.foreground }]}>Tvoje soukromé studio</Text>
        <Text style={[styles.text, { color: colors.muted }]}>Přihlas se e-mailem a heslem. Každý účet má oddělené texty, přebaly, skladby i soubory.</Text>

        <TextInput
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="username"
          autoComplete="email"
          onSubmitEditing={() => void signIn()}
          returnKeyType="next"
          placeholder="E-mail"
          placeholderTextColor={colors.muted}
          style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
        />
        <TextInput
          value={password}
          onChangeText={setPassword}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          textContentType="password"
          autoComplete="current-password"
          onSubmitEditing={() => void signIn()}
          returnKeyType="done"
          placeholder="Heslo"
          placeholderTextColor={colors.muted}
          style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
        />
        <Pressable disabled={loading} onPress={() => void signIn()} style={({ pressed }) => [styles.primary, { backgroundColor: colors.primary, opacity: loading || pressed ? 0.68 : 1 }]}>
          <Text style={styles.primaryText}>{loading ? "Ověřuji…" : "Přihlásit se"}</Text>
        </Pressable>
        <Text style={[styles.note, { color: colors.muted }]}>Přístup je omezený na povolený e-mail. Nové účty nelze vytvářet.</Text>
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: Radius.xl, padding: 20, gap: 12 },
  icon: { width: 58, height: 58, borderRadius: Radius.lg, alignItems: "center", justifyContent: "center" },
  title: { fontSize: Type.title.fontSize, lineHeight: Type.title.lineHeight, fontWeight: "900", marginTop: 4 },
  text: { ...Type.label, lineHeight: 19, marginBottom: 5 },
  input: { minHeight: 50, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 13, fontSize: 15 },
  primary: { height: 51, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center", marginTop: 2 },
  primaryText: { color: OnPrimary, fontSize: 15, fontWeight: "900" },
  note: { ...Type.caption, lineHeight: 16, textAlign: "center", marginTop: 2 },
});
