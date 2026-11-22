import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig & { android?: { mediaPlaybackRequiresUserGesture?: boolean } } = {
  appId: 'ai.carapa.board',
  appName: 'CarapaBoard',
  webDir: 'dist',
  server: {
    androidScheme: 'http'
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: true,
    },
    CapacitorUpdater: {
      autoUpdate: false,
      appReadyTimeout: 10000,
      resetWhenUpdate: true,
      // APK installs use the explicit CarapaBridge one-shot reset marker;
      // keeping this enabled also protects native upgrades from stale OTA state.
      keepUrlPathAfterReload: true,
    },
  },
  android: {
    mediaPlaybackRequiresUserGesture: false
  }
};

export default config;
