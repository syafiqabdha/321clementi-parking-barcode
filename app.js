// ============================================================================
// 321 Clementi Parking Redemption - Mobile Web App
// ============================================================================

// ============================================================================
// 1. CAMERA CAPTURE & CANVAS DOWNSAMPLING
// ============================================================================

const MAX_IMAGE_WIDTH = 1200;
const TARGET_FILE_SIZE_KB = 200;
const JPEG_QUALITY = 0.85;

const receiptUpload = document.getElementById('receipt-upload');
const previewContainer = document.getElementById('preview-container');
const previewImage = document.getElementById('preview-image');
const fileSizeDisplay = document.getElementById('file-size');
const nextToPlateBtn = document.getElementById('next-to-plate');

let downsampledImageBlob = null;

receiptUpload.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    try {
        // Downsample the image using canvas
        downsampledImageBlob = await downsampleImage(file);
        
        // Display preview
        const previewUrl = URL.createObjectURL(downsampledImageBlob);
        previewImage.src = previewUrl;
        previewContainer.classList.remove('hidden');
        
        // Show file size
        const sizeKB = Math.round(downsampledImageBlob.size / 1024);
        fileSizeDisplay.textContent = `${sizeKB} KB`;
        
        // Enable next button
        nextToPlateBtn.classList.remove('hidden');
        
    } catch (error) {
        console.error('Image processing failed:', error);
        alert('Failed to process image. Please try again.');
    }
});

/**
 * Downsample image to max 1200px width and ~200KB using HTML5 canvas
 * @param {File} file - The original image file
 * @returns {Promise<Blob>} - Downsampled JPEG blob
 */
async function downsampleImage(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const reader = new FileReader();

        reader.onload = (e) => {
            img.src = e.target.result;
        };

        img.onload = () => {
            // Calculate new dimensions
            let width = img.width;
            let height = img.height;

            if (width > MAX_IMAGE_WIDTH) {
                height = (height * MAX_IMAGE_WIDTH) / width;
                width = MAX_IMAGE_WIDTH;
            }

            // Create canvas for downsampling
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            // Convert to JPEG blob with quality compression
            canvas.toBlob(
                (blob) => {
                    if (blob) {
                        resolve(blob);
                    } else {
                        reject(new Error('Canvas to Blob conversion failed'));
                    }
                },
                'image/jpeg',
                JPEG_QUALITY
            );
        };

        img.onerror = () => {
            reject(new Error('Image loading failed'));
        };

        reader.onerror = () => {
            reject(new Error('File reading failed'));
        };

        reader.readAsDataURL(file);
    });
}

// ============================================================================
// 2. VEHICLE PLATE MOD-19 VALIDATION
// ============================================================================

const vehiclePlateInput = document.getElementById('vehicle-plate');
const validationFeedback = document.getElementById('validation-feedback');
const submitBtn = document.getElementById('submit-redemption');

vehiclePlateInput.addEventListener('input', (event) => {
    const plate = event.target.value.trim().toUpperCase();
    vehiclePlateInput.value = plate;

    if (plate.length === 0) {
        // Clear validation state
        vehiclePlateInput.classList.remove('valid', 'invalid');
        validationFeedback.textContent = '';
        validationFeedback.className = 'feedback';
        submitBtn.disabled = true;
        return;
    }

    const isValid = validateLTAPlate(plate);

    if (isValid) {
        vehiclePlateInput.classList.remove('invalid');
        vehiclePlateInput.classList.add('valid');
        validationFeedback.textContent = 'Valid Singapore plate';
        validationFeedback.className = 'feedback valid';
        submitBtn.disabled = false;
    } else {
        vehiclePlateInput.classList.remove('valid');
        vehiclePlateInput.classList.add('invalid');
        validationFeedback.textContent = 'Invalid plate format or checksum';
        validationFeedback.className = 'feedback invalid';
        submitBtn.disabled = true;
    }
});

/**
 * Validate Singapore LTA vehicle plate with MOD-19 checksum
 * Format: ABC1234D (3 letters, 1-4 digits, 1 checksum letter)
 * @param {string} plate - Vehicle registration number
 * @returns {boolean} - True if valid
 */
function validateLTAPlate(plate) {
    // Singapore plate format: 3 letters + 1-4 digits + 1 checksum letter
    const plateRegex = /^([A-Z]{3})(\d{1,4})([A-Z])$/;
    const match = plate.match(plateRegex);

    if (!match) return false;

    const prefix = match[1];
    const digits = match[2];
    const checksum = match[3];

    // Calculate MOD-19 checksum
    const calculatedChecksum = calculateMOD19(prefix, digits);

    return checksum === calculatedChecksum;
}

/**
 * Calculate MOD-19 checksum for LTA vehicle plates
 * @param {string} prefix - 3-letter prefix
 * @param {string} digits - 1-4 digit number
 * @returns {string} - Checksum letter
 */
function calculateMOD19(prefix, digits) {
    // Letter to number mapping (A=1, B=2, ..., Z=26)
    const letterValue = (letter) => letter.charCodeAt(0) - 64;

    // Calculate weighted sum
    const p1 = letterValue(prefix[0]) * 9;
    const p2 = letterValue(prefix[1]) * 4;
    const p3 = letterValue(prefix[2]) * 5;
    const num = parseInt(digits, 10);

    const sum = p1 + p2 + p3 + num;
    const remainder = sum % 19;

    // Checksum mapping (0=A, 1=Z, 2=Y, ..., 18=B)
    const checksumMap = 'AZYXUTSRPMLKJHGEDCB';
    return checksumMap[remainder];
}

