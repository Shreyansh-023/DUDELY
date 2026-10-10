/**
 * Languages the tutor can listen to and speak. Codes are BCP-47 as used by
 * Sarvam AI (STT + TTS). The browser Web Speech API mostly uses the same codes;
 * the few differences are mapped in `toWebSpeechLang` / `toWhisperLang`.
 */
export const LANGUAGES = [
  { code: "en-IN", label: "English / Hinglish", native: "English" },
  { code: "hi-IN", label: "Hindi", native: "हिन्दी" },
  { code: "bn-IN", label: "Bengali", native: "বাংলা" },
  { code: "ta-IN", label: "Tamil", native: "தமிழ்" },
  { code: "te-IN", label: "Telugu", native: "తెలుగు" },
  { code: "mr-IN", label: "Marathi", native: "मराठी" },
  { code: "gu-IN", label: "Gujarati", native: "ગુજરાતી" },
  { code: "kn-IN", label: "Kannada", native: "ಕನ್ನಡ" },
  { code: "ml-IN", label: "Malayalam", native: "മലയാളം" },
  { code: "pa-IN", label: "Punjabi", native: "ਪੰਜਾਬੀ" },
  { code: "od-IN", label: "Odia", native: "ଓଡ଼ିଆ" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

export const DEFAULT_LANGUAGE: LanguageCode = "en-IN";

export function isSupportedLanguage(code: string): code is LanguageCode {
  return LANGUAGES.some((l) => l.code === code);
}

/** Sarvam uses od-IN for Odia; browsers use or-IN. */
export function toWebSpeechLang(code: string): string {
  return code === "od-IN" ? "or-IN" : code;
}

/** Whisper (Groq) wants ISO-639-1 two-letter codes. */
export function toWhisperLang(code: string): string | undefined {
  const map: Record<string, string> = {
    "en-IN": "en",
    "hi-IN": "hi",
    "bn-IN": "bn",
    "ta-IN": "ta",
    "te-IN": "te",
    "mr-IN": "mr",
    "gu-IN": "gu",
    "kn-IN": "kn",
    "ml-IN": "ml",
    "pa-IN": "pa",
    "od-IN": "or",
  };
  return map[code];
}

export function languageLabel(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

/**
 * What Guru says out loud in hands-free voice mode: the opening question when
 * there is no conversation yet, and the nudge after 5s of silence. Spoken only —
 * these never enter the chat transcript or the LLM history.
 */
export const VOICE_PROMPTS: Record<LanguageCode, { greeting: string; reprompt: string }> = {
  "en-IN": {
    greeting: "Hello! What should we learn today?",
    reprompt: "I didn't hear anything. What would you like to learn?",
  },
  "hi-IN": { greeting: "नमस्ते! आज हम क्या सीखें?", reprompt: "मुझे कुछ सुनाई नहीं दिया। आप क्या सीखना चाहेंगे?" },
  "bn-IN": { greeting: "নমস্কার! আজ আমরা কী শিখব?", reprompt: "আমি কিছু শুনতে পাইনি। তুমি কী শিখতে চাও?" },
  "ta-IN": { greeting: "வணக்கம்! இன்று நாம் என்ன கற்போம்?", reprompt: "எனக்கு எதுவும் கேட்கவில்லை. நீங்கள் என்ன கற்க விரும்புகிறீர்கள்?" },
  "te-IN": { greeting: "నమస్తే! ఈరోజు మనం ఏమి నేర్చుకుందాం?", reprompt: "నాకు ఏమీ వినిపించలేదు. మీరు ఏమి నేర్చుకోవాలనుకుంటున్నారు?" },
  "mr-IN": { greeting: "नमस्कार! आज आपण काय शिकूया?", reprompt: "मला काही ऐकू आले नाही. तुम्हाला काय शिकायचे आहे?" },
  "gu-IN": { greeting: "નમસ્તે! આજે આપણે શું શીખીએ?", reprompt: "મને કંઈ સંભળાયું નહીં. તમે શું શીખવા માંગો છો?" },
  "kn-IN": { greeting: "ನಮಸ್ಕಾರ! ಇಂದು ನಾವು ಏನು ಕಲಿಯೋಣ?", reprompt: "ನನಗೆ ಏನೂ ಕೇಳಿಸಲಿಲ್ಲ. ನೀವು ಏನು ಕಲಿಯಲು ಬಯಸುತ್ತೀರಿ?" },
  "ml-IN": { greeting: "നമസ്കാരം! ഇന്ന് നമുക്ക് എന്ത് പഠിക്കാം?", reprompt: "എനിക്ക് ഒന്നും കേൾക്കാനായില്ല. നിങ്ങൾക്ക് എന്ത് പഠിക്കണം?" },
  "pa-IN": { greeting: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਅੱਜ ਅਸੀਂ ਕੀ ਸਿੱਖੀਏ?", reprompt: "ਮੈਨੂੰ ਕੁਝ ਸੁਣਾਈ ਨਹੀਂ ਦਿੱਤਾ। ਤੁਸੀਂ ਕੀ ਸਿੱਖਣਾ ਚਾਹੁੰਦੇ ਹੋ?" },
  "od-IN": { greeting: "ନମସ୍କାର! ଆଜି ଆମେ କଣ ଶିଖିବା?", reprompt: "ମୁଁ କିଛି ଶୁଣିପାରିଲି ନାହିଁ। ଆପଣ କଣ ଶିଖିବାକୁ ଚାହାଁନ୍ତି?" },
};

export function voicePrompts(code: string): { greeting: string; reprompt: string } {
  return VOICE_PROMPTS[isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE];
}
