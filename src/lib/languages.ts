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
 *
 * Sized to the real wait, not the median one: measured plan latency runs 27-127s
 * (p90 well past a minute), while a line is ~5s of speech at TTS_PACE 0.8. Two
 * lines covered ten seconds of a two-minute wait and the student then sat in
 * silence, so each language carries as many lines as it has. Where a language
 * has fewer, `planningLines` tops it up with the step titles the planner has
 * already streamed (see `designPlan`) and then rotates — real lesson content in
 * the student's own language beats invented filler in it.
 */
export const PLANNING_LINES: Record<LanguageCode, readonly string[]> = {
  en: [
    "Good choice. Give me a moment — I'm planning how to teach you this.",
    "Working out the best order to build this up, step by step.",
    "I'm checking your textbook chapter so we follow the same path your class does.",
    "Thinking about where students usually get stuck here, so we slow down at that part.",
    "Almost there — just deciding what to draw on the board for you.",
    "Thanks for waiting. A good plan now means this will make much more sense in a minute.",
  ],
  "en-IN": [
    "Achha topic hai. Ek minute do — iska plan ban raha hai.",
    "Sabse achha order dhoondh rahe hain, taaki step by step samajh aaye.",
    "Tumhari textbook ka chapter dekh rahe hain, taaki school jaisa hi padhein.",
    "Soch rahe hain ki is topic mein bachche kahan atakte hain — wahan dheere chalenge.",
    "Bas ho gaya — ye decide kar rahe hain ki board par kya banayenge.",
    "Thoda rukne ke liye thanks. Plan achha hoga to samajhna bahut aasaan ho jayega.",
  ],
  "hi-IN": [
    "अच्छा विषय है। एक मिनट दो — इसका प्लान बन रहा है।",
    "सबसे अच्छा क्रम चुन रहे हैं, ताकि कदम दर कदम समझ आए।",
    "तुम्हारी किताब का अध्याय देख रहे हैं, ताकि स्कूल जैसा ही पढ़ें।",
    "सोच रहे हैं कि इस विषय में बच्चे कहाँ अटकते हैं — वहाँ धीरे चलेंगे।",
    "बस हो गया — यह तय कर रहे हैं कि बोर्ड पर क्या बनाएँगे।",
    "रुकने के लिए धन्यवाद। अच्छा प्लान होगा तो समझना बहुत आसान हो जाएगा।",
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

export function planningLines(code: string): readonly string[] {
  return PLANNING_LINES[isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE];
}

/**
 * Spoken to fill the wait once the written filler has run out: "Step 3 — <title>",
 * one per plan step the planner has published so far, in the student's language.
 *
 * It is the one thing that scales with the wait for free. A long plan is exactly
 * the plan that takes long to design, so the slower the planner is, the more real
 * content there is to talk about while it finishes — and the student hears the
 * lesson taking shape instead of a stall.
 */
export const PLANNING_STEP_LEADS: Record<LanguageCode, (n: number, title: string) => string> = {
  en: (n, t) => `Step ${n}: ${t}.`,
  "en-IN": (n, t) => `Step ${n} — ${t}.`,
  "hi-IN": (n, t) => `चरण ${n} — ${t}।`,
  "bn-IN": (n, t) => `ধাপ ${n} — ${t}।`,
  "ta-IN": (n, t) => `படி ${n} — ${t}.`,
  "te-IN": (n, t) => `అడుగు ${n} — ${t}.`,
  "mr-IN": (n, t) => `टप्पा ${n} — ${t}।`,
  "gu-IN": (n, t) => `પગલું ${n} — ${t}.`,
  "kn-IN": (n, t) => `ಹಂತ ${n} — ${t}.`,
  "ml-IN": (n, t) => `ഘട്ടം ${n} — ${t}.`,
  "pa-IN": (n, t) => `ਕਦਮ ${n} — ${t}।`,
  "od-IN": (n, t) => `ପାଦ ${n} — ${t}।`,
};

/**
 * The last resort of the planning filler: a short line that can be said again
 * without sounding broken, for the tail of a wait that has outlasted both the
 * written lines and every step title the planner has published.
 *
 * Measured plan latency reaches 127s. Six written lines and a handful of step
 * titles cover about a minute of that, and the rest used to be silence — so this
 * keeps the room alive until the plan lands, varied enough to bear repeating.
 */
export const PLANNING_HOLDS: Record<LanguageCode, readonly string[]> = {
  en: ["Still working on it — nearly there.", "One moment more.", "Just putting the last piece in place."],
  "en-IN": ["Bas thoda aur — ho hi gaya.", "Ek minute aur.", "Last hissa set kar rahe hain."],
  "hi-IN": ["बस थोड़ा और — लगभग हो गया।", "एक पल और।", "आख़िरी हिस्सा जमा रहे हैं।"],
  "bn-IN": ["আর একটু — প্রায় হয়ে গেছে।", "আরও এক মুহূর্ত।"],
  "ta-IN": ["இன்னும் கொஞ்சம் — கிட்டத்தட்ட முடிந்தது.", "ஒரு நிமிடம் கூட."],
  "te-IN": ["ఇంకా కొంచెం — దాదాపు అయిపోయింది.", "ఒక్క క్షణం మరి."],
  "mr-IN": ["आणखी थोडं — जवळपास झालं.", "एक क्षण अजून."],
  "gu-IN": ["હજી થોડું — લગભગ થઈ ગયું.", "એક ક્ષણ વધુ."],
  "kn-IN": ["ಇನ್ನೂ ಸ್ವಲ್ಪ — ಬಹುತೇಕ ಆಯಿತು.", "ಒಂದು ಕ್ಷಣ ಇನ್ನೂ."],
  "ml-IN": ["ഇനിയും കുറച്ച് — ഏതാണ്ട് കഴിഞ്ഞു.", "ഒരു നിമിഷം കൂടി."],
  "pa-IN": ["ਹੋਰ ਥੋੜ੍ਹਾ — ਲਗਭਗ ਹੋ ਗਿਆ।", "ਇੱਕ ਪਲ ਹੋਰ।"],
  "od-IN": ["ଆଉ ଟିକେ — ପ୍ରାୟ ହୋଇଗଲା।", "ଆଉ ଏକ ମୁହୂର୍ତ୍ତ।"],
};

export function planningHolds(code: string): readonly string[] {
  return PLANNING_HOLDS[isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE];
}

export function planningStepLead(code: string, n: number, title: string): string {
  return PLANNING_STEP_LEADS[isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE](n, title);
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

// ---------------------------------------------------------------------------
// Checkpoint lines (spoken only, never written on the board).
//
// After each lesson step Indica stops and asks whether anything needs clearing
// up before moving on. That one question is what turns a 6-minute monologue
// into a real class: the student gets a held-open door at every subtopic
// boundary instead of having to barge in.
//
// All three sets are fixed templates per language — no LLM call — so they are
// instant and their speech caches across every lesson and every step, exactly
// like FAMILIARITY_PROMPTS and RESUME_LINES. They are spoken with `draw: []`:
// a checkpoint is conversation, not notes, and writing "any doubts?" on the
// board would leave a question mark stranded on the page under the step's
// working after the lesson has moved on.
//
// Each language carries SIX variants of the two handovers, picked at random,
// because these fire after every single step: the one fixed resume line that
// was fine for an occasional doubt turns into a tic when it is heard eight
// times in one lesson. The question itself is deliberately NOT randomised — it
// is the lesson's metronome, and the student should recognise it instantly as
// "this is my cue to speak".
// ---------------------------------------------------------------------------

/** The checkpoint question itself, asked after every step. */
export const CHECKPOINT_PROMPTS: Record<LanguageCode, string> = {
  en: "That's this part done. Any doubt here, or shall we move ahead?",
  "en-IN": "Yeh part ho gaya. Koi doubt hai isme, ya aage badhein?",
  "hi-IN": "यह हिस्सा हो गया। इसमें कोई शंका है, या आगे बढ़ें?",
  "bn-IN": "এই অংশটা শেষ। এখানে কোনো সন্দেহ আছে, নাকি এগিয়ে যাব?",
  "ta-IN": "இந்தப் பகுதி முடிந்தது. இதில் ஏதாவது சந்தேகம் இருக்கிறதா, அல்லது அடுத்ததற்குப் போகலாமா?",
  "te-IN": "ఈ భాగం పూర్తయింది. ఇందులో ఏదైనా సందేహం ఉందా, లేక ముందుకు వెళ్దామా?",
  "mr-IN": "हा भाग झाला. यात काही शंका आहे, की पुढे जाऊ?",
  "gu-IN": "આ ભાગ પૂરો થયો. આમાં કોઈ શંકા છે, કે આગળ વધીએ?",
  "kn-IN": "ಈ ಭಾಗ ಮುಗಿಯಿತು. ಇದರಲ್ಲಿ ಏನಾದರೂ ಸಂದೇಹ ಇದೆಯಾ, ಅಥವಾ ಮುಂದೆ ಹೋಗೋಣವಾ?",
  "ml-IN": "ഈ ഭാഗം കഴിഞ്ഞു. ഇതിൽ എന്തെങ്കിലും സംശയം ഉണ്ടോ, അതോ മുന്നോട്ട് പോകാമോ?",
  "pa-IN": "ਇਹ ਹਿੱਸਾ ਹੋ ਗਿਆ। ਇਸ ਵਿੱਚ ਕੋਈ ਸ਼ੰਕਾ ਹੈ, ਜਾਂ ਅੱਗੇ ਵਧੀਏ?",
  "od-IN": "ଏହି ଅଂଶ ହୋଇଗଲା। ଏଥିରେ କିଛି ସନ୍ଦେହ ଅଛି କି, ନା ଆଗକୁ ଯିବା?",
};

export function checkpointQuestion(code: string): string {
  return CHECKPOINT_PROMPTS[isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE];
}

/** Handover when the student had NO doubt: acknowledge, then carry on. */
export const CHECKPOINT_CLEAR_LINES: Record<LanguageCode, readonly string[]> = {
  en: [
    "Great, let's go ahead.",
    "Perfect. On to the next part.",
    "Good. Let's keep going.",
    "Lovely — moving on.",
    "Excellent. Next up.",
    "Nice. Let's carry on.",
  ],
  "en-IN": [
    "Badhiya, chalo aage badhein.",
    "Perfect. Agle part par chalein.",
    "Accha. Chalo, aage chalte hain.",
    "Shabaash — aage badhte hain.",
    "Bahut accha. Ab agla hissa.",
    "Theek hai. Chalo continue karein.",
  ],
  "hi-IN": [
    "बढ़िया, चलो आगे बढ़ें।",
    "शाबाश। अब अगले हिस्से पर चलें।",
    "अच्छा। चलो, आगे चलते हैं।",
    "बहुत अच्छा — आगे बढ़ते हैं।",
    "उत्तम। अब अगला भाग।",
    "ठीक है। चलो जारी रखें।",
  ],
  "bn-IN": [
    "দারুণ, চলো এগিয়ে যাই।",
    "খুব ভালো। এবার পরের অংশে।",
    "আচ্ছা। চলো, এগিয়ে চলি।",
    "বাহ — এগিয়ে যাচ্ছি।",
    "চমৎকার। এবার পরেরটা।",
    "ঠিক আছে। চলো চালিয়ে যাই।",
  ],
  "ta-IN": [
    "நல்லது, அடுத்ததற்குப் போகலாம்.",
    "அருமை. இப்போது அடுத்த பகுதி.",
    "சரி. தொடர்ந்து போகலாம்.",
    "பலே — முன்னேறுகிறோம்.",
    "மிகச் சிறப்பு. அடுத்தது.",
    "சரி. தொடரலாம்.",
  ],
  "te-IN": [
    "మంచిది, ముందుకు వెళ్దాం.",
    "చాలా బాగుంది. ఇప్పుడు తరువాతి భాగం.",
    "సరే. కొనసాగిద్దాం.",
    "భలే — ముందుకు సాగుతున్నాం.",
    "అద్భుతం. తరువాతిది.",
    "సరే. కొనసాగిద్దాం మరి.",
  ],
  "mr-IN": [
    "छान, चल पुढे जाऊ.",
    "मस्त. आता पुढचा भाग.",
    "बरं. चल, पुढे चालू.",
    "वाह — पुढे सरकतो आहोत.",
    "उत्तम. आता पुढचं.",
    "ठीक आहे. चल सुरू ठेवू.",
  ],
  "gu-IN": [
    "સરસ, ચાલો આગળ વધીએ.",
    "બહુ સારું. હવે આગળનો ભાગ.",
    "સારું. ચાલો, આગળ ચાલીએ.",
    "વાહ — આગળ વધી રહ્યા છીએ.",
    "ઉત્તમ. હવે આગળનું.",
    "ઠીક છે. ચાલો ચાલુ રાખીએ.",
  ],
  "kn-IN": [
    "ಒಳ್ಳೆಯದು, ಮುಂದೆ ಹೋಗೋಣ.",
    "ತುಂಬಾ ಚೆನ್ನಾಗಿದೆ. ಈಗ ಮುಂದಿನ ಭಾಗ.",
    "ಸರಿ. ಮುಂದುವರಿಸೋಣ.",
    "ಭೇಷ್ — ಮುಂದೆ ಸಾಗುತ್ತಿದ್ದೇವೆ.",
    "ಅತ್ಯುತ್ತಮ. ಈಗ ಮುಂದಿನದು.",
    "ಆಯ್ತು. ಮುಂದುವರಿಯೋಣ.",
  ],
  "ml-IN": [
    "നല്ലത്, നമുക്ക് മുന്നോട്ട് പോകാം.",
    "വളരെ നല്ലത്. ഇനി അടുത്ത ഭാഗം.",
    "ശരി. തുടരാം.",
    "കൊള്ളാം — മുന്നോട്ട് നീങ്ങുന്നു.",
    "മികച്ചത്. ഇനി അടുത്തത്.",
    "ശരി. നമുക്ക് തുടരാം.",
  ],
  "pa-IN": [
    "ਵਧੀਆ, ਆ ਅੱਗੇ ਵਧੀਏ।",
    "ਬਹੁਤ ਵਧੀਆ। ਹੁਣ ਅਗਲਾ ਹਿੱਸਾ।",
    "ਚੰਗਾ। ਆ, ਅੱਗੇ ਚੱਲੀਏ।",
    "ਸ਼ਾਬਾਸ਼ — ਅੱਗੇ ਵਧ ਰਹੇ ਹਾਂ।",
    "ਉੱਤਮ। ਹੁਣ ਅਗਲਾ।",
    "ਠੀਕ ਹੈ। ਆ ਜਾਰੀ ਰੱਖੀਏ।",
  ],
  "od-IN": [
    "ଭଲ, ଚାଲ ଆଗକୁ ଯିବା।",
    "ବହୁତ ଭଲ। ଏବେ ପରବର୍ତ୍ତୀ ଅଂଶ।",
    "ଆଚ୍ଛା। ଚାଲ, ଆଗକୁ ଚାଲିବା।",
    "ବାହା — ଆଗକୁ ବଢ଼ୁଛୁ।",
    "ଉତ୍ତମ। ଏବେ ପରବର୍ତ୍ତୀଟି।",
    "ଠିକ ଅଛି। ଚାଲ ଜାରି ରଖିବା।",
  ],
};

/** Handover after a doubt WAS answered: back to where the lesson stopped. */
export const CHECKPOINT_RESUME_LINES: Record<LanguageCode, readonly string[]> = {
  en: [
    "Good. Let's continue from where we left off.",
    "Right, back to the lesson where we stopped.",
    "Now that that's clear, let's pick up where we were.",
    "Good. Let's get back on track.",
    "Let's carry on from that point, then.",
    "Clear? Good — back to where we paused.",
  ],
  "en-IN": [
    "Badhiya. Chalo wahin se continue karein jahan ruke the.",
    "Theek, chalo lesson par wapas chalein jahan ruke the.",
    "Yeh clear ho gaya, to chalo wahin se shuru karein.",
    "Accha. Chalo wapas track par aayein.",
    "Chalo phir us point se aage badhein.",
    "Clear? Badhiya — wapas wahin chalein jahan ruke the.",
  ],
  "hi-IN": [
    "बढ़िया। चलो वहीं से आगे बढ़ें जहाँ रुके थे।",
    "ठीक, चलो पाठ पर वापस चलें जहाँ रुके थे।",
    "यह साफ़ हो गया, तो चलो वहीं से शुरू करें।",
    "अच्छा। चलो वापस पटरी पर आएँ।",
    "चलो फिर उसी जगह से आगे बढ़ें।",
    "समझ आया? बढ़िया — वापस वहीं चलें जहाँ रुके थे।",
  ],
  "bn-IN": [
    "দারুণ। চলো যেখানে থেমেছিলাম সেখান থেকেই এগিয়ে যাই।",
    "ঠিক আছে, চলো পাঠে ফিরে যাই যেখানে থেমেছিলাম।",
    "এটা পরিষ্কার হয়ে গেল, তাহলে চলো সেখান থেকেই শুরু করি।",
    "আচ্ছা। চলো আবার লাইনে ফিরি।",
    "চলো তাহলে সেই জায়গা থেকেই এগোই।",
    "বুঝলে? দারুণ — আবার সেখানেই ফিরি।",
  ],
  "ta-IN": [
    "நல்லது. நிறுத்திய இடத்திலிருந்தே தொடரலாம்.",
    "சரி, நின்ற இடத்திற்கே பாடத்திற்குத் திரும்பலாம்.",
    "இது தெளிவாகிவிட்டது, அந்த இடத்திலிருந்தே தொடங்கலாம்.",
    "சரி. மீண்டும் பாதைக்கு வருவோம்.",
    "அந்த இடத்திலிருந்தே முன்னேறலாம்.",
    "தெளிவா? நல்லது — நின்ற இடத்திற்கே திரும்புவோம்.",
  ],
  "te-IN": [
    "మంచిది. ఆపిన దగ్గర నుంచే కొనసాగిద్దాం.",
    "సరే, ఆగిన చోటికే పాఠానికి తిరిగి వెళ్దాం.",
    "ఇది స్పష్టమైంది, ఆ చోటి నుంచే మొదలుపెడ్దాం.",
    "సరే. తిరిగి దారిలోకి వచ్చేద్దాం.",
    "ఆ దగ్గర నుంచే ముందుకు సాగుదాం మరి.",
    "అర్థమైందా? మంచిది — ఆపిన చోటికే తిరిగి వెళ్దాం.",
  ],
  "mr-IN": [
    "छान. चल जिथे थांबलो होतो तिथूनच पुढे जाऊ.",
    "ठीक, चल धड्यावर परत जाऊ जिथे थांबलो होतो.",
    "हे स्पष्ट झालं, तर चल तिथूनच सुरू करू.",
    "बरं. चल परत रुळावर येऊ.",
    "चल मग त्या ठिकाणापासून पुढे जाऊ.",
    "समजलं? छान — परत तिथेच जाऊ.",
  ],
  "gu-IN": [
    "સરસ. ચાલો જ્યાં અટક્યા હતા ત્યાંથી આગળ વધીએ.",
    "ઠીક, ચાલો પાઠ પર પાછા જઈએ જ્યાં અટક્યા હતા.",
    "આ સ્પષ્ટ થઈ ગયું, તો ચાલો ત્યાંથી જ શરૂ કરીએ.",
    "સારું. ચાલો ફરી પાટા પર આવીએ.",
    "ચાલો તો એ જગ્યાએથી આગળ વધીએ.",
    "સમજાયું? સરસ — ફરી ત્યાં જ જઈએ.",
  ],
  "kn-IN": [
    "ಒಳ್ಳೆಯದು. ನಿಲ್ಲಿಸಿದ ಜಾಗದಿಂದಲೇ ಮುಂದುವರಿಸೋಣ.",
    "ಸರಿ, ನಿಂತ ಜಾಗಕ್ಕೇ ಪಾಠಕ್ಕೆ ಹಿಂತಿರುಗೋಣ.",
    "ಇದು ಸ್ಪಷ್ಟವಾಯಿತು, ಹಾಗಾದರೆ ಆ ಜಾಗದಿಂದಲೇ ಶುರು ಮಾಡೋಣ.",
    "ಆಯ್ತು. ಮತ್ತೆ ಹಾದಿಗೆ ಬರೋಣ.",
    "ಹಾಗಾದರೆ ಆ ಜಾಗದಿಂದಲೇ ಮುಂದೆ ಸಾಗೋಣ.",
    "ಅರ್ಥವಾಯಿತಾ? ಒಳ್ಳೆಯದು — ಮತ್ತೆ ಅಲ್ಲಿಗೇ ಹೋಗೋಣ.",
  ],
  "ml-IN": [
    "നല്ലത്. നിർത്തിയ ഇടത്തുനിന്നുതന്നെ തുടരാം.",
    "ശരി, നിന്ന ഇടത്തേക്കുതന്നെ പാഠത്തിലേക്ക് മടങ്ങാം.",
    "ഇത് വ്യക്തമായി, എന്നാൽ ആ ഇടത്തുനിന്നുതന്നെ തുടങ്ങാം.",
    "ശരി. വീണ്ടും വഴിയിലേക്ക് വരാം.",
    "എന്നാൽ ആ ഇടത്തുനിന്നുതന്നെ മുന്നോട്ട് പോകാം.",
    "മനസ്സിലായോ? നല്ലത് — വീണ്ടും അവിടേക്കുതന്നെ.",
  ],
  "pa-IN": [
    "ਵਧੀਆ। ਆ ਜਿੱਥੇ ਰੁਕੇ ਸੀ ਉੱਥੋਂ ਹੀ ਅੱਗੇ ਵਧੀਏ।",
    "ਠੀਕ, ਆ ਪਾਠ ਉੱਤੇ ਵਾਪਸ ਚੱਲੀਏ ਜਿੱਥੇ ਰੁਕੇ ਸੀ।",
    "ਇਹ ਸਾਫ਼ ਹੋ ਗਿਆ, ਤਾਂ ਆ ਉੱਥੋਂ ਹੀ ਸ਼ੁਰੂ ਕਰੀਏ।",
    "ਚੰਗਾ। ਆ ਵਾਪਸ ਲੀਹ ਉੱਤੇ ਆਈਏ।",
    "ਆ ਫਿਰ ਉਸ ਥਾਂ ਤੋਂ ਅੱਗੇ ਵਧੀਏ।",
    "ਸਮਝ ਆਇਆ? ਵਧੀਆ — ਵਾਪਸ ਉੱਥੇ ਹੀ ਚੱਲੀਏ।",
  ],
  "od-IN": [
    "ଭଲ। ଚାଲ ଯେଉଁଠି ଅଟକି ଯାଇଥିଲୁ ସେଠାରୁ ହିଁ ଆଗେଇବା।",
    "ଠିକ, ଚାଲ ପାଠକୁ ଫେରିବା ଯେଉଁଠି ଅଟକି ଯାଇଥିଲୁ।",
    "ଏହା ସ୍ପଷ୍ଟ ହୋଇଗଲା, ତେବେ ଚାଲ ସେଠାରୁ ହିଁ ଆରମ୍ଭ କରିବା।",
    "ଆଚ୍ଛା। ଚାଲ ପୁଣି ବାଟକୁ ଆସିବା।",
    "ଚାଲ ତେବେ ସେହି ଜାଗାରୁ ଆଗେଇବା।",
    "ବୁଝିଲ? ଭଲ — ପୁଣି ସେଇଠିକୁ ଯିବା।",
  ],
};

/**
 * One checkpoint handover, picked at random from the language's six.
 *
 * `cleared` tells the two sets apart: true after a doubt was answered ("let's
 * continue from where we left off"), false when the student had none in the
 * first place ("great, let's go ahead") — saying the former when nothing was
 * ever interrupted is the giveaway that nobody is listening.
 */
export function checkpointHandover(code: string, cleared: boolean): string {
  const lang = isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE;
  const lines = cleared ? CHECKPOINT_RESUME_LINES[lang] : CHECKPOINT_CLEAR_LINES[lang];
  return lines[Math.floor(Math.random() * lines.length)];
}

/**
 * Is the student's checkpoint answer a "no doubt, carry on"?
 *
 * The checkpoint asks a yes/no question ("any doubt, or shall we move ahead?"),
 * which `isDoubtCleared` was never written for: it is tuned for the end of a
 * doubt, where "yes" means "yes, I understood" and carries on. Here a bare
 * "yes"/"haan" is the opposite — "yes, I have a doubt" — and advancing on it
 * would walk past the very question that was asked. So "yes" alone is NOT a
 * clear here, and anything that reads as having something to ask falls through
 * to the doubt model.
 *
 * Nothing recognised either way is treated as a doubt: sending a sentence we
 * did not understand to the doubt model costs one answer the student can wave
 * off, while mis-reading a real question as "no doubt" loses it silently.
 */
export function isCheckpointClear(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  // Asking something outright — the question mark settles it.
  if (/[?？]/.test(t)) return false;
  // "no doubt" / "koi doubt nahi" / "koi shankaa nahi": a NEGATED doubt is the
  // plainest "carry on" there is, and it has to be read before the doubt
  // keywords below — they would otherwise match the word "doubt" inside it and
  // send the lesson off to answer a doubt the student just said they don't have.
  if (/(^|\s)(no|not any|nope|koi|kuch)\s+(doubt|doubts|question|questions|confusion|shankaa|shanka|prashn|sawaal|sawal)\b/.test(t))
    return true;
  if (/(doubt|shankaa|shanka|prashn|sawaal|sawal|confusion)\s*(nahi|nahin|nhi|na)\b|नहीं\s*(है)?$/.test(t) && /(doubt|शंका|प्रश्न|सवाल|सन्देह|संदेह)/.test(t))
    return true;
  // "yes, I have a doubt" / "ek doubt hai" / "samajh nahi aaya": a doubt, even
  // though some of these also contain a "no" ("nahi samajh aaya").
  if (
    /(doubt|confus|question|prashn|sawaal|sawal|प्रश्न|सवाल|शंका|সন্দেহ|samajh nahi|samjh nahi|nahi samajh|समझ नहीं|नहीं समझ|not clear|unclear|repeat|phir se|फिर से|dobara|दोबारा|again|wait|ruk|रुक|explain|samjhao|समझाओ|bata|बता|kyun|kyu|क्यों|kaise|कैसे|\bwhy\b|\bhow\b|\bwhat\b|kya |क्या )/.test(
      t,
    )
  )
    return false;
  // A plain "no" is the cleanest "no doubt" there is — and the most common.
  //
  // The boundaries are punctuation-aware, not whitespace-only. They used to be
  // `(^|\s)...(\s|$)`, and a real student saying "no, we can move forward" was
  // sent to the doubt model because of the COMMA: "no," is not "no" followed by
  // whitespace. The same sentence without the comma worked, which is the kind of
  // difference no student will ever predict. The gate's Yes/No buttons are the
  // real fix (nothing to parse at all); this keeps the spoken and typed paths
  // from tripping over the same thing.
  if (/(^|[\s,;.!—-])(no|nope|nahi|nahin|nhi|na)([\s,;.!?—-]|$)|नहीं|ନା|இல்ல|లేదు|ಇಲ್ಲ|ഇല്ല|নেই|নাই|નહીં|नाही/.test(t))
    return true;
  // Otherwise: an explicit "understood / all clear / move on".
  return /(got it|understood|understand|clear|cleared|makes sense|all good|\bok\b|okay|\bdone\b|next|continue|carry on|aage|आगे|move on|go ahead|chalo|चलो|thanks|thank you|samajh gaya|samajh gayi|samjh gaya|समझ गया|समझ गयी|समझ आया|theek|thik|ठीक|accha|अच्छा|great|perfect|fine|yes aage|haan aage)/.test(
    t,
  );
}

/**
 * The student was asked a real question and said something back. Is that
 * something a DODGE — "I don't know", or a question of their own — rather than
 * an attempt at an answer?
 *
 * Deliberately narrow, and it has to be: an attempt is the common case and the
 * grader is far better than a regex at judging one. So this only catches the two
 * things that are plainly not attempts, and everything else goes to the grader.
 *
 * "I don't know" is included on purpose even though the grader would mark it
 * wrong: the honest answer to it is to teach the thing again, which is the doubt
 * path, not a verdict and a tick in the wrong column.
 */
export function isAnswerDodge(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  // "I don't know" / "no idea" / "pata nahi" / "nahi aata" / "bhool gaya".
  if (
    /(don'?t know|dont know|do not know|no idea|not sure|pata nahi|pata nhi|nahi pata|nhi pata|पता नहीं|नहीं पता|nahi aata|nahi aata|नहीं आता|bhool gaya|bhul gaya|भूल गया|forgot|can'?t remember|yaad nahi|याद नहीं|skip|chhodo|छोड़ो)/.test(
      t,
    )
  )
    return true;
  // Asking back rather than answering: "can you explain again?", "repeat?",
  // "what do you mean?". A bare "?" counts; a question mark alongside a real
  // attempt ("is it 4?") does not, which is why an attempt has to be excluded
  // first — a hedged answer is still an answer.
  if (/[?？]/.test(t)) {
    if (/(what do you mean|kya matlab|क्या मतलब|matlab kya|repeat|phir se|फिर से|dobara|दोबारा|samjhao|समझाओ|explain|kaunsa|which one|wait|ruk)/.test(t))
      return true;
    return false;
  }
  return /(samajh nahi|samjh nahi|समझ नहीं|confus|explain again|teach again|phir se batao|फिर से बताओ)/.test(t);
}

/**
 * A step title with any leading number the planner wrote into it removed.
 *
 * The client numbers step titles itself, in two places — the roadmap contents
 * page and the heading at the top of each step's page — so a title that arrives
 * as "1. Kya hai quadratic equation?" renders as "1. 1. Kya hai quadratic
 * equation?". Observed live: the planner prompt asks for a title that "reads
 * sensibly after its number", which is enough to make some models helpfully
 * supply the number too.
 *
 * Tightening the prompt would not be enough on its own: the numbering is the
 * client's job, so the client has to be the thing that guarantees it. Strips a
 * leading "1." / "2)" / "3 -" / "४." and nothing else — a title that genuinely
 * opens with a number ("2x + 3 ka matlab") keeps it, because the pattern
 * requires the separator.
 */
export function stripStepNumber(title: string): string {
  return title.trim().replace(/^[0-9\u0966-\u096F\u0AE6-\u0AEF\u0BE6-\u0BEF\u0C66-\u0C6F\u0CE6-\u0CEF\u0D66-\u0D6F\u0A66-\u0A6F\u09E6-\u09EF]{1,2}\s*[.)\-:]\s+/, "").trim() || title.trim();
}

/**
 * What Indica says when a QUESTION SESSION opens.
 *
 * `VOICE_PROMPTS.greeting` asks what we should learn today, which is right for
 * study mode and wrong here: the solve track wants the name of a question, and
 * a student asked "what should we learn?" answers with a topic — which then has
 * to be turned away. Asking for the thing you actually want is cheaper than
 * recovering from the thing you asked for.
 */
export const SOLVE_GREETINGS: Record<LanguageCode, string> = {
  en: "Hello! Which question shall we solve? Name the exercise or example.",
  "en-IN": "Hello! Kaunsa question solve karein? Exercise ya example ka naam batao.",
  "hi-IN": "नमस्ते! कौन सा प्रश्न हल करें? अभ्यास या उदाहरण का नाम बताओ।",
  "bn-IN": "নমস্কার! কোন প্রশ্নটি সমাধান করব? অনুশীলনী বা উদাহরণের নাম বলো।",
  "ta-IN": "வணக்கம்! எந்தக் கேள்வியைத் தீர்க்கலாம்? பயிற்சி அல்லது எடுத்துக்காட்டின் பெயரைச் சொல்.",
  "te-IN": "నమస్కారం! ఏ ప్రశ్నను పరిష్కరిద్దాం? అభ్యాసం లేదా ఉదాహరణ పేరు చెప్పు.",
  "mr-IN": "नमस्कार! कोणता प्रश्न सोडवू? स्वाध्याय किंवा उदाहरणाचं नाव सांग.",
  "gu-IN": "નમસ્તે! કયો પ્રશ્ન ઉકેલીએ? સ્વાધ્યાય કે ઉદાહરણનું નામ કહે.",
  "kn-IN": "ನಮಸ್ಕಾರ! ಯಾವ ಪ್ರಶ್ನೆಯನ್ನು ಬಿಡಿಸೋಣ? ಅಭ್ಯಾಸ ಅಥವಾ ಉದಾಹರಣೆಯ ಹೆಸರು ಹೇಳು.",
  "ml-IN": "നമസ്കാരം! ഏത് ചോദ്യം ചെയ്യാം? അഭ്യാസത്തിന്റെയോ ഉദാഹരണത്തിന്റെയോ പേര് പറയൂ.",
  "pa-IN": "ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਕਿਹੜਾ ਸਵਾਲ ਹੱਲ ਕਰੀਏ? ਅਭਿਆਸ ਜਾਂ ਉਦਾਹਰਣ ਦਾ ਨਾਂ ਦੱਸ।",
  "od-IN": "ନମସ୍କାର! କେଉଁ ପ୍ରଶ୍ନ ସମାଧାନ କରିବା? ଅଭ୍ୟାସ କିମ୍ବା ଉଦାହରଣର ନାମ କୁହ।",
};

/** The opening line for a track: study mode asks for a topic, question mode for
 *  a question. */
export function trackGreeting(code: string, track: "learn" | "solve"): string {
  const lang = isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE;
  return track === "solve" ? SOLVE_GREETINGS[lang] : VOICE_PROMPTS[lang].greeting;
}
