import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { supabase } from "@/lib/supabase";
import { OnPrimary, Radius, Type } from "@/lib/design-tokens";

const PRIVATE_ACCOUNTS = [
  { id: "temney", name: "Temney", email: "temney@songcraft.test", description: "Autor a hlavní studio" },
  { id: "dj-palacinka", name: "DJ Palačinka", email: "dj.palacinka@songcraft.test", description: "Vlastní soukromý prostor" },
  { id: "verca", name: "Verča", email: "verca@songcraft.test", description: "Vlastní soukromý prostor" },
] as const;

export default function AuthScreen() {
  const colors = useColors();
  const [selectedAccountId, setSelectedAccountId] = useState<(typeof PRIVATE_ACCOUNTS)[number]["id"]>("temney");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const selectedAccount = PRIVATE_ACCOUNTS.find((account) => account.id === selectedAccountId) ?? PRIVATE_ACCOUNTS[0];

  const signIn = async () => {
    if (!password) {
      Alert.alert("Doplň heslo", `Zadej heslo účtu ${selectedAccount.name}.`);
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: selectedAccount.email, password });
    setLoading(false);

    if (error) {
      Alert.alert("Přihlášení se nezdařilo", "Zkontroluj vybraný účet a heslo.");
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
        <Text style={[styles.text, { color: colors.muted }]}>Vyber svůj účet a zadej heslo. Každý účet má oddělené texty, přebaly, skladby i soubory.</Text>

        <View style={styles.accountList}>
          {PRIVATE_ACCOUNTS.map((account) => {
            const selected = account.id === selectedAccountId;
            return (
              <Pressable
                key={account.id}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                onPress={() => setSelectedAccountId(account.id)}
                style={({ pressed }) => [
                  styles.account,
                  { borderColor: selected ? colors.primary : colors.border, backgroundColor: selected ? `${colors.primary}12` : colors.background, opacity: pressed ? 0.72 : 1 },
                ]}
              >
                <View style={[styles.avatar, { backgroundColor: selected ? colors.primary : colors.border }]}>
                  <Text style={[styles.avatarText, { color: selected ? "#FFFFFF" : colors.foreground }]}>{account.name.slice(0, 1)}</Text>
                </View>
                <View style={styles.accountCopy}>
                  <Text style={[styles.accountName, { color: colors.foreground }]}>{account.name}</Text>
                  <Text style={[styles.accountDescription, { color: colors.muted }]}>{account.description}</Text>
                </View>
                <MaterialIcons name={selected ? "radio-button-checked" : "radio-button-unchecked"} size={22} color={selected ? colors.primary : colors.muted} />
              </Pressable>
            );
          })}
        </View>

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
          placeholder={`Heslo účtu ${selectedAccount.name}`}
          placeholderTextColor={colors.muted}
          style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
        />
        <Pressable disabled={loading} onPress={() => void signIn()} style={({ pressed }) => [styles.primary, { backgroundColor: colors.primary, opacity: loading || pressed ? 0.68 : 1 }]}>
          <Text style={styles.primaryText}>{loading ? "Ověřuji…" : `Přihlásit se jako ${selectedAccount.name}`}</Text>
        </Pressable>
        <Text style={[styles.note, { color: colors.muted }]}>Přístup je omezený na Temney, DJ Palačinka a Verču. Nové účty nelze vytvářet.</Text>
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: Radius.xl, padding: 20, gap: 12 },
  icon: { width: 58, height: 58, borderRadius: Radius.lg, alignItems: "center", justifyContent: "center" },
  title: { fontSize: Type.title.fontSize, lineHeight: Type.title.lineHeight, fontWeight: "900", marginTop: 4 },
  text: { ...Type.label, lineHeight: 19, marginBottom: 5 },
  accountList: { gap: 8 },
  account: { minHeight: 65, borderWidth: 1, borderRadius: Radius.md, padding: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  avatar: { width: 38, height: 38, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 16, fontWeight: "900" },
  accountCopy: { flex: 1, gap: 2 },
  accountName: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "900" },
  accountDescription: { ...Type.caption, lineHeight: 15 },
  input: { minHeight: 50, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 13, fontSize: 15, marginTop: 3 },
  primary: { height: 51, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center", marginTop: 2 },
  primaryText: { color: OnPrimary, fontSize: 15, fontWeight: "900" },
  note: { ...Type.caption, lineHeight: 16, textAlign: "center", marginTop: 2 },
});
