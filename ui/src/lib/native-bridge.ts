import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { NativeBiometric } from 'capacitor-native-biometric';
import { Camera, CameraResultType } from '@capacitor/camera';
import { VoiceRecorder } from 'capacitor-voice-recorder';

export const isNative = Capacitor.isNativePlatform();

export const NativeBridge = {
  // Biometrics
  async isBiometricAvailable() {
    if (!isNative) return false;
    try {
      const result = await NativeBiometric.isAvailable();
      return result.isAvailable;
    } catch {
      return false;
    }
  },

  async biometricLogin(reason: string = 'Authenticate to access CarapaBoard') {
    if (!isNative) throw new Error('Native only');
    
    return await NativeBiometric.verifyIdentity({
      reason,
      title: 'Biometric Login',
      subtitle: 'Use your fingerprint or face to login',
      description: 'Authenticated access is required',
    });
  },

  // Media
  async captureImage() {
    if (!isNative) {
      // Fallback to web implementation if needed, but for now just throw
      throw new Error('Native capture only implemented');
    }
    const image = await Camera.getPhoto({
      quality: 90,
      allowEditing: false,
      resultType: CameraResultType.Base64
    });
    return image.base64String;
  },

  async startRecording() {
    if (!isNative) return;
    return await VoiceRecorder.startRecording();
  },

  async stopRecording() {
    if (!isNative) return null;
    const result = await VoiceRecorder.stopRecording();
    return result.value; // base64
  },

  // Secure Requests (Bypasses CORS and allows pinning if configured)
  async secureRequest(options: {
    url: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    data?: any;
    headers?: Record<string, string>;
  }) {
    if (!isNative) {
      // Use standard fetch
      const response = await fetch(options.url, {
        method: options.method || 'GET',
        headers: options.headers,
        body: options.data ? JSON.stringify(options.data) : undefined,
        credentials: 'include',
      });
      return await response.json();
    }

    const response = await CapacitorHttp.request({
      url: options.url,
      method: options.method || 'GET',
      data: options.data,
      headers: options.headers,
    });
    return response.data;
  },

  // Secure Credential Storage (biometric-protected)
  async setSecureCredentials(creds: { username: string; password: string }) {
    if (!isNative) return;
    await NativeBiometric.setCredentials({
      server: 'carapa',
      username: creds.username,
      password: creds.password,
    });
  },

  async getSecureCredentials(): Promise<{ username: string; password: string } | null> {
    if (!isNative) return null;
    try {
      const result = await NativeBiometric.getCredentials({ server: 'carapa' });
      if (!result?.username || !result?.password) return null;
      return { username: result.username, password: result.password };
    } catch {
      return null;
    }
  },

  async deleteSecureCredentials() {
    if (!isNative) return;
    try {
      await NativeBiometric.deleteCredentials({ server: 'carapa' });
    } catch {
      // No credentials to delete — ignore.
    }
  }
};
