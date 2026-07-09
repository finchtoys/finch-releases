#!/usr/bin/env python3
"""PP-OCRv6 OCR — images and PDFs. Always sequential; no multiprocessing."""
import sys
import json
import os
import tempfile
import argparse

os.environ['FLAGS_logging_level'] = '3'
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'

# Limit native-thread oversubscription in PaddlePaddle / BLAS.
os.environ['OMP_NUM_THREADS'] = '1'
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['MKL_NUM_THREADS'] = '1'
os.environ['FLAGS_use_mkldnn'] = '0'
os.environ['FLAGS_paddle_num_threads'] = '1'
os.environ['FLAGS_enable_parallel_graph'] = '0'
os.environ['CUDA_VISIBLE_DEVICES'] = ''
os.environ['MALLOC_ARENA_MAX'] = '2'

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

MAX_IMAGE_DIM = 3000
PDF_RENDER_DPI = 150
PDF_CHECK_DPI = 72
BLANK_PAGE_WHITE_THRESHOLD = 0.95
BLANK_PAGE_PIXEL_THRESHOLD = 240


# ── Image helpers ────────────────────────────────────────────────────────────

def load_and_resize(path):
    """Load image. If longest edge > MAX_IMAGE_DIM, scale down preserving aspect ratio.
    Returns (image, original_hw) where original_hw is the (h, w) before resize."""
    img = cv2.imread(path)
    if img is None:
        return None, None
    h, w = img.shape[:2]
    original_hw = (h, w)
    longest = max(h, w)
    if longest > MAX_IMAGE_DIM:
        scale = MAX_IMAGE_DIM / longest
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return img, original_hw


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


def warmup_ocr(ocr):
    """Run a dummy prediction to warm up the model (cold start ~10s). No-op if already warm."""
    warmup_path = os.path.join(os.path.dirname(__file__), 'warmup.png')
    if not os.path.exists(warmup_path):
        try:
            tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
            cv2.imwrite(tmp.name, np.ones((64, 64, 3), dtype=np.uint8) * 255)
            warmup_path = tmp.name
        except Exception:
            return
    try:
        ocr.predict(warmup_path)
    except Exception:
        pass
    finally:
        if warmup_path and warmup_path.startswith(tempfile.gettempdir()):
            try:
                os.unlink(warmup_path)
            except Exception:
                pass


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
    img, original_h_w = load_and_resize(path)
    if img is None:
        return None, 0, False

    h, w = img.shape[:2]
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


# ── PDF processing (sequential) ──────────────────────────────────────────────

def pdf_blank_page(pix):
    """Check if a pixmap is mostly white."""
    samples = pix.samples
    total = len(samples)
    if total == 0:
        return True
    try:
        white = np.sum(samples > BLANK_PAGE_PIXEL_THRESHOLD)
        return (white / total) > BLANK_PAGE_WHITE_THRESHOLD
    except Exception:
        return False


def process_pdf_stream(pdf_path):
    """OCR every page of a PDF sequentially, yielding one JSON line per page."""
    if not HAS_PDF_SUPPORT:
        yield json.dumps({"error": "PyMuPDF not installed."})
        return

    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    yield json.dumps({"type": "meta", "total_pages": total_pages})
    sys.stdout.flush()
    doc.close()

    ocr = create_ocr_instance()
    warmup_ocr(ocr)

    try:
        for i in range(total_pages):
            page_doc = fitz.open(pdf_path)
            try:
                page = page_doc[i]
                # Low-res preview to check for blank
                check_zoom = PDF_CHECK_DPI / 72.0
                check_pix = page.get_pixmap(matrix=fitz.Matrix(check_zoom, check_zoom))
                if pdf_blank_page(check_pix):
                    result = {"page": i + 1, "lines": ["[blank page]"], "count": 0, "confidence": 0}
                else:
                    check_pix = None
                    # Full-resolution render
                    zoom = PDF_RENDER_DPI / 72.0
                    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
                    tmp_path = tempfile.NamedTemporaryFile(suffix='.png', delete=False).name
                    pix.save(tmp_path)
                    pix = None  # release pixmap memory
                    try:
                        img, original_h_w = load_and_resize(tmp_path)
                        if img is None:
                            result = {"page": i + 1, "lines": [], "count": 0, "confidence": 0}
                        else:
                            work_path = tempfile.NamedTemporaryFile(suffix='.png', delete=False).name
                            cv2.imwrite(work_path, img)
                            del img  # release image memory before OCR
                            lines, confidence = run_ocr(ocr, work_path)
                            os.unlink(work_path)
                            result = {
                                "page": i + 1,
                                "lines": lines or [],
                                "count": len(lines) if lines else 0,
                                "confidence": round(confidence, 3),
                            }
                    finally:
                        if os.path.exists(tmp_path):
                            os.unlink(tmp_path)
            finally:
                page_doc.close()
            yield json.dumps({"type": "page", **result})
            sys.stdout.flush()
        yield json.dumps({"type": "done"})
        sys.stdout.flush()
    except Exception as e:
        yield json.dumps({"error": str(e)})
        sys.stdout.flush()


# ── Entry point ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='PP-OCRv6 OCR — images and PDFs')
    parser.add_argument('path', help='Path to image or PDF file')
    parser.add_argument('--pdf', action='store_true', help='Process file as PDF')
    args = parser.parse_args()

    if not os.path.exists(args.path):
        print(json.dumps({"error": f"File not found: {args.path}"}))
        sys.exit(1)

    if args.pdf:
        for line in process_pdf_stream(args.path):
            print(line)
        return

    ocr = create_ocr_instance()
    warmup_ocr(ocr)
    lines, confidence, was_resized = ocr_image(ocr, args.path)
    print(json.dumps({
        "lines": lines or [],
        "count": len(lines) if lines else 0,
        "confidence": confidence,
        "resized": was_resized,
    }))


if __name__ == "__main__":
    main()
