"""Shared test helpers.

Deliberately fixture-free (plain functions + context managers) so the suite runs
under pytest and never touches the network, Gemini, LibreOffice or poppler.
"""

import contextlib
import json
import os
import sys
from unittest import mock

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

import config  # noqa: E402
from utils import db as db_module  # noqa: E402
from utils import messaging, model_state, storage  # noqa: E402
from utils.docx_mutator import cv_data_to_text  # noqa: E402

SAMPLE_CV_DATA = {
    "header": {"name": "Jane Doe", "title": "Software Engineer"},
    "summary": "Engineer with 10 years building desktop and web applications.",
    "skills": {
        "Languages": "C#, SQL, JavaScript",
        "Platforms": "Windows, Docker",
    },
    "professional_experience": [
        {
            "role": "Senior Software Engineer",
            "company_info": "Acme Corp | 2018 - 2024",
            "highlights": [
                "Led the migration of 50 desktop screens to a web platform.",
                "Cut report generation time by 80%.",
            ],
        }
    ],
}

SAMPLE_JD = """About the Role
We are looking for a hands-on Platform Engineering Lead.
Requirements: Azure, .NET, REST API design, event-driven architecture.
"""


def docx_lines(cv_data):
    """The paragraph texts a faithful master cv.docx would contain."""
    lines = []
    for raw in cv_data_to_text(cv_data).split("\n"):
        line = raw.strip()
        if not line:
            continue
        lines.append(line[2:].strip() if line.startswith("• ") else line)
    return lines


def write_docx(path, lines):
    import docx

    document = docx.Document()
    for line in lines:
        document.add_paragraph(line)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    document.save(path)
    return path


def write_master_cv(path, cv_data=None):
    return write_docx(path, docx_lines(cv_data or SAMPLE_CV_DATA))


def reset_caches():
    db_module.reset_db_cache()
    storage.reset_storage_cache()
    messaging.reset_queue_cache()
    model_state.reset_store_cache()


@contextlib.contextmanager
def isolated_config(tmp_dir, cv_data=None):
    """Point every configurable path/backend at a throwaway directory."""
    cv_data = cv_data or SAMPLE_CV_DATA
    artifacts = os.path.join(tmp_dir, "artifacts")
    input_dir = os.path.join(artifacts, "input")
    output_dir = os.path.join(artifacts, "output")
    queue_dir = os.path.join(artifacts, "queue")
    temp_root = os.path.join(artifacts, "temp")
    for directory in (input_dir, output_dir, queue_dir, temp_root):
        os.makedirs(directory, exist_ok=True)

    cv_path = os.path.join(input_dir, config.MASTER_CV_FILENAME)
    write_master_cv(cv_path, cv_data)
    cv_data_path = os.path.join(artifacts, "cv_data.json")
    with open(cv_data_path, "w", encoding="utf-8") as handle:
        json.dump(cv_data, handle, ensure_ascii=False, indent=2)

    overrides = {
        "ARTIFACTS_DIR": artifacts,
        "INPUT_DIR": input_dir,
        "OUTPUT_DIR": output_dir,
        "QUEUE_DIR": queue_dir,
        "TEMP_DIR": temp_root,
        "TEMP_ROOT": temp_root,
        "CV_DATA_PATH": cv_data_path,
        "MODEL_STATE_FILE": os.path.join(artifacts, "model_state.json"),
        "HEARTBEAT_FILE": os.path.join(temp_root, "heartbeat"),
        "QUEUE_BACKEND": "directory",
        "STORAGE_BACKEND": "local",
        "DB_BACKEND": "local",
        "MODEL_STATE_BACKEND": "file",
    }
    saved = {key: getattr(config, key) for key in overrides}
    for key, value in overrides.items():
        setattr(config, key, value)
    reset_caches()
    try:
        yield {"cv_path": cv_path, "cv_data_path": cv_data_path, "artifacts": artifacts}
    finally:
        for key, value in saved.items():
            setattr(config, key, value)
        reset_caches()


def list_dir(directory):
    """Directory listing that tolerates a directory that was never created."""
    if not os.path.isdir(directory):
        return []
    return sorted(os.listdir(directory))


@contextlib.contextmanager
def fake_gemini(replacements, role_title="Platform Engineering Lead", layout_ok=True, calls=None):
    """Replace every Gemini call and both external render tools.

    Pass a dict as `calls` to count invocations, e.g. to prove that a duplicate
    message never re-runs the LLM.
    """
    from PIL import Image

    from agent import nodes as nodes_module
    from agent.models import LayoutCheckResult, TextModificationList, TextReplacement

    if calls is not None:
        calls.setdefault("adapt", 0)
        calls.setdefault("vision", 0)

    payload = TextModificationList(
        modifications=[
            TextReplacement(original_text=o, tailored_text=t, reason="targets JD requirement")
            for o, t in replacements
        ]
    )

    def adapt(client, prompt):
        if calls is not None:
            calls["adapt"] += 1
        return payload

    def vision(client, contents):
        if calls is not None:
            calls["vision"] += 1
        return layout

    def fake_render_docx(docx_path, pdf_path, profile_dir=None, timeout=None):
        os.makedirs(os.path.dirname(pdf_path), exist_ok=True)
        with open(pdf_path, "wb") as handle:
            handle.write(b"%PDF-1.4 fake")
        return pdf_path

    def fake_render_pdf(pdf_path, output_dir, dpi=None, poppler_path=None):
        os.makedirs(output_dir, exist_ok=True)
        image_path = os.path.join(output_dir, "page_1.png")
        Image.new("RGB", (60, 90), "white").save(image_path, "PNG")
        return [image_path]

    layout = LayoutCheckResult(
        is_layout_ok=layout_ok, feedback="clean" if layout_ok else "severe overlap detected"
    )
    with mock.patch.object(nodes_module, "get_genai_client", lambda: mock.Mock()), \
            mock.patch.object(nodes_module, "_call_gemini_extract_role", lambda c, jd: role_title), \
            mock.patch.object(nodes_module, "_call_gemini_text_adaptation", adapt), \
            mock.patch.object(nodes_module, "_call_gemini_vision_eval", vision), \
            mock.patch.object(nodes_module, "convert_docx_to_pdf", fake_render_docx), \
            mock.patch.object(nodes_module, "convert_pdf_to_images", fake_render_pdf):
        yield payload


def sample_task(external_id="848944", user_id=None, include_cv_data=False, **extra):
    payload = {
        "job_id": f"job-{external_id}",
        "user_id": user_id,
        "external_id": external_id,
        "title": "Platform Engineering Lead",
        "company": "UPPeople",
        "description_raw": SAMPLE_JD,
        "cv_version": "v1",
        "attempt": 0,
    }
    if include_cv_data:
        payload["cv_data"] = SAMPLE_CV_DATA
    payload.update(extra)
    return payload
