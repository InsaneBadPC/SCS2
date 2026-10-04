import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { BrandMark } from "@/components/brand-mark";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { passwordHint, usePasswordRecovery } from "@/lib/reset-password";
import { OnPrimary, Radius, Space, TouchTarget, Type } from "@/lib/design-tokens";

/**
 * Nastaveni noveho hesla po resetovacim e-mailu.
 *
 * Sem se da dostat jen deep linkem `songcraftstudio://reset-password`
 * (viz app.config.ts intentFilters a `app/_layout.tsx`), ktery sem posle
 * tokeny z e-mailu. Neni tu zalopena v zadnych zalozkách ani v nastavení -
 * bez platneho resetovacího odkazu sem běžná navigace nesmí.
 *
 * Vlastní relaci drží `lib/reset-password.ts`; tady se jen vykresluje.
 */
export default function ResetPasswordScreen() {
  const colors = useColors();
  const { state, submitPassword, retryLink } = usePasswordRecovery();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [visible, setVisible] = useState(false);

  const saving = state.phase === "submitting";
  const done = state.phase === "done";
  /** Formular je viditelny, jakmile existuje overena recovery relace. */
  const formOpen = state.account !== null && !done;
  const accountName = state.account?.name ?? "";
  const hint = passwordHint(password, confirm);

  const save = async () => {
    const ok = await submitPassword(password, confirm);
    if (!ok) return;
    setPassword("");
    setConfirm("");
    router.replace("/(tabs)" as never);
  };

  return (
    <ScreenContainer inset>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <BrandMark size={58} />
        <Text style={[styles.title, { color: colors.foreground }]}>
          {done ? "Heslo je nastavené" : "Nové heslo"}
        </Text>

        {formOpen ? (
          <>
            <View style={[styles.card, { backgroundColor: `${colors.primary}13`, borderColor: `${colors.primary}45` }]}>
              <MaterialIcons name="mail" size={18} color={colors.primary} />
              <Text style={[styles.cardText, { color: colors.muted }]}>
                Obnovuješ účet {accountName}. Staré heslo tím přestane platit.
              </Text>
            </View>

            <TextInput
              value={password}
              onChangeText={setPassword}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={!visible}
              textContentType="newPassword"
              autoComplete="new-password"
              editable={!saving}
              placeholder="Nové heslo"
              placeholderTextColor={colors.muted}
              style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
            />
            <TextInput
              value={confirm}
              onChangeText={setConfirm}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={!visible}
              textContentType="newPassword"
              autoComplete="new-password"
              editable={!saving}
              onSubmitEditing={() => void save()}
              returnKeyType="done"
              placeholder="Nové heslo znovu"
              placeholderTextColor={colors.muted}
              style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
            />

            <Pressable
              onPress={() => setVisible((current) => !current)}
              accessibilityRole="button"
              accessibilityLabel={visible ? "Skrýt hesla" : "Zobrazit hesla"}
              style={({ pressed }) => [styles.toggle, { opacity: pressed ? 0.68 : 1 }]}
            >
              <MaterialIcons
                name={visible ? "visibility-off" : "visibility"}
                size={17}
                color={colors.muted}
              />
              <Text style={[styles.toggleText, { color: colors.muted }]}>
                {visible ? "Skrýt hesla" : "Zobrazit hesla"}
              </Text>
            </Pressable>

            {hint ? <Text style={[styles.hint, { color: colors.warning }]}>{hint}</Text> : null}

            {state.message ? (
              <View style={[styles.card, { backgroundColor: `${colors.error}14`, borderColor: `${colors.error}45` }]}>
                <MaterialIcons name="error-outline" size={18} color={colors.error} />
                <Text style={[styles.cardText, { color: colors.foreground }]}>{state.message}</Text>
              </View>
            ) : null}

            <Pressable
              disabled={saving}
              onPress={() => void save()}
              style={({ pressed }) => [styles.primary, { backgroundColor: colors.primary, opacity: saving || pressed ? 0.68 : 1 }]}
            >
              <Text style={styles.primaryText}>{saving ? "Ukládám…" : "Uložit nové heslo"}</Text>
            </Pressable>

            <Text style={[styles.note, { color: colors.muted }]}>
              Po uložení jsi přihlášený novým heslem a obrazovka tě pustí do studia.
            </Text>
          </>
        ) : null}

        {done ? (
          <View style={[styles.card, { backgroundColor: `${colors.success}14`, borderColor: `${colors.success}45` }]}>
            <MaterialIcons name="check-circle" size={18} color={colors.success} />
            <Text style={[styles.cardText, { color: colors.muted }]}>
              Hotovo. Otevírám ti soukromé studio.
            </Text>
          </View>
        ) : null}

        {!formOpen && !done ? (
          <>
            <View style={[styles.card, { backgroundColor: `${colors.warning}14`, borderColor: `${colors.warning}45` }]}>
              <MaterialIcons name="mail-outline" size={18} color={colors.warning} />
              <Text style={[styles.cardText, { color: colors.muted }]}>
                {state.message ?? "otevřete prosím odkaz z e-mailu"}
              </Text>
            </View>

            <Text style={[styles.note, { color: colors.muted }]}>
              Odkaz musí být poslaný na adresu vybraného účtu a otevřený přímo v tomhle
              zařízení — jen tehdy se dá použít.
            </Text>

            <Pressable
              onPress={retryLink}
              style={({ pressed }) => [styles.secondary, { borderColor: colors.border, opacity: pressed ? 0.68 : 1 }]}
            >
              <MaterialIcons name="refresh" size={17} color={colors.primary} />
              <Text style={[styles.secondaryText, { color: colors.primary }]}>
                Zkontrolovat odkaz znovu
              </Text>
            </Pressable>
          </>
        ) : null}

        <Pressable
          onPress={() => router.replace("/auth" as never)}
          style={({ pressed }) => [styles.back, { opacity: pressed ? 0.68 : 1 }]}
        >
          <MaterialIcons name="arrow-back" size={16} color={colors.muted} />
          <Text style={[styles.backText, { color: colors.muted }]}>Zpět na přihlášení</Text>
        </Pressable>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { gap: Space.md, paddingVertical: Space.xl, paddingBottom: Space.xxxl },
  title: { fontSize: Type.title.fontSize, lineHeight: Type.title.lineHeight, fontWeight: "900", marginTop: 4 },
  card: { borderWidth: 1, borderRadius: Radius.md, padding: Space.md, flexDirection: "row", gap: Space.sm, alignItems: "flex-start" },
  cardText: { flex: 1, ...Type.label, lineHeight: 19 },
  input: { minHeight: 50, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 13, fontSize: 15 },
  toggle: { minHeight: TouchTarget, flexDirection: "row", alignItems: "center", gap: Space.sm, alignSelf: "flex-start" },
  toggleText: { ...Type.label },
  hint: { ...Type.label, lineHeight: 18 },
  primary: { height: 51, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center", marginTop: 2 },
  primaryText: { color: OnPrimary, fontSize: 15, fontWeight: "900" },
  secondary: { minHeight: 48, borderWidth: 1, borderRadius: Radius.sm, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Space.sm },
  secondaryText: { ...Type.label, fontWeight: "800" },
  back: { minHeight: TouchTarget, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Space.sm, marginTop: Space.xs },
  backText: { ...Type.label },
  note: { ...Type.caption, lineHeight: 16, textAlign: "center", marginTop: 2 },
});