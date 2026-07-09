#!/usr/bin/env python3
"""PP-OCRv6 adaptive OCR with retry logic. Supports both images and PDFs."""
import sys
import json
import os
import tempfile
import argparse

os.environ['FLAGS_logging_level'] = '3'
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'

try:
    from paddleocr import PaddleOCR
    import cv2
    import numpy as np
except ImportError as e:
    missing = getattr(e, 'name', None) or str(e).split(':')[-1].strip() or 'required package'
    print(json.dumps({
        "error": f"Missing Python dependency: {missing}. Run setup_ocr to install PaddleOCR."
    }))
    sys.exit(1)

# PyMuPDF is optional — only needed for PDF processing
try:
    import fitz  # PyMuPDF
    HAS_PDF_SUPPORT = True
except ImportError:
    HAS_PDF_SUPPORT = False


# ═══════════════════════════════════════════════════════════════════════════════
# Image preprocessing
# ═══════════════════════════════════════════════════════════════════════════════

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
        if info['is_small']:
            img = cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
            modified = True

        img = cv2.normalize(img, None, 0, 255, cv2.NORM_MINMAX)
        modified = True

        kernel = np.array([[-1,-1,-1], [-1,9,-1], [-1,-1,-1]])
        img = cv2.filter2D(img, -1, kernel)
        modified = True

    if modified:
        tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
        cv2.imwrite(tmp.name, img)
        return tmp.name, True

    return img_path, False


# ═══════════════════════════════════════════════════════════════════════════════
# Core OCR
# ═══════════════════════════════════════════════════════════════════════════════

def create_ocr_instance():
    return PaddleOCR(
        lang="ch",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        text_det_limit_side_len=1536,
        text_det_thresh=0.2,
        text_det_box_thresh=0.4,
    )


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


def run_ocr_with_retry(ocr, image_path):
    """Run OCR with adaptive retry if confidence is low."""
    enhanced_path = None
    try:
        lines1, scores1, avg1 = run_ocr(ocr, image_path)

        if avg1 < 0.85 or len(lines1) < 3:
            enhanced_path, was_enhanced = preprocess_adaptive(image_path, 'enhance')
            if was_enhanced:
                lines2, scores2, avg2 = run_ocr(ocr, enhanced_path)
                if avg2 > avg1 or len(lines2) > len(lines1):
                    lines1, scores1, avg1 = lines2, scores2, avg2

        return lines1, round(avg1, 3)
    finally:
        if enhanced_path and os.path.exists(enhanced_path):
            os.unlink(enhanced_path)


# ═══════════════════════════════════════════════════════════════════════════════
# PDF processing
# ═══════════════════════════════════════════════════════════════════════════════

def pdf_page_to_image(doc, page_num, zoom=2.0):
    """Render a PDF page as a PIL/PyMuPDF pixmap → temp PNG file."""
    page = doc[page_num]
    mat = fitz.Matrix(zoom, zoom)  # 2x for better OCR
    pix = page.get_pixmap(matrix=mat)
    tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
    pix.save(tmp.name)
    return tmp.name


def process_pdf(pdf_path):
    """OCR every page of a PDF and return merged results."""
    if not HAS_PDF_SUPPORT:
        return {
            "error": "PyMuPDF not installed. Run `pip install PyMuPDF` in your venv, or run setup_ocr to reinstall all dependencies.",
            "pages": [],
            "total_lines": 0,
        }

    doc = fitz.open(pdf_path)
    ocr = create_ocr_instance()

    page_results = []
    total_lines = 0
    page_files = []

    try:
        for i in range(len(doc)):
            img_path = pdf_page_to_image(doc, i)
            page_files.append(img_path)

            lines, confidence = run_ocr_with_retry(ocr, img_path)
            page_results.append({
                "page": i + 1,
                "lines": lines,
                "count": len(lines),
                "confidence": confidence,
            })
            total_lines += len(lines)

        return {
            "pages": page_results,
            "total_pages": len(page_results),
            "total_lines": total_lines,
        }
    finally:
        doc.close()
        for f in page_files:
            try:
                if os.path.exists(f):
                    os.unlink(f)
            except OSError:
                pass


# ═══════════════════════════════════════════════════════════════════════════════
# Entry point
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description='PP-OCRv6 OCR — images and PDFs')
    parser.add_argument('path', help='Path to image or PDF file')
    parser.add_argument('--pdf', action='store_true', help='Process file as PDF')
    args = parser.parse_args()

    file_path = args.path
    if not os.path.exists(file_path):
        print(json.dumps({"error": f"File not found: {file_path}"}))
        sys.exit(1)

    if args.pdf:
        result = process_pdf(file_path)
        print(json.dumps(result))
        if "error" in result:
            sys.exit(1)
        return

    # Image mode
    ocr = create_ocr_instance()
    lines, confidence = run_ocr_with_retry(ocr, file_path)

    print(json.dumps({
        "lines": lines,
        "count": len(lines),
        "confidence": confidence,
    }))


if __name__ == "__main__":
    main()
