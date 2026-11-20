import { Stack } from "expo-router";
import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider } from "../api/session-provider.tsx";
import { WriteFeedbackProvider } from "../api/write-feedback.tsx";
import { SessionGate } from "../screens/session-gate.tsx";
import { families } from "../core/theme.ts";
import regular from "../../assets/fonts/Archivo-Regular.ttf";
import medium from "../../assets/fonts/Archivo-Medium.ttf";
import semibold from "../../assets/fonts/Archivo-SemiBold.ttf";
import bold from "../../assets/fonts/Archivo-Bold.ttf";
import condensed from "../../assets/fonts/Archivo_SemiCondensed-Bold.ttf";

export default function Layout() {
  const [loaded, error] = useFonts({
    [families.regular]: regular,
    [families.medium]: medium,
    [families.semibold]: semibold,
    [families.bold]: bold,
    [families.title]: condensed,
  });
  if (error) throw error;
  if (!loaded) return null;
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SessionProvider>
        <WriteFeedbackProvider>
          <SessionGate>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="sign-in" options={{ presentation: "modal" }} />
              <Stack.Screen name="write/[operation]" options={{ presentation: "modal" }} />
            </Stack>
          </SessionGate>
        </WriteFeedbackProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
