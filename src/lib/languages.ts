/**
 * Languages the tutor can listen to and speak. Codes are BCP-47 as used by
 * Sarvam AI (STT + TTS). The browser Web Speech API mostly uses the same codes;
 * the few differences are mapped in `toWebSpeechLang` / `toWhisperLang`.
 */
export const LANGUAGES = [
  { code: "en", label: "English only", native: "English" },
  { code: "en-IN", label: "English + Hindi", native: "Hinglish" },
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

/**
 * Sarvam has no "generic English" code — its voices/models are keyed to en-IN.
 * Pure English ("en") therefore uses the en-IN voice; only the LLM prompt differs.
 */
export function toSarvamLang(code: string): string {
  return code === "en" ? "en-IN" : code;
}

/**
 * Which Sarvam TTS model + voice to use per language.
 *
 * Bulbul v4-flash is ~1/3 the cost of v3 (₹1 vs ₹3 /1K chars) and adds pitch +
 * loudness control, but its personas are language-tagged (name_language_style)
 * and it has NO voices yet for Tamil, Malayalam, Odia or Punjabi — those four
 * fall back to v3, whose shared voices cover all 11 languages. Personas are
 * female education/conversational voices to match the tutor.
 *
 * A global override is still available: setting SARVAM_TTS_MODEL and/or
 * SARVAM_TTS_SPEAKER forces that value for every language (see /api/tts).
 */
export type SarvamVoice = { model: string; speaker: string };

const V3_FALLBACK: SarvamVoice = { model: "bulbul:v3", speaker: "priya" };

const TTS_VOICES: Record<LanguageCode, SarvamVoice> = {
  en: { model: "bulbul:v4-flash", speaker: "aparna_en_edtech" },
  "en-IN": { model: "bulbul:v4-flash", speaker: "sanchita_enhi_companion" },
  "hi-IN": { model: "bulbul:v4-flash", speaker: "ishita_hi_edtech" },
  "bn-IN": { model: "bulbul:v4-flash", speaker: "roopa_bn_conversational" },
  "te-IN": { model: "bulbul:v4-flash", speaker: "kavitha_te_conversation" },
  "mr-IN": { model: "bulbul:v4-flash", speaker: "ishita_mr_conversational" },
  "gu-IN": { model: "bulbul:v4-flash", speaker: "pooja_gu_conversational" },
  "kn-IN": { model: "bulbul:v4-flash", speaker: "chaitra_kn_conversation" },
  // No suitable v4-flash persona yet — v3 covers these languages.
  "ta-IN": V3_FALLBACK,
  "ml-IN": V3_FALLBACK,
  "pa-IN": V3_FALLBACK,
  "od-IN": V3_FALLBACK,
};

/** TTS model + voice for a language, falling back to the default language's voice. */
export function sarvamVoice(code: string): SarvamVoice {
  return TTS_VOICES[isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE];
}

/** Sarvam uses od-IN for Odia; browsers use or-IN. Pure English → en-US voice. */
export function toWebSpeechLang(code: string): string {
  if (code === "od-IN") return "or-IN";
  if (code === "en") return "en-US";
  return code;
}

/** Whisper (Groq) wants ISO-639-1 two-letter codes. */
export function toWhisperLang(code: string): string | undefined {
  const map: Record<string, string> = {
    en: "en",
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
 * there is no conversation yet, and the nudge after the student stays silent.
 * `answerHint` is never spoken — it's the light caption shown while Guru waits
 * for the student to press Enter before the mic opens. The spoken lines never
 * enter the chat transcript or the LLM history.
 */
export const VOICE_PROMPTS: Record<LanguageCode, { greeting: string; reprompt: string; answerHint: string }> = {
  en: {
    greeting: "Hello! What should we learn today?",
    reprompt: "I didn't hear anything. Can you repeat?",
    answerHint: "Press Enter, then speak your answer",
  },
  "en-IN": {
    greeting: "Hello! What should we learn today?",
    reprompt: "I didn't hear anything. Can you repeat?",
    answerHint: "Press Enter, then speak your answer",
  },
  "hi-IN": {
    greeting: "नमस्ते! आज हम क्या सीखें?",
    reprompt: "मुझे कुछ सुनाई नहीं दिया। क्या आप दोहरा सकते हैं?",
    answerHint: "उत्तर देने के लिए Enter दबाएँ, फिर बोलें",
  },
  "bn-IN": {
    greeting: "নমস্কার! আজ আমরা কী শিখব?",
    reprompt: "আমি কিছু শুনতে পাইনি। আবার বলবে?",
    answerHint: "উত্তর দিতে Enter চাপো, তারপর বলো",
  },
  "ta-IN": {
    greeting: "வணக்கம்! இன்று நாம் என்ன கற்போம்?",
    reprompt: "எனக்கு எதுவும் கேட்கவில்லை. மீண்டும் சொல்ல முடியுமா?",
    answerHint: "பதிலளிக்க Enter அழுத்தி, பிறகு பேசுங்கள்",
  },
  "te-IN": {
    greeting: "నమస్తే! ఈరోజు మనం ఏమి నేర్చుకుందాం?",
    reprompt: "నాకు ఏమీ వినిపించలేదు. మళ్ళీ చెప్పగలరా?",
    answerHint: "సమాధానం చెప్పడానికి Enter నొక్కి, ఆపై మాట్లాడండి",
  },
  "mr-IN": {
    greeting: "नमस्कार! आज आपण काय शिकूया?",
    reprompt: "मला काही ऐकू आले नाही. पुन्हा सांगाल का?",
    answerHint: "उत्तर देण्यासाठी Enter दाबा, नंतर बोला",
  },
  "gu-IN": {
    greeting: "નમસ્તે! આજે આપણે શું શીખીએ?",
    reprompt: "મને કંઈ સંભળાયું નહીં. ફરી કહી શકશો?",
    answerHint: "જવાબ આપવા Enter દબાવો, પછી બોલો",
  },
  "kn-IN": {
    greeting: "ನಮಸ್ಕಾರ! ಇಂದು ನಾವು ಏನು ಕಲಿಯೋಣ?",
    reprompt: "ನನಗೆ ಏನೂ ಕೇಳಿಸಲಿಲ್ಲ. ಮತ್ತೊಮ್ಮೆ ಹೇಳಬಹುದೇ?",
    answerHint: "ಉತ್ತರಿಸಲು Enter ಒತ್ತಿ, ನಂತರ ಮಾತನಾಡಿ",
  },
  "ml-IN": {
    greeting: "നമസ്കാരം! ഇന്ന് നമുക്ക് എന്ത് പഠിക്കാം?",
    reprompt: "എനിക്ക് ഒന്നും കേൾക്കാനായില്ല. ഒന്നുകൂടി പറയാമോ?",
    answerHint: "ഉത്തരം പറയാൻ Enter അമർത്തുക, എന്നിട്ട് സംസാരിക്കൂ",
  },
  "pa-IN": {
    greeting: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਅੱਜ ਅਸੀਂ ਕੀ ਸਿੱਖੀਏ?",
    reprompt: "ਮੈਨੂੰ ਕੁਝ ਸੁਣਾਈ ਨਹੀਂ ਦਿੱਤਾ। ਕੀ ਤੁਸੀਂ ਦੁਹਰਾ ਸਕਦੇ ਹੋ?",
    answerHint: "ਜਵਾਬ ਲਈ Enter ਦਬਾਓ, ਫਿਰ ਬੋਲੋ",
  },
  "od-IN": {
    greeting: "ନମସ୍କାର! ଆଜି ଆମେ କଣ ଶିଖିବା?",
    reprompt: "ମୁଁ କିଛି ଶୁଣିପାରିଲି ନାହିଁ। ଆଉ ଥରେ କହିପାରିବେ କି?",
    answerHint: "ଉତ୍ତର ଦେବାକୁ Enter ଦବାନ୍ତୁ, ତାପରେ କୁହନ୍ତୁ",
  },
};

export function voicePrompts(code: string): { greeting: string; reprompt: string; answerHint: string } {
  return VOICE_PROMPTS[isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE];
}

/**
 * Composer placeholder, written in the script of the selected language so the
 * input invites the student in the language they chose.
 */
export const ASK_PLACEHOLDERS: Record<LanguageCode, string> = {
  en: "Ask anything…",
  "en-IN": "Kuch bhi poocho…",
  "hi-IN": "कुछ भी पूछें…",
  "bn-IN": "যা খুশি জিজ্ঞাসা করুন…",
  "ta-IN": "எதையும் கேளுங்கள்…",
  "te-IN": "ఏదైనా అడగండి…",
  "mr-IN": "काहीही विचारा…",
  "gu-IN": "કંઈપણ પૂછો…",
  "kn-IN": "ಏನಾದರೂ ಕೇಳಿ…",
  "ml-IN": "എന്തും ചോദിക്കൂ…",
  "pa-IN": "ਕੁਝ ਵੀ ਪੁੱਛੋ…",
  "od-IN": "ଯାହା ବି ପଚାରନ୍ତୁ…",
};

export function askPlaceholder(code: string): string {
  return ASK_PLACEHOLDERS[isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE];
}
