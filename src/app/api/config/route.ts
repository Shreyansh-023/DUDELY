import { connection } from "next/server";
import { describeModel, describeVoice } from "@/lib/llm";

/** GET /api/config — tells the browser which LLM / STT / TTS are wired up. */
export async function GET() {
  await connection(); // always evaluate at request time (env can differ per deployment)
  return Response.json({ llm: describeModel(), ...describeVoice() });
}
