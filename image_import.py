"""Read timetable screenshots using OCR word positions and shared grid parsing."""

import csv
import io
import os
import re
import subprocess
import warnings
from threading import BoundedSemaphore

from PIL import Image, ImageOps, UnidentifiedImageError

from pdf_import import parse_grid_pages

IMAGE_READER = BoundedSemaphore(1)


def extract_image_timetable(image_bytes, mime_type):
    if not IMAGE_READER.acquire(blocking=False):
        raise ValueError("Another screenshot is being read. Please try again in a few seconds.")
    try:
        return read_image_timetable(image_bytes, mime_type)
    finally:
        IMAGE_READER.release()


def read_image_timetable(image_bytes, mime_type):
    if mime_type == "image/png" and not image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Choose a valid PNG image.")
    if mime_type == "image/jpeg" and not image_bytes.startswith(b"\xff\xd8\xff"):
        raise ValueError("Choose a valid JPG image.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(image_bytes)) as source:
                if source.format not in {"PNG", "JPEG"}:
                    raise ValueError("Choose a PNG or JPG screenshot.")
                if source.width * source.height > 20_000_000:
                    raise ValueError("This image is too large. Crop it to the timetable and try again.")
                image = ImageOps.exif_transpose(source)
                # Flatten transparent screenshots onto white before recognizing text.
                rgba = image.convert("RGBA")
                image = Image.new("RGB", rgba.size, "white")
                image.paste(rgba, mask=rgba.getchannel("A"))
                # Keep OCR predictable on the free server; enlarge small screenshots.
                scale = min(2, 2400 / max(image.size))
                if scale != 1:
                    image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.Resampling.LANCZOS)
                image = ImageOps.grayscale(image)
                if image.resize((1, 1)).getpixel((0, 0)) < 110:
                    image = ImageOps.invert(image)
                image = ImageOps.autocontrast(image)
                output = io.BytesIO()
                image.save(output, format="PNG")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ValueError("Could not open this image. Try another PNG or JPG screenshot.") from None

    try:
        result = subprocess.run(
            ["tesseract", "stdin", "stdout", "-l", "eng", "--psm", "3", "tsv"],
            input=output.getvalue(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=22, check=False,
            env={**os.environ, "OMP_THREAD_LIMIT": "1", "OMP_NUM_THREADS": "1"},
        )
    except FileNotFoundError:
        raise ValueError("The image reader is not available yet. Please try again shortly.") from None
    except subprocess.TimeoutExpired:
        raise ValueError("This screenshot took too long to read. Crop it to fewer days and try again.") from None
    if result.returncode or not result.stdout.startswith(b"level\t"):
        raise ValueError("Could not read this screenshot. Try a clearer image with larger text.")
    lines = {}
    for row in csv.DictReader(io.StringIO(result.stdout.decode("utf-8", errors="replace")), delimiter="\t"):
        if row["level"] != "5" or not row["text"].strip():
            continue
        x, y, width, height = (float(row[key]) for key in ("left", "top", "width", "height"))
        key = tuple(row[key] for key in ("block_num", "par_num", "line_num"))
        lines.setdefault(key, []).append((x, y, x + width, y + height, row["text"].strip()))
    page = {"width": image.width, "lines": list(lines.values()),
            "words": [word for line in lines.values() for word in line]}
    classes = parse_grid_pages([page])
    if not classes:
        raise ValueError("Could not reliably read the timetable columns. Include the day headings and crop out anything outside the timetable, or use the original PDF.")
    for item in classes:
        item["subject"] = re.sub(r"\bWhat\s+\|\s+Need\b", "What I Need", item["subject"], flags=re.I)
    return classes, None
