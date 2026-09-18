/**
 * 321 Clementi Smart Parking Barcode Redemption Engine
 * AI Receipt Verification Service (PAN-84 / TSK-06)
 *
 * Uses Gemini 1.5 Flash Vision (pluggable interface) to OCR and validate
 * receipt images before a voucher is allocated. Enforces:
 *   1. is_receipt === true && is_legible === true
 *   2. total_amount >= 30.00 SGD
 *   3. receipt_date === today (SGT Asia/Singapore)
 *   4. tenant_name fuzzy-matches selected shop name (similarity >= 0.70)
 *   5. confidence_score >= 0.75
 *
 * Environment variable required: GEMINI_API_KEY
 * Optional n8n fallback: N8N_RECEIPT_VERIFIER_URL (overrides Gemini call)
 */

export interface ReceiptExtractionResult {
  /** False if image is a selfie, blurry object, car photo, parking ticket, etc. */
  is_receipt: boolean;
  /** False if text is unreadable, heavily cropped, or too blurry to parse. */
  is_legible: boolean;
  /** Store name as printed on the receipt header. Null if unreadable. */
  tenant_name: string | null;
  /** Grand total spend in SGD. Null if unreadable. */
  total_amount: number | null;
  /** Receipt date in YYYY-MM-DD format. Null if unreadable. */
  receipt_date: string | null;
  /** Receipt time in HH:MM:SS format. Null if unreadable. */
  receipt_time: string | null;
  /** Invoice / receipt / bill number. Null if unreadable. */
  receipt_number: string | null;
  /** Overall confidence score 0.0 – 1.0 */
  confidence_score: number;
  /** Human-readable rejection reason if invalid. */
  rejection_reason?: string | null;
}

export interface ReceiptVerificationResult {
  valid: boolean;
  /** HTTP error code to return if invalid. */
  http_status?: number;
  /** Machine error code. */
  error_code?: string;
  /** Human-readable message. */
  message?: string;
  /** Parsed extraction from AI. */
  extraction?: ReceiptExtractionResult;
}

// ---------------------------------------------------------------------------
// Internal: get today's date in Singapore time (SGT = UTC+8)
// ---------------------------------------------------------------------------
function getTodaySGT(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Singapore' });
}

// ---------------------------------------------------------------------------
// Internal: simple token-based fuzzy match (Jaccard on trigrams)
// ---------------------------------------------------------------------------
function computeSimilarity(a: string, b: string): number {
  const trigramSet = (s: string): Set<string> => {
    const normalized = s.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
    const trigrams = new Set<string>();
    for (let i = 0; i < normalized.length - 2; i++) {
      trigrams.add(normalized.slice(i, i + 3));
    }
    // Include unigrams and bigrams for very short strings
    for (let i = 0; i < normalized.length - 1; i++) {
      trigrams.add(normalized.slice(i, i + 2));
    }
    for (let i = 0; i < normalized.length; i++) {
      trigrams.add(normalized[i]);
    }
    return trigrams;
  };

  const setA = trigramSet(a);
  const setB = trigramSet(b);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

// ---------------------------------------------------------------------------
// Internal: extract structured JSON from Gemini 1.5 Flash Vision
// ---------------------------------------------------------------------------
async function callGeminiVision(
  imageBuffer: Uint8Array,
  mimeType: string,
  apiKey: string
): Promise<ReceiptExtractionResult> {
  const prompt = `You are a receipt OCR validator for a Singapore mall parking redemption system.
Analyse the provided image and extract structured data.
Respond ONLY with valid JSON matching this exact schema (no markdown, no explanation):
{
  "is_receipt": boolean,
  "is_legible": boolean,
  "tenant_name": string | null,
  "total_amount": number | null,
  "receipt_date": "YYYY-MM-DD" | null,
  "receipt_time": "HH:MM:SS" | null,
  "receipt_number": string | null,
  "confidence_score": number,
  "rejection_reason": string | null
}

Rules:
- is_receipt: true only for retail/F&B purchase receipts. False for selfies, parking tickets, car photos, random objects, screenshots of receipts.
- is_legible: true only if key fields (total, date, store name) are clearly readable.
- total_amount: Singapore dollar grand total. Extract numeric value only.
- receipt_date: date printed on receipt in YYYY-MM-DD format. null if unclear.
- confidence_score: your confidence in the extraction accuracy, 0.0 to 1.0.
- rejection_reason: brief reason if is_receipt or is_legible is false, else null.`;

  // Convert Uint8Array to base64
  let binary = '';
  for (let i = 0; i < imageBuffer.length; i++) {
    binary += String.fromCharCode(imageBuffer[i]);
  }
  const base64Image = btoa(binary);

  const requestBody = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Image,
            },
          },
        ],
      },
    ],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 512,
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(15_000), // 15-second timeout
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'unknown');
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json() as any;
  const rawText: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  let parsed: ReceiptExtractionResult;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // Attempt to strip markdown fences if Gemini wrapped output
    const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      parsed = JSON.parse(fenceMatch[1]);
    } else {
      throw new Error(`Gemini returned non-JSON response: ${rawText.slice(0, 200)}`);
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Internal: call n8n webhook fallback verifier
// ---------------------------------------------------------------------------
async function callN8nVerifier(
  imageBuffer: Uint8Array,
  mimeType: string,
  webhookUrl: string
): Promise<ReceiptExtractionResult> {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(imageBuffer)], { type: mimeType });
  formData.append('receipt_image', blob, 'receipt.jpg');

  const response = await fetch(webhookUrl, {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`n8n verifier error ${response.status}`);
  }

  return response.json() as Promise<ReceiptExtractionResult>;
}

