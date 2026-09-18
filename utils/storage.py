"""Artifact storage.

* ``local``    - the historical `artifacts/input` + `artifacts/output` folders.
* ``supabase`` - Supabase Storage objects (`master/cv.docx`, `master/cv_data.json`
  in, `tailored/<user>/<external_id>.pdf` out), called over the Storage REST API
  with `httpx` so no heavyweight SDK is needed in the worker image.

`prepare_task()` hides the difference: the pipeline always receives a local
`cv_path` + a parsed `cv_data` dict, and always writes its result back through
`upload()`.
"""

import json
import os
import shutil
from dataclasses import dataclass, field

import config
from utils.logging_setup import get_logger

log = get_logger(__name__)

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PDF_MIME = "application/pdf"
JSON_MIME = "application/json"


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
    cleaned = "".join(
        character if character.isalnum() or character in ("-", "_", ".") else "_"
        for character in str(value or "")
    ).strip("_")
    return cleaned or fallback


class LocalStorage:
    """Filesystem-backed artifacts (CLI / local POC / tests)."""

    backend = "local"

    def __init__(self, input_dir=None, output_dir=None):
        self.input_dir = input_dir or config.INPUT_DIR
        self.output_dir = output_dir or config.OUTPUT_DIR

    # -- inputs ------------------------------------------------------------ #
    def fetch_master_cv(self, task=None, dest_dir=None):
        source = os.path.join(self.input_dir, config.MASTER_CV_FILENAME)
        if not os.path.exists(source):
            raise FileNotFoundError(
                f"master CV not found at {source} (place the etalon CV there)"
            )
        if dest_dir is None:
            return source
        os.makedirs(dest_dir, exist_ok=True)
        destination = os.path.join(dest_dir, config.MASTER_CV_FILENAME)
        shutil.copy2(source, destination)
        return destination

    def fetch_cv_data(self, task=None):
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
    def upload(self, local_path, remote_key, content_type=None):
        """Copy the artifact into the output folder and return its path."""
        os.makedirs(self.output_dir, exist_ok=True)
        destination = os.path.join(self.output_dir, os.path.basename(remote_key))
        shutil.copy2(local_path, destination)
        log.info("artifact stored locally", path=destination, key=remote_key)
        return destination

    # -- convenience ------------------------------------------------------- #
    def prepare_task(self, task):
        job_id = getattr(task, "job_id", None) or "local-job"
        workdir = os.path.join(config.TEMP_ROOT, _safe_component(job_id, "job"))
        os.makedirs(workdir, exist_ok=True)
        cv_path = self.fetch_master_cv(task, dest_dir=None)
        cv_data = self.fetch_cv_data(task)
        external_id = _safe_component(getattr(task, "external_id", "cv"), "cv")
        return TaskContext(
            job_id=job_id,
            workdir=workdir,
            cv_path=cv_path,
            cv_data=cv_data,
            output_path=os.path.join(workdir, f"cv_{external_id}.docx"),
            temp_dir=workdir,
        )


