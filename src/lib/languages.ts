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

/** Unicode blocks of the Indic scripts the tutor supports, with the language each one implies. */
const SCRIPTS: { name: string; re: RegExp; language: string }[] = [
  { name: "Devanagari", re: /[ऀ-ॿ]/g, language: "Hindi" },
  { name: "Bengali", re: /[ঀ-৿]/g, language: "Bengali" },
  { name: "Gurmukhi", re: /[਀-੿]/g, language: "Punjabi" },
  { name: "Gujarati", re: /[઀-૿]/g, language: "Gujarati" },
  { name: "Odia", re: /[଀-୿]/g, language: "Odia" },
  { name: "Tamil", re: /[஀-௿]/g, language: "Tamil" },
  { name: "Telugu", re: /[ఀ-౿]/g, language: "Telugu" },
  { name: "Kannada", re: /[ಀ-೿]/g, language: "Kannada" },
  { name: "Malayalam", re: /[ഀ-ൿ]/g, language: "Malayalam" },
];

/** Common Hindi words as they are typed in Latin script; two or more mark a message as Hinglish. */
const HINGLISH_WORDS = new Set(
  ("kya hai hain hota hoti hote kaise kaisa kyun kyon kyu ka ki ke ko se mein aur nahi nahin " +
    "samjhao samjha samjhaiye batao bataiye karo karte karna yeh ye woh wo matlab kitna kitne kaun " +
    "kab kahan chahiye sakte raha rahe rahi tha thi accha achha haan bhai na")
    .split(" "),
);

/**
 * The language and script the tutor should reply in for this turn, worked out from
 * the session language and how the student wrote. Stated explicitly in every turn,
 * because smaller models do not reliably infer "mirror the student" on their own.
 */
export function replyLanguage(sessionCode: string, studentText: string): string {
  if (sessionCode === "en") return "English";

  const letters = studentText.match(/\p{L}/gu)?.length ?? 0;
  const dominant = SCRIPTS.map((s) => ({ ...s, n: studentText.match(s.re)?.length ?? 0 })).sort(
    (a, b) => b.n - a.n,
  )[0];
  if (letters > 0 && dominant.n / letters >= 0.3) {
    const language = dominant.name === "Devanagari" && sessionCode === "mr-IN" ? "Marathi" : dominant.language;
    return `${language}, written in ${dominant.name} script${scriptExample(language)}`;
  }

  const wordsTyped = studentText.toLowerCase().match(/[a-z]+/g) ?? [];
  const hindiWords = new Set(wordsTyped.filter((w) => HINGLISH_WORDS.has(w))).size;
  if (wordsTyped.length > 0) {
    if (hindiWords >= 2) return "Hinglish: Hindi written in Latin letters, with maths terms in English";
    if (sessionCode === "en-IN" || sessionCode === "hi-IN") return "English";
    // e.g. a Tamil session typed in Latin letters: Tanglish and plain English look alike here.
    return `the language the student wrote in, in Latin letters (plain English if they wrote in English)`;
  }

  // Nothing typed yet (e.g. a voice turn that came through empty): use the session language.
  if (sessionCode === "en-IN") return "Hinglish: Hindi written in Latin letters, with maths terms in English";
  const script = { "hi-IN": "Devanagari", "mr-IN": "Devanagari" }[sessionCode];
  const label = languageLabel(sessionCode);
  return script ? `${label}, written in ${script} script${scriptExample(label)}` : label;
}

/**
 * A one-line example in the target script. Small models copy the (Hinglish) examples in
 * the system prompt and keep speaking in Latin letters; an in-script sample fixes that.
 */
function scriptExample(language: string): string {
  const examples: Record<string, string> = {
    Hindi: "अच्छा, चलो इसे बोर्ड पर समझते हैं।",
    Marathi: "बरं, चला हे बोर्डवर समजून घेऊया.",
  };
  const ex = examples[language];
  return ex ? `, every say in this script (like "${ex}"), not in Latin letters` : "";
}

/**
 * What Guru says out loud in hands-free voice mode: the opening question when
 * there is no conversation yet, and the nudge after 5s of silence. Spoken only —
 * these never enter the chat transcript or the LLM history.
 */
export const VOICE_PROMPTS: Record<LanguageCode, { greeting: string; reprompt: string }> = {
  en: {
    greeting: "Hello! What should we learn today?",
    reprompt: "I didn't hear anything. What would you like to learn?",
  },
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
