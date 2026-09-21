# ADR-002: AI Receipt Verification and Multi-Tier Anti-Bot Gates

**Status:** Accepted

## Context & Problem Statement
The parking receipt redemption system needs to autonomously verify shopper receipts to ensure a minimum purchase of $30 is met for the current day without exposing the API to abuse (e.g., bot submissions, spam, or duplicate receipt uploads). How do we seamlessly and securely validate proof-of-spend while defending against automated abuse?

## Decision Drivers
- Automate minimum spend ($30) and same-day date validation.
- Prevent identical receipts from being used across multiple redemptions.
- Defend the public API against automated bot nets attempting to secure Code-128 vouchers.
- Provide a robust integration sequence with fallback capabilities in the event of primary API failure.

## Considered Options
### 1. Manual Validation
- **Pros**: Complete accuracy.
- **Cons**: Requires human operators. Fails the "autonomous system" requirement.
### 2. Traditional OCR (Tesseract / AWS Textract)
- **Pros**: Known operational costs, established patterns.
- **Cons**: Highly rigid. Fails on folded, crumpled, or non-standard receipts. Requires complex regex post-processing.
### 3. LLM Vision (Gemini 1.5 Flash Vision) with n8n Fallback
- **Pros**: Highly adaptable to arbitrary receipt formats and unstructured text. Built-in logical inference ("Is the date today?"). The n8n routing allows fallback handling or operator intervention overrides.
- **Cons**: Inference latency (typically 1–3s). Requires external API dependencies.

## Decision Outcome
We have selected **Option 3** alongside an **8-gate multi-tier pipeline** integrated into `POST /api/v1/redemptions`.

The submission pipeline evaluates rapidly failing gates to protect the external LLM boundary:
1. **Honeypot (`hp_company_field`) & Timing Gate (<1500ms)** to reject naïve bots.
2. **Cloudflare Turnstile** for computational browser validation.
3. **IP-based Rate Limiter** (sliding window).
4. **Plate Format Constraints** (LTA Mod-19).
5. **Invariant Daily Limit** (1 redemption per plate).
6. **Binary SHA-256 Receipt Hash Deduplication** (Migration 0003 enforcement `uq_redemption_receipt_hash_daily`).
7. **Semantic AI Payload Structure** (Extract receipt number, shop details, total spend).
8. **AI Receipt Verification** natively hitting Gemini 1.5 Flash, with a pre-configured `N8N_RECEIPT_VERIFIER_URL` webhook serving as an override or traffic-routing fallback.

## Consequences
- **Positive**: True autonomous operation. Negligible fraud risk due to exact cryptographic hashing combined with AI semantic checks.
- **Negative**: Increased configuration surface (Turnstile credentials, Gemini APi Key, n8n endpoints). The LLM call acts as the longest blocking operation of the API endpoint.