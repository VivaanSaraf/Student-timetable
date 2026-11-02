FROM python:3.13-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py storage.py pdf_import.py image_import.py ./
COPY *.html *.css *.js ./

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    BELLHOP_HOST=0.0.0.0 \
    BELLHOP_SECURE_COOKIES=1

EXPOSE 10000
CMD ["python", "server.py"]
