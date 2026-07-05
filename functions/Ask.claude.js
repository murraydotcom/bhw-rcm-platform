// Netlify Function: ask-claude.js
// Sends a prompt to the Claude API and returns the response
// This is what makes the "Ask AI" / "Analyze" / "Fix" buttons work on the live Netlify site
// Environment variable needed in Netlify:
//   ANTHROPIC_API_KEY = your Anthropic API key (get one at console.anthropic.com)

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY not set in environment variables" }),
    };
  }

  try {
    const { prompt } = JSON.parse(event.body);

    if (!prompt || typeof prompt !== "string") {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing or invalid prompt" }),
      };
    }

    const systemPrompt = `You are an AI assistant embedded in BHW Medical Group's Revenue Cycle Management dashboard. 
You help Amaris Murray, CRNP (Founder/CEO/Medical Director) and her billing staff with:
- Medical billing, CPT/HCPCS coding, denial management, and payer appeals
- Revenue cycle strategy for a Maryland-based integrative primary care practice
- Practice programs: BHW Primary Care, Flow Vascular Stabilization, BHW Mind & Mood Recovery, CharmEd Minds, Chronic Care (APCM/CCM/BHI/RPM)
Keep answers practical, specific, and actionable. Use short paragraphs or bullet points. 
This is a live production tool, not a chat conversation, so be concise and get straight to the useful information.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ error: data.error?.message || "Claude API error" }),
      };
    }

    const text = data.content?.map((block) => block.text || "").join("\n") || "No response generated.";

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ response: text }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
