"""Artifact storage - plain local files.

Artifacts live under `ARTIFACTS_DIR` (default `artifacts/` for the CLI, `/data` -
a PersistentVolumeClaim - inside Kubernetes):

    ARTIFACTS_DIR/cv_data.json     structured CV model
    ARTIFACTS_DIR/input/cv.docx    master CV (plus jd_*.txt for CLI batches)
    ARTIFACTS_DIR/output/*.pdf     tailored results (+ .docx)

`prepare_task()` materialises the inputs for one queue message, so the rest of
the pipeline only ever sees local paths.

Should a remote backend ever be needed again, implement the same three methods
(`fetch_master_cv`, `fetch_cv_data`, `upload`) and pick it in `get_storage()`.
"""

import json
import os
import shutil
from dataclasses import dataclass, field

import config
from utils.logging_setup import get_logger

log = get_logger(__name__)


@dataclass
class TaskContext:
    """Everything one message needs to run the LangGraph pipeline."""

    job_id: str
    workdir: str
    cv_path: str
    cv_data: dict
    output_path: str
    temp_dir: str
    meta: dict = field(default_factory=dict)


def _safe_component(value, fallback):
    """File-system-safe single path component."""
    cleaned = "".join(
        character if character.isalnum() or character in ("-", "_", ".") else "_"
        for character in str(value or "")
    ).strip("_")
    return cleaned or fallback


class LocalStorage:
    """Reads the master CV from the input dir and writes results to the output dir."""

    backend = "local"

    def __init__(self, input_dir=None, output_dir=None):
        self.input_dir = input_dir or config.INPUT_DIR
        self.output_dir = output_dir or config.OUTPUT_DIR

    # -- inputs ------------------------------------------------------------ #
    def fetch_master_cv(self, task=None, dest_dir=None):
        """Path of the master CV. Copied when `dest_dir` is given."""
        source = os.path.join(self.input_dir, config.MASTER_CV_FILENAME)
        if not os.path.exists(source):
            raise FileNotFoundError(
                f"master CV not found at {source} (put cv.docx there, or run "
                "scripts/storage-files.ps1 -Action seed)"
            )
        if dest_dir is None:
            return source
        os.makedirs(dest_dir, exist_ok=True)
        destination = os.path.join(dest_dir, config.MASTER_CV_FILENAME)
        shutil.copy2(source, destination)
        return destination

    def fetch_cv_data(self, task=None):
        """The structured CV model: inline from the message, else from disk."""
        if task is not None and getattr(task, "cv_data", None):
            return task.cv_data
        if not os.path.exists(config.CV_DATA_PATH):
            raise FileNotFoundError(
                f"cv_data.json not found at {config.CV_DATA_PATH} and the task "
                "payload did not carry one"
            )
        with open(config.CV_DATA_PATH, encoding="utf-8") as handle:
            return json.load(handle)

    # -- outputs ----------------------------------------------------------- #
    def upload(self, local_path, remote_key):
        """Copy an artifact into the output folder and return its path."""
        os.makedirs(self.output_dir, exist_ok=True)
        destination = os.path.join(self.output_dir, os.path.basename(remote_key))
        shutil.copy2(local_path, destination)
        log.info("artifact stored", path=destination, key=remote_key)
        return destination

    # -- convenience ------------------------------------------------------- #
    def prepare_task(self, task):
        """Work dir + input paths for one task."""
        job_id = getattr(task, "job_id", None) or "local-job"
        workdir = os.path.join(config.TEMP_ROOT, _safe_component(job_id, "job"))
        os.makedirs(workdir, exist_ok=True)
        external_id = _safe_component(getattr(task, "external_id", "cv"), "cv")
        return TaskContext(
            job_id=job_id,
            workdir=workdir,
            cv_path=self.fetch_master_cv(task, dest_dir=None),
            cv_data=self.fetch_cv_data(task),
            output_path=os.path.join(workdir, f"cv_{external_id}.docx"),
            temp_dir=workdir,
        )


_STORAGE = None


def get_storage():
    """Return the (single, cached) storage backend."""
    global _STORAGE
    if _STORAGE is None:
        _STORAGE = LocalStorage()
    return _STORAGE


def reset_storage_cache():
    """Test helper: forget the cached backend."""
    global _STORAGE
    _STORAGE = None


def output_key_for(task, suffix):
    """Canonical artifact key; flattened to a file name when stored locally."""
    external_id = _safe_component(getattr(task, "external_id", "cv"), "cv")
    user_id = _safe_component(getattr(task, "user_id", None) or "local", "local")
    return f"{config.OUTPUT_KEY_PREFIX}/{user_id}/{external_id}{suffix}"
