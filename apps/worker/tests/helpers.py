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
from utils.cv_text import cv_data_to_text  # noqa: E402

SAMPLE_CV_DATA = {
    "header": {"name": "Jane Doe", "title": "Software Engineer"},
    "summary": "Engineer with 10 years building desktop and web applications.",
    "skills": {
        "Languages": "C#, SQL, JavaScript",
        # Azure is here because the fixture's tailored summary and the sample JD both name it: a
        # claim only the *vacancy* makes is no longer admissible (invariants 7, 33), so the sample
        # CV has to back it for the pipeline test to mean "a clean tailoring run".
        "Platforms": "Windows, Docker, Azure",
    },
    "professional_experience": [
        {
            # The document lays an entry out as role + context | period + employer - four separate
            # single-line paragraphs - so the fixture mirrors that, one field per line.
            "role": "Senior Software Engineer",
            "company_info": "Acme Corp",
            "context": "Payments platform",
            "dates": "2018 - 2024",
            "highlights": [
                "Led the migration of 50 desktop screens to a web platform.",
                "Cut report generation time by 80%.",
            ],
        }
    ],
    # Read-only context in the tailoring prompt: it may back a SUMMARY/SKILLS claim, but no
    # replacement may target these lines (`utils.cv_replacements.drop_read_only_replacements`).
    "personal_projects": [
        {
            "heading": "Personal Analytics Tool - self-hosted product analytics.",
            "year": "2026",
            "description": "Built a self-hosted analytics tool for small teams.",
            "highlights": [
                "Shipped a queue-backed ingestion pipeline using RabbitMQ.",
                "Packaged the service for Kubernetes with a Helm chart.",
            ],
            "links": ["Repo: https://example.invalid/analytics"],
            "stack": "Python, RabbitMQ, Kubernetes, Postgres.",
        }
    ],
}

# The facts row (`application_profile`): ground truth for all three prompts. Redis is the
# technology the CV text deliberately does *not* mention, which is what the verification tests use.
SAMPLE_CANDIDATE = {
    "location": "Portugal",
    "english_level": "B2 (Upper-Intermediate)",
    "salary_expectation": "$5,000 / month",
    "availability": "ASAP - no notice period",
    "work_rights": "Open to a B2B contract",
    "standing_answers": {
        "Redis and RabbitMQ experience": (
            "Caching with Redis at Tangiblee and queues with RabbitMQ and Azure Service Bus "
            "in microservice projects."
        ),
        "Years of backend experience (C# / .NET Core)": "More than 13 years.",
    },
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


def seed_candidate(user_id, candidate=None):
    """Write one candidate-facts row into the active store - the path every prompt reads."""
    return db_module.get_db().upsert_application_profile(user_id, candidate or SAMPLE_CANDIDATE)


def reset_caches():
    db_module.reset_db_cache()
    storage.reset_storage_cache()
    messaging.reset_queue_cache()
    model_state.reset_store_cache()


@contextlib.contextmanager
def isolated_config(tmp_dir, cv_data=None):
    """Point every configurable path/backend at a throwaway directory.

    `GEMINI_API_KEY` is pinned to `None` as well: a hermetic test must behave the same on CI
    (no key) as on a developer machine (a key in `.env`), so no test may reach a real client.
    """
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
        "DB_BACKEND": "local",
        "MODEL_STATE_BACKEND": "file",
        # No key: a test that would build a real client must fail here, not only on CI.
        "GEMINI_API_KEY": None,
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
def fake_gemini(replacements, role_title="Platform Engineering Lead", layout_ok=True, calls=None,
                prompts=None):
    """Replace every Gemini call and both external render tools.

    Everything the model-facing modules share is patched at its one definition site
    (`agent.gemini`: `client`, `extract_role`, `suggest_replacements`, `evaluate_layout`), so the
    tailoring nodes, the letter and the form prompt are all covered by the same patch. The render
    tools stay on `agent.nodes`, which is where `render` calls them.

    Pass a dict as `calls` to count invocations, e.g. to prove that a duplicate
    message never re-runs the LLM. Pass a list as `prompts` to capture the tailoring
    prompt itself, e.g. to assert which blocks the model was given.
    """
    from PIL import Image

    from agent import gemini as gemini_module
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
        if prompts is not None:
            prompts.append(prompt)
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
    with mock.patch.object(gemini_module, "client", lambda: mock.Mock()), \
            mock.patch.object(gemini_module, "extract_role", lambda c, jd: role_title), \
            mock.patch.object(gemini_module, "suggest_replacements", adapt), \
            mock.patch.object(gemini_module, "evaluate_layout", vision), \
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
