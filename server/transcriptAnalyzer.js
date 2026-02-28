export async function aiAnalyzeTranscript(transcript) {
  if (!transcript || typeof transcript !== "string") {
    throw new Error("Transcript is required.");
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY in server/.env");
  }

  const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const prompt = `
You are an expert meeting effectiveness consultant.

Return ONLY valid JSON in this exact format:

{
  "model": "AI Meeting Analyzer",
  "summary": "<1 paragraph describing what the meeting did well>",
  "suggestions": "<1 paragraph describing one key improvement>"
}

Transcript:
"""${transcript}"""
`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.4,
          response_mime_type: "application/json"
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${errorText}`);
  }

  const data = await response.json();

  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

  const parsed = JSON.parse(text);

  return parsed;
}