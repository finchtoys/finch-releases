#!/usr/bin/env python3
"""PP-OCRv6 OCR — supports images and PDFs with large-file handling."""
import sys
import json
import os
import tempfile
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed

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

try:
    import fitz
    HAS_PDF_SUPPORT = True
except ImportError:
    HAS_PDF_SUPPORT = False


# ── Constants ────────────────────────────────────────────────────────────────

MAX_IMAGE_DIM = 3000          # longest edge; larger images are scaled down
PDF_RENDER_DPI = 150          # PDF page→PNG resolution
PDF_CHECK_DPI = 72            # low-res preview for blank-page detection
PDF_MAX_WORKERS = 4           # parallel pages for large PDFs


# ── Image helpers ────────────────────────────────────────────────────────────

def load_and_resize(path):
    """Load image. If longest edge > MAX_IMAGE_DIM, scale down preserving aspect ratio."""
    img = cv2.imread(path)
    if img is None:
        return None
    h, w = img.shape[:2]
    longest = max(h, w)
    if longest > MAX_IMAGE_DIM:
        scale = MAX_IMAGE_DIM / longest
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return img


def enhance_image(img):
    """Upscale small images, normalize contrast, sharpen."""
    h, w = img.shape[:2]
    if max(h, w) < 1500:
        img = cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    img = cv2.normalize(img, None, 0, 255, cv2.NORM_MINMAX)
    kernel = np.array([[-1, -1, -1], [-1, 9, -1], [-1, -1, -1]])
    img = cv2.filter2D(img, -1, kernel)
    return img


def save_temp(img):
    tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
    cv2.imwrite(tmp.name, img)
    return tmp.name


# ── Core OCR ────────────────────────────────────────────────────────────────

USE_GPU = False  # set from --gpu flag


def create_ocr_instance():
    return PaddleOCR(
        use_gpu=USE_GPU,
        lang="ch",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        text_det_limit_side_len=1536,
        text_det_thresh=0.2,
        text_det_box_thresh=0.4,
    )


def run_ocr(ocr, image_path):
    """Run OCR and return (lines, avg_confidence)."""
    result = ocr.predict(image_path)
    lines, scores = [], []
    for r in result:
        res = r.get('res', r) if isinstance(r, dict) else r
        texts = getattr(res, 'rec_texts', None) or (res.get('rec_texts') if isinstance(res, dict) else None)
        score_list = getattr(res, 'rec_scores', None) or (res.get('rec_scores') if isinstance(res, dict) else [])
        if texts:
            for text, score in zip(texts, score_list):
                if text and text.strip():
                    lines.append(text.strip())
                    scores.append(float(score))
    avg = sum(scores) / len(scores) if scores else 0
    return lines, avg


def ocr_image(ocr, path):
    """
    OCR a single image: load → maybe resize → OCR → if low confidence, enhance → retry.
    Returns (lines, confidence, was_resized).
    """
    img = load_and_resize(path)
    if img is None:
        return None, 0, False

    h, w = img.shape[:2]
    original_h_w = cv2.imread(path).shape[:2] if cv2.imread(path) is not None else (h, w)
    was_resized = (h, w) != original_h_w

    work_path = save_temp(img)
    lines1, avg1 = run_ocr(ocr, work_path)
    os.unlink(work_path)

    # Retry with enhancement if needed
    if avg1 < 0.85 or len(lines1) < 3:
        enhanced = enhance_image(img)
        enhanced_path = save_temp(enhanced)
        lines2, avg2 = run_ocr(ocr, enhanced_path)
        os.unlink(enhanced_path)
        if avg2 > avg1 or len(lines2) > len(lines1):
            lines1, avg1 = lines2, avg2

    return lines1, round(avg1, 3), was_resized


# ── PDF processing ───────────────────────────────────────────────────────────

def pdf_blank_page(pix):
    """Check if a pixmap is >98% white."""
    samples = pix.samples
    total = len(samples)
    if total == 0:
        return True
    try:
        white = np.sum(samples > 240)
        return (white / total) > 0.98
    except Exception:
        return False


def render_page(doc, page_num, dpi=PDF_RENDER_DPI):
    """
    Render a PDF page to a temp PNG.
    Uses a low-res preview (72 DPI) to check for blank content first —
    only renders at full DPI if the page has content.
    Returns path or None if blank.
    """
    page = doc[page_num]

    # Step 1: low-res preview to check for blank
    check_zoom = PDF_CHECK_DPI / 72.0
    check_pix = page.get_pixmap(matrix=fitz.Matrix(check_zoom, check_zoom))
    if pdf_blank_page(check_pix):
        return None
    check_pix = None  # let GC free memory

    # Step 2: full-resolution render
    zoom = dpi / 72.0
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
    tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
    pix.save(tmp.name)
    return tmp.name


def ocr_page(ocr, doc, page_num, dpi=PDF_RENDER_DPI):
    """Render one PDF page and OCR it. Returns result dict."""
    path = render_page(doc, page_num, dpi)
    if path is None:
        return {"page": page_num + 1, "lines": ["[blank page]"], "count": 1, "confidence": 0}
    try:
        lines, confidence, _ = ocr_image(ocr, path)
        return {
            "page": page_num + 1,
            "lines": lines or [],
            "count": len(lines) if lines else 0,
            "confidence": confidence,
        }
    finally:
        if os.path.exists(path):
            os.unlink(path)


def process_pdf_stream(pdf_path):
    """OCR every page of a PDF, yielding one JSON line per page (NDJSON)."""
    if not HAS_PDF_SUPPORT:
        yield json.dumps({"error": "PyMuPDF not installed."})
        return

    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    yield json.dumps({"type": "meta", "total_pages": total_pages})
    sys.stdout.flush()

    try:
        if total_pages <= 8:
            ocr = create_ocr_instance()
            for i in range(total_pages):
                result = ocr_page(ocr, doc, i, PDF_RENDER_DPI)
                yield json.dumps({"type": "page", **result})
                sys.stdout.flush()
        else:
            with ThreadPoolExecutor(max_workers=PDF_MAX_WORKERS) as pool:
                futures = {pool.submit(ocr_page, create_ocr_instance(), doc, i, PDF_RENDER_DPI): i for i in range(total_pages)}
                for f in as_completed(futures):
                    result = f.result()
                    yield json.dumps({"type": "page", **result})
                    sys.stdout.flush()

        yield json.dumps({"type": "done"})
        sys.stdout.flush()
    finally:
        doc.close()


# ── Entry point ─────────────────────────────────────────────────────────────

def main():
    global USE_GPU
    parser = argparse.ArgumentParser(description='PP-OCRv6 OCR — images and PDFs')
    parser.add_argument('path', help='Path to image or PDF file')
    parser.add_argument('--pdf', action='store_true', help='Process file as PDF')
    parser.add_argument('--gpu', action='store_true', help='Enable GPU acceleration')
    args = parser.parse_args()
    USE_GPU = args.gpu

    if not os.path.exists(args.path):
        print(json.dumps({"error": f"File not found: {args.path}"}))
        sys.exit(1)

    if args.pdf:
        for line in process_pdf_stream(args.path):
            print(line)
        return

    ocr = create_ocr_instance()
    lines, confidence, was_resized = ocr_image(ocr, args.path)
    print(json.dumps({
        "lines": lines or [],
        "count": len(lines) if lines else 0,
        "confidence": confidence,
        "resized": was_resized,
    }))


if __name__ == "__main__":
    main()