#!/usr/bin/env python3
"""PP-OCRv6 high-accuracy OCR script called by the Finch extension."""
import sys
import json
import os

os.environ['FLAGS_logging_level'] = '3'
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'

from paddleocr import PaddleOCR

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
        # High-accuracy detection params
        text_det_limit_side_len=1536,
        text_det_thresh=0.2,
        text_det_box_thresh=0.4,
    )

    result = ocr.predict(image_path)

    # Extract text lines from OCRResult
    lines = []
    for r in result:
        # Access the res dict which contains rec_texts
        res = r.get('res', r) if isinstance(r, dict) else r
        if hasattr(res, 'rec_texts') and res.rec_texts:
            for text in res.rec_texts:
                if text and text.strip():
                    lines.append(text.strip())
        elif isinstance(res, dict) and 'rec_texts' in res:
            for text in res['rec_texts']:
                if text and text.strip():
                    lines.append(text.strip())

    print(json.dumps({"lines": lines, "count": len(lines)}))

if __name__ == "__main__":
    main()
