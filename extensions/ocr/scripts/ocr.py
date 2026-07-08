#!/usr/bin/env python3
"""PP-OCRv6 adaptive OCR with retry logic."""
import sys
import json
import os
import tempfile

os.environ['FLAGS_logging_level'] = '3'
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'

from paddleocr import PaddleOCR
import cv2
import numpy as np


def analyze_image(img):
    """Analyze image characteristics to choose preprocessing strategy."""
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    mean_brightness = gray.mean()
    is_dark = mean_brightness < 128
    is_small = max(h, w) < 1500
    is_large = max(h, w) > 4000
    return {
        'width': w, 'height': h,
        'is_dark': is_dark,
        'is_small': is_small,
        'is_large': is_large,
        'brightness': mean_brightness,
    }


def preprocess_adaptive(img_path, strategy='default'):
    """Apply adaptive preprocessing based on strategy."""
    img = cv2.imread(img_path)
    if img is None:
        return img_path, False

    info = analyze_image(img)
    modified = False

    if strategy == 'enhance':
        # Enhanced preprocessing for low-confidence results
        if info['is_small']:
            # Upscale small images 2x
            img = cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
            modified = True

        # Normalize contrast
        img = cv2.normalize(img, None, 0, 255, cv2.NORM_MINMAX)
        modified = True

        # Light sharpen
        kernel = np.array([[-1,-1,-1], [-1,9,-1], [-1,-1,-1]])
        img = cv2.filter2D(img, -1, kernel)
        modified = True

    if modified:
        tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
        cv2.imwrite(tmp.name, img)
        return tmp.name, True

    return img_path, False


def run_ocr(ocr, image_path):
    """Run OCR and return results with confidence scores."""
    result = ocr.predict(image_path)

    lines = []
    scores = []
    for r in result:
        res = r.get('res', r) if isinstance(r, dict) else r
        if hasattr(res, 'rec_texts') and res.rec_texts:
            for text, score in zip(res.rec_texts, res.rec_scores):
                if text and text.strip():
                    lines.append(text.strip())
                    scores.append(float(score))
        elif isinstance(res, dict) and 'rec_texts' in res:
            for text, score in zip(res['rec_texts'], res['rec_scores']):
                if text and text.strip():
                    lines.append(text.strip())
                    scores.append(float(score))

    avg_score = sum(scores) / len(scores) if scores else 0
    return lines, scores, avg_score


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: ocr.py <image_path>"}))
        sys.exit(1)

    image_path = sys.argv[1]
    if not os.path.exists(image_path):
        print(json.dumps({"error": f"File not found: {image_path}"}))
        sys.exit(1)

    # High-accuracy configuration
    ocr = PaddleOCR(
        lang="ch",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        text_det_limit_side_len=1536,
        text_det_thresh=0.2,
        text_det_box_thresh=0.4,
    )

    # First attempt: default preprocessing
    lines1, scores1, avg1 = run_ocr(ocr, image_path)

    # If confidence is low, try enhanced preprocessing
    if avg1 < 0.85 or len(lines1) < 3:
        enhanced_path, was_enhanced = preprocess_adaptive(image_path, 'enhance')
        if was_enhanced:
            lines2, scores2, avg2 = run_ocr(ocr, enhanced_path)
            os.unlink(enhanced_path)  # Clean up temp file

            # Use enhanced result if it's better
            if avg2 > avg1 or len(lines2) > len(lines1):
                lines1, scores1, avg1 = lines2, scores2, avg2

    print(json.dumps({
        "lines": lines1,
        "count": len(lines1),
        "confidence": round(avg1, 3),
    }))


if __name__ == "__main__":
    main()