// ---------------------------------------------------------------------------
// Public: SHA-256 hash of a Uint8Array (for receipt_hash deduplication)
// ---------------------------------------------------------------------------
export async function sha256Buffer(buffer: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Public: Build semantic fingerprint hash
// fingerprint = SHA-256(shop_id + ':' + receipt_date + ':' + UPPER(TRIM(receipt_number)))
// ---------------------------------------------------------------------------
export async function buildReceiptFingerprintHash(
  shopId: string,
  receiptDate: string,
  receiptNumber: string | null
): Promise<string | null> {
  if (!receiptNumber || receiptNumber.trim() === '') return null;
  const encoder = new TextEncoder();
  const raw = `${shopId}:${receiptDate}:${receiptNumber.toUpperCase().trim()}`;
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(raw));
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Public: Main verification entry point
// ---------------------------------------------------------------------------
export async function verifyReceipt(
  imageBuffer: Uint8Array,
  mimeType: string,
  selectedShopName: string
): Promise<ReceiptVerificationResult> {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const n8nUrl = process.env.N8N_RECEIPT_VERIFIER_URL;

  if (!geminiApiKey && !n8nUrl) {
    // In development/testing without keys: fail-open with a warning
    // In production this env var must be set — missing key = fail-closed
    if (process.env.NODE_ENV === 'production') {
      return {
        valid: false,
        http_status: 503,
        error_code: 'VERIFIER_UNAVAILABLE',
        message: 'Receipt verification service is not configured.',
      };
    }
    // Dev/test: skip verification (allow all)
    return { valid: true };
  }

  let extraction: ReceiptExtractionResult;
  try {
    if (n8nUrl) {
      extraction = await callN8nVerifier(imageBuffer, mimeType, n8nUrl);
    } else {
      extraction = await callGeminiVision(imageBuffer, mimeType, geminiApiKey!);
    }
  } catch (err: any) {
    return {
      valid: false,
      http_status: 502,
      error_code: 'VERIFIER_TIMEOUT',
      message: 'Receipt verification service timed out. Please try again.',
    };
  }

  // --- Gate 1: Must be a legible receipt ---
  if (!extraction.is_receipt) {
    return {
      valid: false,
      http_status: 400,
      error_code: 'INVALID_RECEIPT',
      message: extraction.rejection_reason || 'The uploaded image does not appear to be a valid receipt.',
      extraction,
    };
  }
  if (!extraction.is_legible) {
    return {
      valid: false,
      http_status: 400,
      error_code: 'LOW_CONFIDENCE_IMAGE',
      message: 'Receipt image is too blurry or unclear to read. Please take a clearer photo.',
      extraction,
    };
  }

  // --- Gate 2: Confidence threshold ---
  if (extraction.confidence_score < 0.75) {
    return {
      valid: false,
      http_status: 400,
      error_code: 'LOW_CONFIDENCE_IMAGE',
      message: `Receipt image quality too low (confidence: ${(extraction.confidence_score * 100).toFixed(0)}%). Please take a clearer photo.`,
      extraction,
    };
  }

  // --- Gate 3: Minimum spend ---
  if (extraction.total_amount === null) {
    return {
      valid: false,
      http_status: 400,
      error_code: 'RECEIPT_VALIDATION_FAILED',
      message: 'Could not read total amount from receipt.',
      extraction,
    };
  }
  if (extraction.total_amount < 30.00) {
    return {
      valid: false,
      http_status: 400,
      error_code: 'MINIMUM_SPEND_NOT_MET',
      message: `Minimum spend of $30.00 required. Receipt shows $${extraction.total_amount.toFixed(2)}.`,
      extraction,
    };
  }

  // --- Gate 4: Receipt date must be today (SGT) ---
  const todaySGT = getTodaySGT();
  if (extraction.receipt_date === null) {
    return {
      valid: false,
      http_status: 400,
      error_code: 'RECEIPT_VALIDATION_FAILED',
      message: 'Could not read receipt date. Please use a receipt from today.',
      extraction,
    };
  }
  if (extraction.receipt_date !== todaySGT) {
    return {
      valid: false,
      http_status: 400,
      error_code: 'RECEIPT_EXPIRED',
      message: `Receipt is from ${extraction.receipt_date}. Only today's receipts are accepted.`,
      extraction,
    };
  }

  // --- Gate 5: Tenant/shop name fuzzy match (>= 0.70 Jaccard similarity) ---
  if (extraction.tenant_name !== null) {
    const similarity = computeSimilarity(extraction.tenant_name, selectedShopName);
    if (similarity < 0.70) {
      return {
        valid: false,
        http_status: 400,
        error_code: 'STORE_MISMATCH',
        message: `Receipt appears to be from "${extraction.tenant_name}", not the selected store. Please select the correct store.`,
        extraction,
      };
    }
  }

  return { valid: true, extraction };
}
