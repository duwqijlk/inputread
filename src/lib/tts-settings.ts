import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { DEFAULT_VOICE, isMimoVoice, type MimoVoice } from "@/lib/mimo-tts";

/**
 * The reader's own Xiaomi MiMo key and chosen voice. Kept on this device only: never part of the
 * synced preferences (sync-merge reads reader-prefs, not this), sent only to Xiaomi, and removed
 * with the other personal keys when the device is cleared (device-wipe PERSONAL_KEYS).
 */
export const TTS_SETTINGS_KEY = "cibian-mimo-tts-v1";

export const ALOUD_RATES = [0.8, 1, 1.2] as const;
export type AloudRate = (typeof ALOUD_RATES)[number];

type TtsSettings = {
  apiKey: string;
  voice: MimoVoice;
  /** Chapter read-aloud speed. */
  rate: AloudRate;
  /** At the end of a chapter, open the next one and keep reading. */
  autoNext: boolean;
  setKey: (apiKey: string) => void;
  setVoice: (voice: MimoVoice) => void;
  setRate: (rate: AloudRate) => void;
  setAutoNext: (autoNext: boolean) => void;
  clear: () => void;
};

export const useTtsSettings = create<TtsSettings>()(
  persist(
    (set) => ({
      apiKey: "",
      voice: DEFAULT_VOICE,
      rate: 1,
      autoNext: true,
      setKey: (apiKey) => set({ apiKey: apiKey.trim() }),
      setVoice: (voice) => set({ voice }),
      setRate: (rate) => set({ rate }),
      setAutoNext: (autoNext) => set({ autoNext }),
      clear: () => set({ apiKey: "", voice: DEFAULT_VOICE }),
    }),
    {
      name: TTS_SETTINGS_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ apiKey, voice, rate, autoNext }) => ({ apiKey, voice, rate, autoNext }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<TtsSettings>;
        return {
          ...current,
          apiKey: typeof saved.apiKey === "string" ? saved.apiKey.trim() : "",
          voice: isMimoVoice(saved.voice) ? saved.voice : DEFAULT_VOICE,
          rate: ALOUD_RATES.includes(saved.rate as AloudRate) ? (saved.rate as AloudRate) : 1,
          autoNext: saved.autoNext !== false,
        };
      },
    },
  ),
);

/** Whether this browser can play generated speech (fetch, Web Audio). Old e-ink engines cannot. */
export function readAloudSupported(): boolean {
  if (typeof window === "undefined" || typeof fetch !== "function") return false;
  const w = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
  return Boolean(w.AudioContext || w.webkitAudioContext);
}

/** Read aloud shows only with a key on a browser that can play it. */
export function useReadAloudReady(): boolean {
  const apiKey = useTtsSettings((state) => state.apiKey);
  return Boolean(apiKey) && readAloudSupported();
}
