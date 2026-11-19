// api/analyze.js
// Vercel Serverless Function — MedFair AI Document Analyzer (OpenRouter Version)
//
// Accepts a multipart/form-data upload (JPG, PNG, or PDF), sends it directly to
// OpenRouter's gpt-4o-mini model for analysis, and returns strict JSON. The uploaded file
// is processed ENTIRELY IN MEMORY and is never written to disk or a database —
// this is a HIPAA-aligned "Ephemeral Processing" requirement, not optional.

const Busboy = require('busboy');

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

const CATEGORY_LEGAL_RULES = {
  bill:
    "Cite patient rights to an accurate, itemized statement under federal billing transparency standards and protection against unexpected/excessive charges under the federal No Surprises Act (Public Law 116-260). Formally demand a complete itemized bill with CPT/HCPCS codes, suspension of any collection activity while the account is under dispute, and a written adjustment within 30 days.",
  denial:
    "Cite internal appeal rights under the Affordable Care Act (ACA) and ERISA (29 U.S.C. § 1133) where applicable. Formally demand a full clinical review, the specific plan provisions and medical necessity criteria relied upon for the denial, and reversal of the adverse benefit determination within 30 days.",
  debt:
    "Cite the Fair Debt Collection Practices Act (FDCPA, 15 U.S.C. § 1692g) and Fair Credit Reporting Act (FCRA). Formally demand written validation of the alleged debt, proof of assignment from the original healthcare provider, a complete itemized accounting, and immediate cessation of collection calls or negative credit reporting until full validation is provided.",
};

function buildPrompt(category) {
  const context = CATEGORY_CONTEXT[category] || CATEGORY_CONTEXT.bill;
  const legalGuidance = CATEGORY_LEGAL_RULES[category] || CATEGORY_LEGAL_RULES.bill;

  return `You are MedFair's senior AI medical billing advocate and consumer rights analyst. The attached file is ${context}

Carefully read the ENTIRE document image/PDF and extract ALL visible details:
- Patient's full name, street address, city/state/zip, phone, or email (if printed on the document).
- Hospital / Provider / Insurance Company / Collection Agency name and full mailing address (if printed on the document).
- Account number, Invoice number, or Claim number.
- Date(s) of service, exact CPT/HCPCS codes, exact dollar amounts, and procedure/diagnosis descriptions.

Do NOT invent or fabricate any figure or name that is not visibly legible in the document. If a contact/address/account field is NOT visible in the document, leave its value as an empty string "" in "extracted_details".

Respond with ONLY a raw JSON object — no markdown, no code fences, no commentary before or after it — matching EXACTLY this structure:
{
  "summary_title": "A short, punchy alert headline based on the specific findings in THIS file",
  "key_findings": ["Specific detail 1 actually found in the document", "Specific detail 2 actually found in the document", "Specific detail 3 actually found in the document"],
  "action_plan": "Short, concrete next-step advice specific to this document (2-3 sentences max)",
  "extracted_details": {
    "patient_name": "Exact patient full name from document, or empty string if not visible",
    "patient_address": "Exact patient street, city, state, zip from document, or empty string if not visible",
    "patient_contact": "Exact patient phone/email from document, or empty string if not visible",
    "recipient_name": "Exact Hospital / Payer / Collector name from document, or empty string if not visible",
    "recipient_address": "Exact recipient mailing address from document, or empty string if not visible",
    "account_number": "Exact Account, Invoice, or Claim number from document, or empty string if not visible",
    "service_date": "Exact date(s) of service from document, or empty string if not visible"
  },
  "full_letter_content": "A comprehensive, formal, print-ready US dispute/appeal letter formatted cleanly in HTML using ONLY <p>, <br>, and <strong> tags (no markdown, no CSS styles, no outer html/body tags). CRITICAL RULE: Do NOT write bracketed placeholders like [Your Full Name] or [Your Address] anywhere in the letter. Instead, use these EXACT double-curly tokens so our app can populate them cleanly:
  1. Sender Header Block: <p>{{SENDER_NAME}}<br>{{SENDER_ADDRESS}}<br>{{SENDER_CONTACT}}<br><br>{{CURRENT_DATE}}</p>
  2. Recipient Block: <p><strong>Attn: Billing Dispute &amp; Patient Financial Services</strong><br>{{RECIPIENT_NAME}}<br>{{RECIPIENT_ADDRESS}}</p>
  3. Subject Line: <p><strong>RE: Formal Billing Dispute &amp; Request for Account Review — Patient: {{SENDER_NAME}} | Account/Claim #: {{ACCOUNT_NUMBER}} | Date of Service: {{SERVICE_DATE}}</strong></p>
  4. Salutation: <p>Dear Billing Department / Claims Review Officer,</p>
  5. Body Paragraphs: Clearly state the formal dispute, detailing every specific overcharge, duplicate charge, math discrepancy, CPT code error, or denial issue found in the document with exact dollar figures and dates.
  6. Legal Basis & Formal Demands: ${legalGuidance}
  7. Closing & Signature Block: Request written confirmation within 30 days, followed by <p>Sincerely,<br><br><br>___________________________<br><strong>{{SENDER_NAME}}</strong><br>Enclosures: Copy of Statement / Supporting Documentation</p>"
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

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'Server misconfigured: OPENROUTER_API_KEY is not set.' });
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

  // ---- 2. Send the file directly to OpenRouter (openai/gpt-4o-mini) ----
  let responseText;
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const base64Data = fileBuffer.toString('base64');
    const dataUri = `data:${fileMimeType};base64,${base64Data}`;

    const openRouterRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://www.medfair.us',
        'X-Title': 'MedFair'
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: buildPrompt(category) },
              { type: 'image_url', image_url: { url: dataUri } }
            ]
          }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2
      })
    });

    const data = await openRouterRes.json();

    if (!openRouterRes.ok) {
      console.error('OpenRouter API Error:', JSON.stringify(data, null, 2));
      return res.status(500).json({ error: 'AI analysis failed at OpenRouter Server.' });
    }

    responseText = data.choices[0].message.content;
  } catch (err) {
    console.error('OpenRouter API Exception:', err);
    return res.status(500).json({ error: 'Failed to communicate with AI model.' });
  }

  // ---- 3. Parse and Validate the AI Response ----
  let analysis;
  try {
    const cleanText = stripCodeFences(responseText);
    analysis = JSON.parse(cleanText);
  } catch (parseError) {
    console.error('Failed to parse JSON:', responseText);
    return res.status(500).json({ error: 'AI returned invalid data format.' });
  }

  const missingFields = REQUIRED_RESPONSE_FIELDS.filter((key) => !(key in analysis));
  if (missingFields.length > 0) {
    console.error('AI response missing fields:', missingFields, analysis);
    return res.status(500).json({ error: "AI response was incomplete." });
  }

  // fileBuffer / base64Data fall out of scope here and are never persisted anywhere.
  return res.status(200).json(analysis);
};
