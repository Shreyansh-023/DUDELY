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
export const VOICE_PROMPTS: Record<
  LanguageCode,
  { greeting: string; reprompt: string; answerHint: string }
> = {
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
 * The opening familiarity question Indica asks once when a student names a new
 * topic, BEFORE the lesson is designed. It is a fixed template per language (no
 * LLM call) so it is instant; the student's answer calibrates the lesson plan.
 */
export const FAMILIARITY_PROMPTS: Record<LanguageCode, string> = {
  en: "Before we begin — have you studied this topic before, or is it completely new for you?",
  "en-IN": "Shuru karne se pehle — kya tumne yeh topic pehle padha hai, ya yeh bilkul naya hai?",
  "hi-IN": "शुरू करने से पहले — क्या तुमने यह विषय पहले पढ़ा है, या यह बिल्कुल नया है?",
  "bn-IN": "শুরু করার আগে — তুমি কি এই বিষয়টি আগে পড়েছ, নাকি এটি একদম নতুন?",
  "ta-IN": "தொடங்குவதற்கு முன் — இந்தத் தலைப்பை முன்பு படித்திருக்கிறாயா, அல்லது இது முற்றிலும் புதியதா?",
  "te-IN": "ప్రారంభించే ముందు — ఈ అంశాన్ని నువ్వు ఇంతకుముందు చదివావా, లేదా ఇది పూర్తిగా కొత్తదా?",
  "mr-IN": "सुरू करण्यापूर्वी — तू हा विषय आधी शिकला आहेस का, की तो अगदी नवीन आहे?",
  "gu-IN": "શરૂ કરતા પહેલાં — શું તેં આ વિષય પહેલાં ભણ્યો છે, કે તે તદ્દન નવો છે?",
  "kn-IN": "ಪ್ರಾರಂಭಿಸುವ ಮೊದಲು — ನೀನು ಈ ವಿಷಯವನ್ನು ಮೊದಲು ಓದಿದ್ದೀಯಾ, ಅಥವಾ ಇದು ಸಂಪೂರ್ಣ ಹೊಸದೇ?",
  "ml-IN": "തുടങ്ങുന്നതിന് മുമ്പ് — ഈ വിഷയം നീ മുമ്പ് പഠിച്ചിട്ടുണ്ടോ, അതോ ഇത് തീർത്തും പുതിയതാണോ?",
  "pa-IN": "ਸ਼ੁਰੂ ਕਰਨ ਤੋਂ ਪਹਿਲਾਂ — ਕੀ ਤੂੰ ਇਹ ਵਿਸ਼ਾ ਪਹਿਲਾਂ ਪੜ੍ਹਿਆ ਹੈ, ਜਾਂ ਇਹ ਬਿਲਕੁਲ ਨਵਾਂ ਹੈ?",
  "od-IN": "ଆରମ୍ଭ କରିବା ପୂର୍ବରୁ — ତୁମେ ଏହି ବିଷୟ ପୂର୍ବରୁ ପଢ଼ିଛ କି, ନା ଏହା ସମ୍ପୂର୍ଣ୍ଣ ନୂଆ?",
};

export function familiarityQuestion(code: string): string {
  return FAMILIARITY_PROMPTS[isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE];
}

/**
 * Read the student's answer to the familiarity question into a level that tunes
 * the lesson plan. Heuristic across English, Hinglish and Hindi; defaults to
 * "new" (start from basics) when the answer is unclear — the safer pitch.
 */
export function classifyFamiliarity(text: string): "new" | "some" | "confident" {
  const t = text.toLowerCase();
  if (/(never|nahi|nhi|नहीं|first time|pehli baar|पहली बार|no idea|bilkul naya|बिल्कुल नया|\bnew\b|naya|नया|don'?t know|nothing)/.test(t))
    return "new";
  if (/(confident|very well|acch?i tarah|अच्छी तरह|fully|poora|पूरा|master|expert|bahut|strong)/.test(t))
    return "confident";
  if (/(little|thoda|थोड़ा|some|kuch|कुछ|basic|heard|seen|dekha|सुना|बेसिक|bit)/.test(t)) return "some";
  if (/(yes|haan|हाँ|ha\b|yeah|yep|pata|आता|aata)/.test(t)) return "some";
  return "new";
}

/**
 * Does the student want a SPECIFIC textbook item worked — an example, exercise or
 * theorem? Those go to the planner/teacher model (Ultra) on the main board, not to
 * the quick doubt model. Keywords mirror lib/rag.ts (English, Hinglish, Hindi), so
 * "explain example 2", "solve exercise 4.1 Q3", "theorem 1.2 samjhao", "उदाहरण 3
 * समझाओ" all match. A bare "give me an example" also matches, which is fine — Ultra
 * then works a worked example on the main board.
 */
export function isExplainRequest(text: string): boolean {
  return /(examples?|udaharan|udhaaran|उदाहरण|exercises?|prashn?aavali|prashnavali|abhyaas|abhyas|प्रश्नावली|अभ्यास|theorems?|prameya|प्रमेय)/i.test(
    text,
  );
}

/**
 * In the solve track, is this a NEW question to work rather than a doubt about the
 * one just solved?
 *
 * The test is deliberately asymmetric. A doubt is the common case and the costlier
 * thing to get wrong (restarting the board instead of answering), so only two kinds
 * of message count as a new question: one that names a book item by position
 * ("exercise 5.3 q2", "अभ्यास 5.3"), or a bare "next"-style nudge with no question
 * word in it. Anything else — including anything with a question mark — is a doubt.
 */
export function isNextQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  // Names a specific item by number: unambiguously a new thing to solve.
  if (/(exercise|abhyaas|abhyas|prashnavali|प्रश्नावली|अभ्यास|question|prashn|sawaal|sawal|प्रश्न|सवाल|example|udaharan|उदाहरण|\bq\b)\s*[:#.\-]?\s*\d/i.test(t))
    return true;
  // A plain "do the next one" with nothing being asked about the current solution.
  if (/[?？]/.test(t)) return false;
  if (/(why|how|what|kyun|kyu|kaise|kya|क्यों|कैसे|क्या|samajh nahi|समझ नहीं|confus|doubt|explain|matlab|मतलब)/.test(t))
    return false;
  return /(next|aage|आगे|another|ek aur|एक और|agla|अगला|dusra|दूसरा|more|solve|karo|करो)/.test(t);
}

/**
 * During a doubt, decide whether the student's reply means "I'm satisfied, carry
 * on" (resume the lesson) rather than a further question. Anything with a question
 * mark, a question word, or a negation is treated as another doubt (returns false).
 */
export function isDoubtCleared(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (/[?？]/.test(t)) return false;
  if (/(no\b|nahi|nhi|नहीं|not |still|confus|samajh nahi|phir se|फिर से|but |lekin|kyun|kyu|why|how|kaise|kaisе|what|aur ek|एक और|doubt|wait|ruk)/.test(t))
    return false;
  return /(got it|understood|understand|clear|cleared|makes sense|ok\b|okay|yes|yeah|yep|done|next|continue|carry on|aage|आगे|move on|thanks|thank you|samajh|samjh|समझ|theek|thik|ठीक|haan|हाँ|accha|अच्छा|great|perfect)/.test(
    t,
  );
}

/**
 * Composer placeholder, written in the script of the selected language so the
 * input invites the student in the language they chose.
 */
/**
 * Spoken while the planner is thinking. Designing a lesson takes real time
 * (reasoning is on, by design), and a tutor that goes silent for half a minute
 * reads as broken — so Indica says what it is doing instead. Spoken one line at
 * a time and cut short the moment the plan lands, so a fast plan never has to
 * sit through all of it. Deliberately gender-neutral: Indica has no gender.
 */
export const PLANNING_LINES: Record<LanguageCode, readonly [string, string]> = {
  en: [
    "Good choice. Give me a moment — I'm planning how to teach you this.",
    "Working out the best order to build this up, step by step.",
  ],
  "en-IN": [
    "Achha topic hai. Ek minute do — iska plan ban raha hai.",
    "Sabse achha order dhoondh rahe hain, taaki step by step samajh aaye.",
  ],
  "hi-IN": [
    "अच्छा विषय है। एक मिनट दो — इसका प्लान बन रहा है।",
    "सबसे अच्छा क्रम चुन रहे हैं, ताकि कदम दर कदम समझ आए।",
  ],
  "bn-IN": [
    "ভালো বিষয় বেছেছ। এক মিনিট দাও — এর পরিকল্পনা তৈরি হচ্ছে।",
    "সবচেয়ে ভালো ক্রম বেছে নিচ্ছি, যাতে ধাপে ধাপে বুঝতে পারো।",
  ],
  "ta-IN": [
    "நல்ல தலைப்பு. ஒரு நிமிடம் கொடு — இதற்கான திட்டம் தயாராகிறது.",
    "படிப்படியாக புரிய வைக்க சிறந்த வரிசையைத் தேர்ந்தெடுக்கிறேன்.",
  ],
  "te-IN": [
    "మంచి అంశం. ఒక నిమిషం ఇవ్వు — దీనికి ప్రణాళిక తయారవుతోంది.",
    "అడుగు అడుగునా అర్థమయ్యేలా మంచి క్రమాన్ని ఎంచుకుంటున్నాను.",
  ],
  "mr-IN": [
    "चांगला विषय आहे. एक मिनिट दे — याचा आराखडा तयार होत आहे.",
    "टप्प्याटप्प्याने समजेल असा उत्तम क्रम निवडत आहे.",
  ],
  "gu-IN": [
    "સરસ વિષય છે. એક મિનિટ આપ — આનો પ્લાન તૈયાર થઈ રહ્યો છે.",
    "પગલું પગલું સમજાય એવો ઉત્તમ ક્રમ પસંદ કરી રહ્યા છીએ.",
  ],
  "kn-IN": [
    "ಒಳ್ಳೆಯ ವಿಷಯ. ಒಂದು ನಿಮಿಷ ಕೊಡು — ಇದಕ್ಕೆ ಯೋಜನೆ ಸಿದ್ಧವಾಗುತ್ತಿದೆ.",
    "ಹಂತ ಹಂತವಾಗಿ ಅರ್ಥವಾಗುವಂತೆ ಉತ್ತಮ ಕ್ರಮವನ್ನು ಆಯ್ಕೆ ಮಾಡುತ್ತಿದ್ದೇನೆ.",
  ],
  "ml-IN": [
    "നല്ല വിഷയം. ഒരു മിനിറ്റ് തരൂ — ഇതിന്റെ പ്ലാൻ തയ്യാറാകുന്നു.",
    "ഘട്ടം ഘട്ടമായി മനസ്സിലാകാൻ നല്ല ക്രമം തിരഞ്ഞെടുക്കുന്നു.",
  ],
  "pa-IN": [
    "ਵਧੀਆ ਵਿਸ਼ਾ ਹੈ। ਇੱਕ ਮਿੰਟ ਦੇ — ਇਸ ਦਾ ਪਲਾਨ ਤਿਆਰ ਹੋ ਰਿਹਾ ਹੈ।",
    "ਕਦਮ ਦਰ ਕਦਮ ਸਮਝ ਆਵੇ, ਇਸ ਲਈ ਵਧੀਆ ਕ੍ਰਮ ਚੁਣ ਰਹੇ ਹਾਂ।",
  ],
  "od-IN": [
    "ଭଲ ବିଷୟ। ଏକ ମିନିଟ୍ ଦିଅ — ଏହାର ଯୋଜନା ତିଆରି ହେଉଛି।",
    "ପାଦ ପାଦ କରି ବୁଝିବା ପାଇଁ ସବୁଠାରୁ ଭଲ କ୍ରମ ବାଛୁଛି।",
  ],
};

export function planningLines(code: string): readonly [string, string] {
  return PLANNING_LINES[isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE];
}

/**
 * Opens the spoken roadmap. Only a fallback: the planner writes its own `intro`
 * in the student's language, and this covers the case where it omitted it.
 */
export const ROADMAP_INTROS: Record<LanguageCode, string> = {
  en: "Here's how we'll learn this, step by step.",
  "en-IN": "Chalo, ise aise padhenge — step by step.",
  "hi-IN": "चलो, इसे ऐसे पढ़ेंगे — कदम दर कदम।",
  "bn-IN": "চলো, এভাবে শিখব — ধাপে ধাপে।",
  "ta-IN": "இதை இப்படிப் படிப்போம் — படிப்படியாக.",
  "te-IN": "ఇలా నేర్చుకుందాం — అడుగు అడుగునా.",
  "mr-IN": "चल, असं शिकू — टप्प्याटप्प्याने.",
  "gu-IN": "ચાલો, આમ શીખીશું — પગલું પગલું.",
  "kn-IN": "ಹೀಗೆ ಕಲಿಯೋಣ — ಹಂತ ಹಂತವಾಗಿ.",
  "ml-IN": "ഇങ്ങനെ പഠിക്കാം — ഘട്ടം ഘട്ടമായി.",
  "pa-IN": "ਆ, ਇਸ ਤਰ੍ਹਾਂ ਸਿੱਖਾਂਗੇ — ਕਦਮ ਦਰ ਕਦਮ।",
  "od-IN": "ଚାଲ, ଏମିତି ଶିଖିବା — ପାଦ ପାଦ କରି।",
};

export function roadmapIntro(code: string): string {
  return ROADMAP_INTROS[isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE];
}

/**
 * The handover back from a doubt to the lesson. The lesson is not re-planned or
 * re-fetched on a resume — its beats were generated before the doubt and are
 * still buffered — so this one line is all the student hears before teaching
 * carries on from the sentence it was interrupted in. Spoken from the cache,
 * like the planning filler.
 */
export const RESUME_LINES: Record<LanguageCode, string> = {
  en: "Good. Let's carry on with the lesson from where we stopped.",
  "en-IN": "Badhiya. Chalo, lesson wahin se continue karein jahan ruke the.",
  "hi-IN": "बढ़िया। चलो, पाठ वहीं से आगे बढ़ाएँ जहाँ रुके थे।",
  "bn-IN": "দারুণ। চলো, যেখানে থেমেছিলাম সেখান থেকেই পাঠ চালিয়ে যাই।",
  "ta-IN": "நல்லது. நிறுத்திய இடத்திலிருந்தே பாடத்தைத் தொடரலாம்.",
  "te-IN": "మంచిది. ఆపిన దగ్గర నుంచే పాఠాన్ని కొనసాగిద్దాం.",
  "mr-IN": "छान. चल, जिथे थांबलो होतो तिथूनच धडा पुढे नेऊ.",
  "gu-IN": "સરસ. ચાલો, જ્યાં અટક્યા હતા ત્યાંથી જ પાઠ આગળ વધારીએ.",
  "kn-IN": "ಒಳ್ಳೆಯದು. ನಿಲ್ಲಿಸಿದ ಜಾಗದಿಂದಲೇ ಪಾಠವನ್ನು ಮುಂದುವರಿಸೋಣ.",
  "ml-IN": "നല്ലത്. നിർത്തിയ ഇടത്തുനിന്നുതന്നെ പാഠം തുടരാം.",
  "pa-IN": "ਵਧੀਆ। ਆ, ਜਿੱਥੇ ਰੁਕੇ ਸੀ ਉੱਥੋਂ ਹੀ ਪਾਠ ਅੱਗੇ ਵਧਾਈਏ।",
  "od-IN": "ଭଲ। ଚାଲ, ଯେଉଁଠି ଅଟକି ଯାଇଥିଲୁ ସେଠାରୁ ହିଁ ପାଠ ଆଗେଇବା।",
};

export function resumeLine(code: string): string {
  return RESUME_LINES[isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE];
}

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
