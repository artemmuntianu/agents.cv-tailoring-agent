"""DOCX -> PDF -> PNG rendering.

Runs unchanged on Windows (dev) and in the container (Linux), where
`libreoffice` and `poppler-utils` are baked into the image.

Cloud-specific hardening:
* a per-job LibreOffice user profile (`-env:UserInstallation=...`) so two
  conversions on the same node can never fight over the default profile lock;
* a hard timeout, so a wedged soffice process cannot pin a worker pod forever;
* isolated output directories (via the caller's per-job temp dir).
"""

import os
import pathlib
import shutil
import subprocess

from pdf2image import convert_from_path

import config
from utils.logging_setup import get_logger

log = get_logger(__name__)

CONVERSION_TIMEOUT_SECONDS = 240


def find_libreoffice_executable():
    for path in config.LIBREOFFICE_PATHS:
        if os.path.isabs(path) and os.path.isfile(path):
            return path
        found = shutil.which(path)
        if found:
            return found
    return None


def render_tools_status():
    """Report which external binaries are available (used by healthcheck)."""
    libreoffice = find_libreoffice_executable()
    poppler = None
    if config.POPPLER_PATH:
        candidate = os.path.join(config.POPPLER_PATH, "pdftoppm")
        for name in (candidate, f"{candidate}.exe"):
            if os.path.isfile(name):
                poppler = name
                break
    else:
        poppler = shutil.which("pdftoppm")
    return {"libreoffice": libreoffice, "pdftoppm": poppler}


def assert_render_tools_available():
    """Fail fast at container start instead of mid-task."""
    status = render_tools_status()
    missing = [name for name, value in status.items() if not value]
    if missing:
        raise RuntimeError(
            "missing render tool(s): "
            f"{', '.join(missing)} (install libreoffice + poppler-utils)"
        )
    return status


def convert_docx_to_pdf(docx_path, pdf_path, profile_dir=None, timeout=None):
    output_dir = os.path.dirname(pdf_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    libreoffice_cmd = find_libreoffice_executable()
    if not libreoffice_cmd:
        log.warning("libreoffice not found - attempting docx2pdf fallback")
        try:
            from docx2pdf import convert

            convert(docx_path, pdf_path)
            return pdf_path
        except Exception as exc:  # noqa: BLE001
            raise FileNotFoundError(
                "LibreOffice binary not found. Install LibreOffice or put "
                f"`soffice` on PATH (fallback failed: {exc})"
            ) from exc

    if profile_dir is None:
        profile_dir = os.path.join(output_dir or ".", "lo-profile")
    os.makedirs(profile_dir, exist_ok=True)
    profile_uri = pathlib.Path(os.path.abspath(profile_dir)).as_uri()

    cmd = [
        libreoffice_cmd,
        f"-env:UserInstallation={profile_uri}",
        "--headless",
        "--norestore",
        "--convert-to",
        "pdf",
        "--outdir",
        output_dir,
        docx_path,
    ]

    effective_timeout = timeout or CONVERSION_TIMEOUT_SECONDS
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=effective_timeout,
    )
    if result.returncode != 0:
        log.error("libreoffice conversion failed", stderr=result.stderr.strip())
        raise RuntimeError(f"LibreOffice failed with exit code {result.returncode}")

    generated_pdf = os.path.join(
        output_dir, os.path.splitext(os.path.basename(docx_path))[0] + ".pdf"
    )
    if generated_pdf != pdf_path and os.path.exists(generated_pdf):
        if os.path.exists(pdf_path):
            os.remove(pdf_path)
        os.rename(generated_pdf, pdf_path)

    return pdf_path


def convert_pdf_to_images(pdf_path, output_dir, dpi=None, poppler_path=None):
    os.makedirs(output_dir, exist_ok=True)
    effective_dpi = dpi or config.RENDER_DPI
    effective_poppler = poppler_path if poppler_path is not None else config.POPPLER_PATH

    images = convert_from_path(
        pdf_path, dpi=effective_dpi, poppler_path=effective_poppler
    )
    image_paths = []

    base_name = os.path.splitext(os.path.basename(pdf_path))[0]
    for index, image in enumerate(images):
        image_path = os.path.join(output_dir, f"{base_name}_page_{index + 1}.png")
        image.save(image_path, "PNG")
        image.close()
        image_paths.append(image_path)

    return image_paths
