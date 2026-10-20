/**
 * Media a single generation session may use (learning plan B13): a course
 * started from a wrong-question explanation generates images, speech or video
 * only when the student ticked it there (and the setting is on), never because
 * the setting happened to be on. Without a choice the settings apply as is.
 */
export interface SessionMediaChoice {
  image: boolean;
  tts: boolean;
  video: boolean;
}

export function withMediaChoice<
  T extends {
    imageGenerationEnabled: boolean;
    videoGenerationEnabled: boolean;
    ttsEnabled: boolean;
  },
>(settings: T, choice: SessionMediaChoice | undefined): T {
  if (!choice) return settings;
  return {
    ...settings,
    imageGenerationEnabled: settings.imageGenerationEnabled && choice.image,
    videoGenerationEnabled: settings.videoGenerationEnabled && choice.video,
    ttsEnabled: settings.ttsEnabled && choice.tts,
  };
}
