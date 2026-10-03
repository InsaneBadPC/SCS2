// Load environment variables with proper priority (system > .env)
import "./scripts/load-env.js";
import type { ExpoConfig } from "expo/config";

// Jediný zdroj pravdy pro verzi aplikace: package.json.
const appVersion: string = require("./package.json").version;
// Android verze musí být monotónně rostoucí celé číslo (major*10000 + minor*100 + patch).
const versionCodeFromPackage = appVersion
  .split(".")
  .map((part: string) => parseInt(part, 10) || 0)
  .reduce((acc: number, part: number, index: number) => acc + part * Math.pow(100, 2 - index), 0);
// CI může versionCode přepsat: automatický build po každé změně musí mít vyšší
// číslo než předchozí vydaný APK (Android nižší verzi nepřijme), jinak platí package.json.
const versionCodeOverride = Number(process.env.EXPO_ANDROID_VERSION_CODE);
const versionCode = Number.isFinite(versionCodeOverride) && versionCodeOverride > 0 ? versionCodeOverride : versionCodeFromPackage;

// Nezávislý identifikátor aplikace pro externí Android/iOS sestavení.
const rawBundleId = "com.temney.songcraftstudio";
const bundleId =
  rawBundleId
    .replace(/[-_]/g, ".") // Replace hyphens/underscores with dots
    .replace(/[^a-zA-Z0-9.]/g, "") // Remove invalid chars
    .replace(/\.+/g, ".") // Collapse consecutive dots
    .replace(/^\.+|\.+$/g, "") // Trim leading/trailing dots
    .toLowerCase()
    .split(".")
    .map((segment) => {
      // Android requires each segment to start with a letter
      // Prefix with 'x' if segment starts with a digit
      return /^[a-zA-Z]/.test(segment) ? segment : "x" + segment;
    })
    .join(".") || "com.temney.songcraftstudio";

const env = {
  // App branding - update these values directly (do not use env vars)
  appName: "SongCraft Studio",
  appSlug: "songcraft-studio",
  // Ikona je součástí sestavení v assets/images/icon.png.
  logoUrl: "",
  scheme: "songcraftstudio",
  iosBundleId: bundleId,
  androidPackage: bundleId,
};

const config: ExpoConfig = {
  name: env.appName,
  slug: env.appSlug,
  version: appVersion,
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: env.scheme,
  userInterfaceStyle: "dark",
  newArchEnabled: true,
  ios: {
    supportsTablet: true,
    bundleIdentifier: env.iosBundleId,
    "infoPlist": {
        "ITSAppUsesNonExemptEncryption": false
      }
  },
  android: {
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
      foregroundImage: "./assets/images/android-icon-foreground.png",
      backgroundImage: "./assets/images/android-icon-background.png",
      monochromeImage: "./assets/images/android-icon-monochrome.png",
    },
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
    package: env.androidPackage,
    versionCode,
    permissions: ["POST_NOTIFICATIONS", "REQUEST_INSTALL_PACKAGES"],
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [
          {
            scheme: env.scheme,
            host: "*",
          },
        ],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  web: {
    bundler: "metro",
    output: "static",
    favicon: "./assets/images/favicon.png",
  },
  plugins: [
    "expo-router",
    "expo-asset",
    "expo-font",
    "expo-web-browser",
    "expo-document-picker",
    [
      "expo-image-picker",
      {
        "photosPermission": "Allow $(PRODUCT_NAME) to choose artwork for songs and albums."
      }
    ],
    [
      "expo-audio",
      {
        microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone.",
      },
    ],
    [
      "expo-video",
      {
        supportsBackgroundPlayback: true,
        supportsPictureInPicture: true,
      },
    ],
    [
      "expo-splash-screen",
      {
        image: "./assets/images/splash-icon.png",
        imageWidth: 200,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
        dark: {
          backgroundColor: "#000000",
        },
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          buildArchs: ["armeabi-v7a", "arm64-v8a"],
          minSdkVersion: 24,
          // Klávesnice zmenší okno místo aby překrývala obsah — vidíš, co píšeš.
          softwareKeyboardLayoutMode: "resize",
        },
      },
    ],
  ],
  experiments: {
    // GitHub Pages serves this repository below /songcraft-studio.
    baseUrl: "/songcraft-studio",
    typedRoutes: true,
    reactCompiler: true,
  },
};

export default config;
