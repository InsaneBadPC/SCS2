import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { BrandMark } from "@/components/brand-mark";
import { ScreenContainer } from "@/components/screen-container";
import { STUDIO_ACCOUNTS, type StudioAccount } from "@/lib/accounts";
import { useColors } from "@/hooks/use-colors";
import { RESET_LINK_URI } from "@/lib/reset-password";
import { supabase } from "@/lib/supabase";
import { OnPrimary, Radius, Space, TouchTarget, Type } from "@/lib/design-tokens";

/**
 * SCS2 ma tri ucety. Prihlaseni je fail-closed: vyber ze seznamu, zadna
 * registrace, zadny vlastni e-mail. Server to stejne overi proti allowlistu,
 * takze cizi ucet ani nejde pouzit.
 */

/** Resetovací odkaz musí jít do scheme z app.config.ts (env.scheme). */
const RESET_REDIRECT = RESET_LINK_URI;

/** GoTrue chyba pri vycerpanem limitu posilani mailu (rate_limit_email_sent). */
const RATE_LIMIT_CODE = "over_email_send_rate_limit";

export default function AuthScreen() {
  const colors = useColors();
  const [selected, setSelected] = useState<StudioAccount>(STUDIO_ACCOUNTS[0]);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [sendingReset, setSendingReset] = useState(false);

  const signIn = async () => {
    if (!password) {
      Alert.alert("Doplň heslo", "Zadej heslo k vybranému účtu.");
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: selected.email,
      password,
    });
    setLoading(false);

    if (error) {
      Alert.alert("Přihlášení se nezdařilo", "Zkontroluj heslo k účtu " + selected.name + ".");
      return;
    }

    setPassword("");
    router.replace("/(tabs)" as never);
  };

  const sendResetLink = async () => {
    setSendingReset(true);
    const { error } = await supabase.auth.resetPasswordForEmail(selected.email, {
      redirectTo: RESET_REDIRECT,
    });
    setSendingReset(false);

    if (error) {
      // GoTrue ma na posilani resetovacich mailu limit 2 e-maily za hodinu pro
      // cely projekt, takze po sobe dva lide dostanou 429 a treti uz ne.
      // `error.code` je jedina cast chyby, kterou smi zobrazit - zbytek je anglicky.
      if (error.code === RATE_LIMIT_CODE) {
        Alert.alert(
          "Příliš mnoho pokusů",
          "Odkaz se posílá jen párkrát za hodinu, a právě jsi vyčerpal limit. " +
            "Zkontroluj e-mail za hodinu a zkus to potom znovu.",
        );
        return;
      }
      Alert.alert("Odkaz se nepodařilo poslat", "Zkuste to za chvíli znovu.");
      return;
    }

    // 200 z GoTrue znamena jen "pozadavak prijat", ne "mail dorazil". Doly se
    // nesmime chovat, jako bychom potvrdili doruceni - rikat "poslali jsme
    // ti e-mail" by bezpravdivy v okamziku, kdy se o doruceni nevim.
    Alert.alert(
      "Zkontroluj e-mail",
      "Požadavek pro nastavení nového hesla byl odeslán na adresu " + selected.email +
        ". E-mail dorazí jen tehdy, když je ta adresa registrovaná k účtu " + selected.name +
        ". Zkontroluj spam, odkaz otevři na tomhle zařízení. " +
        "Pokud nic nepřijde, kontaktuj správce.",
    );
  };

  return (
    <ScreenContainer inset>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <BrandMark size={58} />
        <Text style={[styles.title, { color: colors.foreground }]}>Tvoje soukromé studio</Text>
        <Text style={[styles.text, { color: colors.muted }]}>
          Vyber svůj účet. Každý má oddělené texty, přebaly, skladby i soubory.
        </Text>

        <View style={styles.accounts}>
          {STUDIO_ACCOUNTS.map((account) => {
            const active = account.id === selected.id;
            return (
              <Pressable
                key={account.id}
                onPress={() => setSelected(account)}
                disabled={loading}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={account.name}
                style={({ pressed }) => [
                  styles.account,
                  {
                    backgroundColor: active ? `${colors.primary}1F` : colors.surface,
                    borderColor: active ? colors.primary : colors.border,
                    opacity: pressed ? 0.72 : 1,
                  },
                ]}
              >
                <View style={[styles.avatar, { backgroundColor: active ? colors.primary : colors.background, borderColor: colors.border }]}>
                  <MaterialIcons name={account.icon} size={20} color={active ? OnPrimary : colors.muted} />
                </View>
                <View style={styles.accountText}>
                  <Text style={[styles.accountName, { color: colors.foreground }]}>{account.name}</Text>
                  <Text style={[styles.accountHint, { color: colors.muted }]}>{account.hint}</Text>
                </View>
                <MaterialIcons
                  name={active ? "radio-button-checked" : "radio-button-unchecked"}
                  size={22}
                  color={active ? colors.primary : colors.muted}
                />
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
          placeholder={"Heslo — " + selected.name}
          placeholderTextColor={colors.muted}
          style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
        />
        <Pressable
          disabled={loading}
          onPress={() => void signIn()}
          style={({ pressed }) => [styles.primary, { backgroundColor: colors.primary, opacity: loading || pressed ? 0.68 : 1 }]}
        >
          <Text style={styles.primaryText}>{loading ? "Ověřuji…" : "Přihlásit se"}</Text>
        </Pressable>

        <Pressable
          disabled={sendingReset || loading}
          onPress={() => void sendResetLink()}
          style={({ pressed }) => [styles.reset, { opacity: sendingReset || pressed ? 0.68 : 1 }]}
        >
          <MaterialIcons name="mail-outline" size={16} color={colors.muted} />
          <Text style={[styles.resetText, { color: colors.muted }]}>
            {sendingReset ? "Posílám odkaz…" : "Zapomněl jsem heslo"}
          </Text>
        </Pressable>

        <Pressable
          onPress={() => router.replace("/reset-password" as never)}
          style={({ pressed }) => [styles.manualReset, { opacity: pressed || loading ? 0.68 : 1 }]}
        >
          <MaterialIcons name="lock" size={16} color={colors.muted} />
          <Text style={[styles.manualResetText, { color: colors.muted }]}>
            Už jsi odkaz z e-mailu otevřel? Nastav nové heslo
          </Text>
        </Pressable>

        <Text style={[styles.note, { color: colors.muted }]}>
          Přístup je omezený na tyto tři účty. Nové účty nelze vytvářet.
        </Text>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { gap: Space.md, paddingVertical: Space.xl, paddingBottom: Space.xxxl },
  title: { fontSize: Type.title.fontSize, lineHeight: Type.title.lineHeight, fontWeight: "900", marginTop: 4 },
  text: { ...Type.label, lineHeight: 19, marginBottom: 5 },
  accounts: { gap: Space.sm },
  account: { minHeight: TouchTarget + 12, borderWidth: 1, borderRadius: Radius.md, padding: Space.md, flexDirection: "row", alignItems: "center", gap: Space.md },
  avatar: { width: 38, height: 38, borderRadius: Radius.pill, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  accountText: { flex: 1, gap: 2 },
  accountName: { ...Type.heading },
  accountHint: { ...Type.caption, letterSpacing: 0 },
  input: { minHeight: 50, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 13, fontSize: 15 },
  primary: { height: 51, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center", marginTop: 2 },
  primaryText: { color: OnPrimary, fontSize: 15, fontWeight: "900" },
  reset: { minHeight: TouchTarget, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Space.sm },
  resetText: { ...Type.label },
  manualReset: { minHeight: TouchTarget, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Space.sm, paddingHorizontal: Space.sm },
  manualResetText: { ...Type.caption, lineHeight: 16, textAlign: "center" },
  note: { ...Type.caption, lineHeight: 16, textAlign: "center", marginTop: 2 },
});