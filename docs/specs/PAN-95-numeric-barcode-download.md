# PAN-95: 10-Digit Numeric Barcode Generation & Download Capability

### 1. Executive Summary & Business Objective
- **Problem Statement:** The parking redemption gantry scanners require a 10-digit strictly numeric barcode to validate free parking successfully. Additionally, users need a way to save this barcode locally for easy retrieval at the exit without relying on a live internet connection.
- **Success Metrics:**
  - 100% of newly generated `voucher_code`s are exactly 10 numeric digits.
  - Support client-side download of the barcode as a PNG/SVG image.
  - Zero exit gantry scanner rejections caused by alphanumeric codes or incorrect length.

### 2. User Stories & Acceptance Criteria (Gherkin Format)
- **User Story 1:** As a parking patron, I want my barcode to be perfectly compatible with the parking exit scanners so that I do not get stuck when leaving.
- **User Story 2:** As a parking patron, I want to download my generated parking barcode to my phone so that I can easily scan it at the gantry without needing internet connectivity.

- **Acceptance Criteria:**
  - **Scenario: Generating a valid numeric barcode**
    - Given a valid parking redemption request
    - When the application pulls or creates a voucher code
    - Then the `voucher_code` payload must consist of exactly 10 numeric characters (0-9).
  - **Scenario: Downloading the barcode**
    - Given the barcode is successfully rendered on the screen
    - When the user taps the "Download" or "Save" button
    - Then the browser should prompt the user to download the barcode as a PNG or SVG image.
    - And the output file name should include context (e.g., `321Clementi-Barcode-[VoucherCode].png`).
  - **Scenario: Handling legacy alphanumeric codes**
    - Given an existing voucher in the pool that is alphanumeric
    - When it is rendered
    - Then the system must log a warning and ideally prevent this code from being allocated to new users.

### 3. Functional & Technical Requirements
- **Data & Schema:**
  - The `voucher_code` column in the `VoucherPool` table must enforce (or be seeded exclusively with) strings matching `^[0-9]{10}$`.
  - The seeding scripts must be updated to produce exclusively numeric 10-digit codes.
- **UI/UX Workflows:**
  - Render a clear "Download to Device" button directly near the barcode component on the Redemption Success page.
  - The download mechanism should ideally serialize the DOM node containing the barcode (e.g., using `html-to-image` or a canvas export) or export the raw SVG.
- **API Contract Expectations:**
  - Allocation API behavior remains unchanged but MUST return only 10-digit numeric strings.

### 4. Non-Functional Requirements (NFRs)
- **Performance:** Client-side image rendering and download should happen instantly (< 200ms) to ensure a smooth user experience.
- **Security:** The download must occur cleanly on the client side to avoid backend rendering loads or exposure to injection vectors during file creation.
- **Compatibility:** The download must work smoothly across iOS Safari and Android Chrome, which make up the vast majority of users at the mall.

### 5. Edge Cases & Risk Mitigation
- **Potential Failure Modes:**
  - **Legacy Database Entries:** Current unallocated vouchers in the `voucher_pool` might not meet the 10-digit numeric criteria. **Mitigation:** The tech lead must determine if we need to purge/re-seed the existing pool or if there is a safe filtering mechanism.
  - **Device Download Restrictions:** In-app browsers (like Telegram, Facebook, or Instagram wrappers) sometimes block file downloads. **Mitigation:** Include fallback UI instructions such as "Long-press to save image" or "Take a screenshot".
- **Open Questions:**
  - Does the Tech Lead prefer `Code 128` (which easily supports numbers) or `Interleaved 2 of 5` (which is standard for purely numeric symbols)?
  - Is there a specific prefix required for the 10 digits (e.g., `00...`) by the parking vendor, or is it fully randomized?