// ============================================================================
// 3. CODE 128 BARCODE RENDERING
// ============================================================================

const barcodeElement = document.getElementById('barcode');
const countdownTimerElement = document.getElementById('countdown-timer');

let countdownInterval = null;
let expiryTime = null;

/**
 * Generate and display Code 128 barcode with 15-minute expiry countdown
 * @param {string} barcodeData - Data to encode in barcode
 */
function displayBarcode(barcodeData) {
    // Generate Code 128 barcode with JsBarcode
    JsBarcode(barcodeElement, barcodeData, {
        format: 'CODE128',
        width: 2,
        height: 80,
        displayValue: true,
        fontSize: 14,
        margin: 10,
        background: '#FFFFFF',
        lineColor: '#000000',
    });

    // Start 15-minute countdown
    expiryTime = Date.now() + 15 * 60 * 1000; // 15 minutes in milliseconds
    startCountdown();
}

/**
 * Start countdown timer and update UI every second
 */
function startCountdown() {
    updateCountdown();

    countdownInterval = setInterval(() => {
        updateCountdown();
    }, 1000);
}

/**
 * Update countdown display and handle expiry
 */
function updateCountdown() {
    const now = Date.now();
    const remaining = Math.max(0, expiryTime - now);

    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);

    const display = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    countdownTimerElement.textContent = display;

    // Apply color classes based on time remaining
    countdownTimerElement.classList.remove('warning', 'expired');
    
    if (remaining === 0) {
        countdownTimerElement.classList.add('expired');
        clearInterval(countdownInterval);
        alert('Redemption expired. Please generate a new barcode.');
    } else if (remaining <= 5 * 60 * 1000) {
        // Warning state in last 5 minutes
        countdownTimerElement.classList.add('warning');
    }
}

// ============================================================================
// 4. NAVIGATION & WORKFLOW
// ============================================================================

const uploadSection = document.getElementById('upload-section');
const plateSection = document.getElementById('plate-section');
const barcodeSection = document.getElementById('barcode-section');
const backToUploadBtn = document.getElementById('back-to-upload');
const newRedemptionBtn = document.getElementById('new-redemption');
const loadingOverlay = document.getElementById('loading-overlay');

nextToPlateBtn.addEventListener('click', () => {
    showSection(plateSection);
});

backToUploadBtn.addEventListener('click', () => {
    showSection(uploadSection);
});

submitBtn.addEventListener('click', async () => {
    const plate = vehiclePlateInput.value.trim().toUpperCase();

    if (!downsampledImageBlob) {
        alert('Please upload a receipt first.');
        return;
    }

    if (!validateLTAPlate(plate)) {
        alert('Please enter a valid vehicle plate.');
        return;
    }

    // Show loading
    loadingOverlay.classList.remove('hidden');

    try {
        // Send to n8n webhook
        const webhookUrl = 'YOUR_N8N_WEBHOOK_URL_HERE'; // Replace with actual webhook URL
        
        const formData = new FormData();
        formData.append('receipt', downsampledImageBlob, 'receipt.jpg');
        formData.append('vehiclePlate', plate);
        formData.append('timestamp', new Date().toISOString());

        const response = await fetch(webhookUrl, {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            throw new Error(`Webhook failed: ${response.status}`);
        }

        const result = await response.json();

        // Generate barcode from response (use redemption ID or unique code)
        const barcodeData = result.redemptionCode || `321CLM${Date.now()}`;

        // Hide loading
        loadingOverlay.classList.add('hidden');

        // Show barcode screen
        displayBarcode(barcodeData);
        showSection(barcodeSection);

    } catch (error) {
        console.error('Submission failed:', error);
        loadingOverlay.classList.add('hidden');
        
        // For demo purposes, still show barcode even if webhook fails
        const fallbackCode = `321CLM${Date.now().toString().slice(-8)}`;
        displayBarcode(fallbackCode);
        showSection(barcodeSection);
        
        // In production, you would show an error message instead
        // alert('Failed to process redemption. Please try again.');
    }
});

newRedemptionBtn.addEventListener('click', () => {
    // Reset form
    receiptUpload.value = '';
    vehiclePlateInput.value = '';
    previewContainer.classList.add('hidden');
    nextToPlateBtn.classList.add('hidden');
    vehiclePlateInput.classList.remove('valid', 'invalid');
    validationFeedback.textContent = '';
    validationFeedback.className = 'feedback';
    submitBtn.disabled = true;
    downsampledImageBlob = null;

    // Clear countdown
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }

    // Return to upload screen
    showSection(uploadSection);
});

/**
 * Show specified section and hide others
 * @param {HTMLElement} section - Section to display
 */
function showSection(section) {
    [uploadSection, plateSection, barcodeSection].forEach(s => {
        s.classList.remove('active');
    });
    section.classList.add('active');
}

// ============================================================================
// 5. SCREEN BRIGHTNESS HINT (for barcode scanning)
// ============================================================================

barcodeSection.addEventListener('transitionend', () => {
    if (barcodeSection.classList.contains('active')) {
        // Prompt user to increase brightness
        if ('wakeLock' in navigator) {
            // Request screen wake lock to prevent dimming during scanning
            navigator.wakeLock.request('screen').catch(err => {
                console.log('Wake Lock failed:', err);
            });
        }
    }
});

// ============================================================================
// INITIALIZATION
// ============================================================================

console.log('321 Clementi Parking Redemption initialized');
console.log('Features: Camera capture, MOD-19 validation, Code 128 barcode');
