import { generateText } from "ai";
import { google } from "@ai-sdk/google";

import { db } from "@/firebase/admin";
import { getRandomInterviewCover } from "@/lib/utils";

//
// ⭐ CORS SECTION — ONLY NEW ADDITION
//
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Credentials": "true",
};

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
// ⭐ END OF CORS SECTION
//

//
// ⭐ NEW FIX: strip ```json ``` wrappers
//
function cleanJSONBlock(block: string | null) {
  if (!block) return null;
  return block
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]$/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function truncate(str: string | null | undefined, n = 2000) {
  if (!str) return "";
  return str.length > n ? str.slice(0, n) + `... (truncated ${str.length - n} chars)` : str;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const { messages, userId } = body;

  if (!Array.isArray(messages)) {
    return new Response(
      JSON.stringify({ success: false, error: "Invalid or missing 'messages' array" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  if (!userId) {
    return new Response(
      JSON.stringify({ success: false, error: "Missing 'userId' in request body" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  // for debugging: capture model outputs
  let extractedText: string | null = null;
  let questionsText: string | null = null;
  let parsedQuestions: any = null;

  try {
    const { text: extText } = await generateText({
      model: google("gemini-2.0-flash-001"),
      prompt: `
You will be given a conversation between a user and an assistant.
Your job is to extract ONLY the following fields from the conversation and return exactly one valid JSON object (no extra text):

- role (job role)
- level (experience level)
- techstack (comma separated)
- type (behavioural or technical focus)
- amount (number of questions)

If a field is missing, return an empty string for text fields and null for amount.

Conversation:
${JSON.stringify(messages, null, 2)}
`
    });
    extractedText = extText ?? null;

    const extracted = safeJsonParse(extractedText || "");
    if (!extracted || typeof extracted !== "object") {
      console.error("DEBUG: Failed to parse extractedText:", extractedText);
      throw new Error("Failed to parse extracted variables from model output.");
    }

    const role = (extracted.role || "").toString().trim();
    const level = (extracted.level || "").toString().trim();
    const techstack = (extracted.techstack || "").toString().trim();
    const type = (extracted.type || "mixed").toString().trim();
    const amountRaw = extracted.amount;
    const amountParsed = Number.isInteger(amountRaw) ? amountRaw : parseInt(amountRaw, 10);
    const safeAmount = Number.isFinite(amountParsed) && amountParsed > 0 ? amountParsed : 10;
    const finalAmount = Math.min(safeAmount, 50);

    const { text: qText } = await generateText({
      model: google("gemini-2.0-flash-001"),
      prompt: `
      You MUST return ONLY valid JSON.

      Generate exactly ${finalAmount} interview questions based on:
      - Role: "${role || "unspecified"}"
      - Level: "${level || "unspecified"}"
      - Techstack: "${techstack || "unspecified"}"
      - Focus: "${type || "mixed"}"

      Return ONLY a JSON array.
      NO explanation.
      NO sentences.
      NO markdown.
      NO notes.
      NO extra text.

      Example format:
      [
        "Question 1",
        "Question 2"
      ]
      `
    });
    questionsText = qText ?? null;

    //
    // ⭐ FIX APPLIED HERE
    //
    const cleanedQuestions = cleanJSONBlock(questionsText || "");
    parsedQuestions = safeJsonParse(cleanedQuestions || "");

    if (!Array.isArray(parsedQuestions) || parsedQuestions.length === 0) {
      console.error("DEBUG: parsedQuestions invalid.");
      console.error("DEBUG: extractedText:", extractedText);
      console.error("DEBUG: questionsText:", questionsText);
      console.error("DEBUG: cleanedQuestions:", cleanedQuestions);
      console.error("DEBUG: parsedQuestions (raw):", parsedQuestions);

      return new Response(
        JSON.stringify({
          success: false,
          error: "Model did not return a valid questions array",
          debug: {
            extractedText: truncate(extractedText, 2000),
            questionsText: truncate(questionsText, 2000),
            cleanedQuestions,
            parsedQuestionsType: Object.prototype.toString.call(parsedQuestions),
            parsedQuestionsSample:
              parsedQuestions && Array.isArray(parsedQuestions)
                ? parsedQuestions.slice(0, 5)
                : parsedQuestions,
          },
        }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const questions = parsedQuestions.map((q: any) => (q || "").toString().trim());

    const techstackArray = techstack
      ? techstack.split(",").map((s: string) => s.trim()).filter(Boolean)
      : [];

    const interview = {
      role: role,
      type: type,
      level: level,
      techstack: techstackArray,
      questions: questions,
      userId: userId,
      finalized: true,
      coverImage: getRandomInterviewCover(),
      createdAt: new Date().toISOString(),
    };

    await db.collection("interviews").add(interview);

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Unhandled Error in /api/vapi/generate:", error);
    if (extractedText) console.error("Captured extractedText (truncated):", truncate(extractedText, 2000));
    if (questionsText) console.error("Captured questionsText (truncated):", truncate(questionsText, 2000));

    return new Response(
      JSON.stringify({
        success: false,
        error: String(error),
        debug: {
          extractedText: truncate(extractedText, 2000),
          questionsText: truncate(questionsText, 2000),
          parsedQuestionsType: typeof parsedQuestions,
        },
      }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }
}

export async function GET() {
  return new Response(
    JSON.stringify({ success: true, data: "Thank you!" }),
    { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
  );
}
