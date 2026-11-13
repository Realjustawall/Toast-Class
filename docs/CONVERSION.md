# Isolated document conversion work in progress

The converter in `apps/worker/src/convert_document.py` is now connected to a durable PostgreSQL queue, a separate trusted worker, private file assets and a synchronized classroom viewer. PDF/TXT/DOCX conversion passed actual isolated-container tests. PDF/DOCX upload through the worker/storage/API and two-user browser presentation passed end to end. The full presentation subsystem and production deployment are still incomplete; see [the API, operation and remaining scope](PRESENTATIONS.md).

It preserves a PDF output, renders bounded PNG pages and writes a version-1 manifest with page numbers, dimensions, byte sizes and SHA-256 digests. Office conversion uses a fresh LibreOffice profile with macro security configured; Java is not installed. The [documented LibreOffice command-line conversion](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html) and Poppler tools process documents inside a container. Headless operation alone is not isolation.

The execution contract is Linux, an unprivileged UID, one read-only `/input/source.EXT` and a fresh writable `/output`. No application, database, storage or provider credentials are passed into that container. `DockerDocumentConverter` enforces no network, read-only root, dropped capabilities, no-new-privileges, 768 MiB memory, one CPU, 128 PIDs and a bounded non-executable tmpfs. It validates safe manifest filenames, hashes, sizes and raster dimensions after the process exits. The API does not invoke Docker; provision separate service users so only the trusted worker has orchestration permission. Never expose the socket to an untrusted converter. Production service units, operational cleanup/metrics and a clean deployment drill remain pending.

Current engine limits: input/output 100 MiB, maximum 200 pages, raster longest side 1600px and an overall 120-second processing deadline. Tool output is bounded, errors are generic codes and original PDF input is byte-preserved. PNG pages remove active document interactions from the eventual presentation view; the original/converted PDF must remain an authorized attachment download. Fonts are distribution-provided DejaVu/Liberation/Noto; preservation of arbitrary source fonts and complex layouts is not guaranteed.

```sh
docker build --network=host -f infrastructure/docker/Dockerfile.converter -t toaster-converter .
python3 scripts/test_converter.py
```

The Linux harness creates its own generated two-page PDF, mixed Persian/English TXT and minimal DOCX. It checks actual raster outputs and integrity manifests, rejects malformed PDFs and a 201-page document, and removes only its generated job containers/directories. All five assertions passed. The first run found a case-sensitive Docker cleanup-message mismatch, which was fixed before the complete rerun. PPT/PPTX/legacy office/image inputs, encrypted files, extreme documents, malicious-parser fixtures, visual/font fidelity, resource-exhaustion tests and production deployment remain open.

Migrations 008/009, quota reservations, claims/leases, authenticated assets, server-controlled pages, revision/session fencing, thumbnails, zoom/fit/fullscreen, independent student viewing, downloads and independent-user/reload tests are implemented. Annotations, highlighters, annotated exports, snapshots, board imports and breakout annotation imports remain in the master requirement scope. See PRESENTATIONS.md for exact verification boundaries.