class SupabaseStorage:
    """Supabase Storage backend (Storage REST API via httpx)."""

    backend = "supabase"

    def __init__(self, url=None, service_key=None, bucket=None, timeout=60.0):
        import httpx  # imported lazily so the base install stays light

        self.url = (url or config.SUPABASE_URL).rstrip("/")
        self.service_key = service_key or config.SUPABASE_SERVICE_ROLE_KEY
        self.bucket = bucket or config.SUPABASE_BUCKET
        if not self.url or not self.service_key:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when "
                "STORAGE_BACKEND=supabase"
            )
        self._client = httpx.Client(timeout=timeout)
        self._headers = {
            "Authorization": f"Bearer {self.service_key}",
            "apikey": self.service_key,
        }

    def _object_url(self, key):
        return f"{self.url}/storage/v1/object/{self.bucket}/{key}"

    def download(self, key, destination):
        response = self._client.get(self._object_url(key), headers=self._headers)
        if response.status_code >= 400:
            raise RuntimeError(
                f"supabase download failed ({response.status_code}) for {key}: "
                f"{response.text[:200]}"
            )
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        with open(destination, "wb") as handle:
            handle.write(response.content)
        return destination

    def fetch_master_cv(self, task=None, dest_dir=None):
        target_dir = dest_dir or os.path.join(
            config.TEMP_ROOT, _safe_component(getattr(task, "job_id", "job"), "job")
        )
        destination = os.path.join(target_dir, config.MASTER_CV_FILENAME)
        return self.download(config.SUPABASE_MASTER_CV_KEY, destination)

    def fetch_cv_data(self, task=None):
        if task is not None and getattr(task, "cv_data", None):
            return task.cv_data
        target_dir = os.path.join(
            config.TEMP_ROOT, _safe_component(getattr(task, "job_id", "job"), "job")
        )
        destination = os.path.join(target_dir, "cv_data.json")
        self.download(config.SUPABASE_CV_DATA_KEY, destination)
        with open(destination, encoding="utf-8") as handle:
            return json.load(handle)

    def upload(self, local_path, remote_key, content_type=None):
        """Upload an artifact and return a URL the dashboard can use.

        A long-lived signed URL is returned instead of a public one so the
        bucket can stay private.
        """
        if content_type is None:
            content_type = PDF_MIME if remote_key.lower().endswith(".pdf") else DOCX_MIME
        with open(local_path, "rb") as handle:
            payload = handle.read()

        headers = {
            **self._headers,
            "Content-Type": content_type,
            "x-upsert": "true",
        }
        response = self._client.post(
            self._object_url(remote_key), headers=headers, content=payload
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"supabase upload failed ({response.status_code}) for {remote_key}: "
                f"{response.text[:200]}"
            )

        sign_response = self._client.post(
            f"{self.url}/storage/v1/object/sign/{self.bucket}/{remote_key}",
            headers={**self._headers, "Content-Type": JSON_MIME},
            json={"expiresIn": config.SUPABASE_URL_TTL_SECONDS},
        )
        if sign_response.status_code >= 400:
            log.warning(
                "signed url generation failed - returning the object key",
                key=remote_key,
                status=sign_response.status_code,
            )
            return remote_key
        signed_path = sign_response.json().get("signedURL", "")
        if signed_path.startswith("http"):
            return signed_path
        return f"{self.url}/storage/v1{signed_path}"

    # -- convenience ------------------------------------------------------- #
    def prepare_task(self, task):
        job_id = getattr(task, "job_id", None) or "job"
        workdir = os.path.join(config.TEMP_ROOT, _safe_component(job_id, "job"))
        os.makedirs(workdir, exist_ok=True)
        cv_path = self.fetch_master_cv(task, dest_dir=workdir)
        cv_data = self.fetch_cv_data(task)
        external_id = _safe_component(getattr(task, "external_id", "cv"), "cv")
        return TaskContext(
            job_id=job_id,
            workdir=workdir,
            cv_path=cv_path,
            cv_data=cv_data,
            output_path=os.path.join(workdir, f"cv_{external_id}.docx"),
            temp_dir=workdir,
        )


_STORAGE_CACHE = {}


def get_storage(backend=None):
    """Return the configured storage backend."""
    backend = (backend or config.STORAGE_BACKEND or "local").strip().lower()
    if backend not in _STORAGE_CACHE:
        _STORAGE_CACHE[backend] = (
            SupabaseStorage() if backend == "supabase" else LocalStorage()
        )
    return _STORAGE_CACHE[backend]


def reset_storage_cache():
    """Test helper: forget cached backends."""
    _STORAGE_CACHE.clear()


def output_key_for(task, suffix):
    """Canonical object key for a tailored artifact."""
    external_id = _safe_component(getattr(task, "external_id", "cv"), "cv")
    user_id = _safe_component(getattr(task, "user_id", None) or "local", "local")
    return f"{config.SUPABASE_OUTPUT_PREFIX}/{user_id}/{external_id}{suffix}"
