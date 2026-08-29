// api/analyze.js
// Vercel Serverless Function — MedFair AI Document Analyzer
//
// Accepts a multipart/form-data upload (JPG, PNG, or PDF), sends it directly to
// Google Gemini 1.5 Flash for analysis, and returns strict JSON. The uploaded file
// is processed ENTIRELY IN MEMORY and is never written to disk or a database —
// this is a HIPAA-aligned "Ephemeral Processing" requirement, not optional.

const Busboy = require('busboy');
const { GoogleGenAI } = require('@google/genai');

// Required only when this file is deployed as a Next.js API route (harmless otherwise,
// plain Vercel functions in a bare /api folder never auto-parse multipart bodies).
module.exports.config = {
  api: { bodyParser: false },
};

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const REQUIRED_RESPONSE_FIELDS = ['summary_title', 'key_findings', 'action_plan', 'full_letter_content'];

const CATEGORY_CONTEXT = {
  bill:
    "a MEDICAL BILL or itemized hospital/provider invoice. Focus on the exact CPT/HCPCS billing codes, line-item charges, duplicate charges, upcoding, bundled services billed separately, and any amount that looks like an overcharge.",
  denial:
    "an INSURANCE DENIAL LETTER or Explanation of Benefits (EOB). Focus on the exact denial reason code and text, the payer's stated justification, the claim/service date, the CPT/diagnosis codes referenced, and the appeal deadline.",
  debt:
    "a MEDICAL DEBT COLLECTION NOTICE. Focus on the exact amount claimed, the original creditor/provider, the collection agency name, the age of the debt, and whether a proper FDCPA validation notice was included.",
};

function buildPrompt(category) {
  const context = CATEGORY_CONTEXT[category] || CATEGORY_CONTEXT.bill;
  return `You are MedFair's AI medical billing analyst. The attached file is ${context}

Carefully read the ENTIRE document image/PDF and extract the EXACT, SPECIFIC details that are visibly present: real CPT/HCPCS codes, real dollar amounts, real dates, real provider/payer/collector names, real denial reason codes, and exact procedure or diagnosis descriptions. Do NOT invent, guess, or generalize any figure that is not actually legible in the document — if something specific can't be read, say so plainly instead of fabricating it.

Respond with ONLY a raw JSON object — no markdown, no code fences, no commentary before or after it — matching EXACTLY this structure:
{
  "summary_title": "A short alert headline based on the specific findings in THIS file",
  "key_findings": ["Specific detail 1 actually found in the document", "Specific detail 2 actually found in the document", "Specific detail 3 actually found in the document"],
  "action_plan": "Short, concrete next-step advice specific to this document (2-3 sentences max)",
  "full_letter_content": "A highly specific, print-ready dispute/appeal letter as an HTML string using ONLY <p>, <br>, and <strong> tags. It MUST reference the exact medical data extracted above (codes, amounts, dates, names) and be ready to send as-is."
}`;
}

function parseMultipartInMemory(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
    });

    let category = 'bill';
    let fileChunks = [];
    let fileMimeType = null;
    let fileName = null;
    let sawFile = false;
    let fileTooLarge = false;

    busboy.on('field', (name, value) => {
      if (name === 'category') category = value;
    });

    busboy.on('file', (_name, fileStream, info) => {
      sawFile = true;
      fileMimeType = info.mimeType;
      fileName = info.filename;

      fileStream.on('data', (chunk) => {
        fileChunks.push(chunk);
      });
      fileStream.on('limit', () => {
        fileTooLarge = true;
      });
    });

    busboy.on('close', () => {
      if (fileTooLarge) return reject(Object.assign(new Error('File exceeds the 10MB limit.'), { code: 'FILE_TOO_LARGE' }));
      if (!sawFile) return reject(Object.assign(new Error('No file was uploaded.'), { code: 'NO_FILE' }));

      // Buffer lives only in this function's RAM for the lifetime of this request —
      // it is never written to disk and is garbage-collected once the response is sent.
      const fileBuffer = Buffer.concat(fileChunks);
      resolve({ fileBuffer, fileMimeType, fileName, category });
    });

    busboy.on('error', (err) => reject(err));

    req.pipe(busboy);
  });
}

function stripCodeFences(text) {
  // Gemini's JSON mode should already return raw JSON, but strip fences defensively
  // in case a model revision ever wraps output in ```json ... ``` again.
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Server misconfigured: GEMINI_API_KEY is not set.' });
  }

  // ---- 1. Parse the upload strictly in memory ----
  let parsed;
  try {
    parsed = await parseMultipartInMemory(req);
  } catch (err) {
    if (err.code === 'FILE_TOO_LARGE') return res.status(413).json({ error: 'File exceeds the 10MB limit.' });
    if (err.code === 'NO_FILE') return res.status(400).json({ error: 'No file was uploaded. Please attach a JPG, PNG, or PDF.' });
    console.error('Multipart parse error:', err);
    return res.status(400).json({ error: 'Could not read the uploaded file.' });
  }

  const { fileBuffer, fileMimeType, category } = parsed;

  if (!ALLOWED_MIME_TYPES.includes(fileMimeType)) {
    return res.status(415).json({ error: 'Only JPG, PNG, or PDF files are supported.' });
  }

  // ---- 2. Send the file directly to Gemini 1.5 Flash (no disk, no DB) ----
  let responseText;
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const base64Data = fileBuffer.toString('base64');

    const result = await ai.models.generateContent({
      model: 'gemini-1.5-pro',
      contents: [
        { inlineData: { mimeType: fileMimeType, data: base64Data } },
        { text: buildPrompt(category) },
      ],
      config: {
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    });

    responseText = result.text;
  } catch (err) {
    console.error('Gemini API error:', err);
    return res.status(502).json({ error: 'AI analysis failed. Please try again in a moment.' });
  }

  // ---- 3. Validate strict JSON shape before returning to the client ----
  let analysis;
  try {
    analysis = JSON.parse(stripCodeFences(responseText || ''));
  } catch (err) {
    console.error('Failed to parse Gemini JSON response:', responseText);
    return res.status(502).json({ error: 'The AI returned an unreadable response. Please try again.' });
  }

  const missingFields = REQUIRED_RESPONSE_FIELDS.filter((key) => !(key in analysis));
  if (missingFields.length > 0) {
    console.error('Gemini response missing fields:', missingFields, analysis);
    return res.status(502).json({ error: `AI response was incomplete (missing: ${missingFields.join(', ')}).` });
  }

  // fileBuffer / base64Data fall out of scope here and are never persisted anywhere.
  return res.status(200).json(analysis);
};
