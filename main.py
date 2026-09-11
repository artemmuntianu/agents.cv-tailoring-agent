# 2026-09-11 # System Healthcheck
import fnmatch
import os
import shutil
import sys

from agent.graph import create_graph
from agent.state import State
from utils.model_state import init_model_state

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ARTIFACTS_DIR = os.path.join(BASE_DIR, "artifacts")
INPUT_DIR = os.path.join(ARTIFACTS_DIR, "input")
OUTPUT_DIR = os.path.join(ARTIFACTS_DIR, "output")
TEMP_DIR = os.path.join(ARTIFACTS_DIR, "temp")

JD_FILE_PATTERN = "jd_*.txt"


def ensure_directories() -> None:
    """Make sure artifacts/input, artifacts/output and artifacts/temp exist."""
    for directory in (INPUT_DIR, OUTPUT_DIR, TEMP_DIR):
        os.makedirs(directory, exist_ok=True)


def reset_temp_dir() -> None:
    """Remove leftovers from previous runs so every batch starts fresh."""
    if os.path.isdir(TEMP_DIR):
        shutil.rmtree(TEMP_DIR, ignore_errors=True)
    os.makedirs(TEMP_DIR, exist_ok=True)


def find_job_descriptions(input_dir: str = INPUT_DIR):
    """Return sorted absolute paths of every jd_{jd_id}.txt inside the input dir."""
    if not os.path.isdir(input_dir):
        return []
    return sorted(
        os.path.join(input_dir, name)
        for name in os.listdir(input_dir)
        if fnmatch.fnmatch(name, JD_FILE_PATTERN)
    )


def jd_id_from_path(jd_path: str) -> str:
    """Extract the jd_id (text between 'jd_' and '.txt') from a JD file path."""
    name = os.path.basename(jd_path)
    return name[len("jd_"):-len(".txt")]


def run_cv_tailoring(cv_path: str, job_desc_path: str, output_path: str, temp_dir: str) -> None:
    print("🚀 Starting Automated CV Tailoring Agent...")
    print(f"📂 CV Path: {cv_path}")
    print(f"📋 Job Description Path: {job_desc_path}")
    print(f"🎯 Target Output Path: {output_path}")
    print(f"🛠️  Temp Dir: {temp_dir}")

    if not os.path.exists(cv_path):
        print(f"❌ Error: Resume file not found at {cv_path}")
        sys.exit(1)

    if not os.path.exists(job_desc_path):
        print(f"❌ Error: Job description file not found at {job_desc_path}")
        sys.exit(1)

    with open(job_desc_path, "r", encoding="utf-8") as f:
        job_description_text = f.read()

    initial_state: State = {
        "cv_path": cv_path,
        "job_description": job_description_text,
        "output_path": output_path,
        "temp_dir": temp_dir,
        "target_role_title": "",
        "current_cv_text": "",
        "modifications": [],
        "layout_feedback": "",
        "revision_count": 0,
        "image_paths": [],
        "is_approved": False,
    }

    # Restore persistence: resume from the last known-good model and skip models
    # that recently failed, so we don't waste retries on a rate-limited model.
    init_model_state()

    graph = create_graph()
    final_state = graph.invoke(initial_state)

    print("\n✨ Process finished!")
    print(f"📄 Tailored document saved to: {final_state['output_path']}")
    print(f"🏆 Final Layout Approved: {final_state['is_approved']}")
    print(f"🔄 Total Revisions: {final_state['revision_count']}")


def main() -> None:
    ensure_directories()
    reset_temp_dir()

    cv_path = os.path.join(INPUT_DIR, "cv.docx")
    if not os.path.exists(cv_path):
        print(f"❌ Error: Base CV not found at {cv_path}")
        print(f"   Place the etalon CV at: {os.path.join(INPUT_DIR, 'cv.docx')}")
        sys.exit(1)

    job_desc_paths = find_job_descriptions(INPUT_DIR)
    if not job_desc_paths:
        print(f"❌ Error: No job description files matching '{JD_FILE_PATTERN}' found in {INPUT_DIR}")
        sys.exit(1)

    total = len(job_desc_paths)
    print(f"📂 Found {total} job description file(s) in {INPUT_DIR}.\n")

    for index, job_desc_path in enumerate(job_desc_paths, start=1):
        jd_id = jd_id_from_path(job_desc_path)
        output_cv = os.path.join(OUTPUT_DIR, f"cv_{jd_id}.docx")
        run_temp_dir = os.path.join(TEMP_DIR, jd_id)

        # Skip JDs whose tailored .docx already exists in the output folder.
        if os.path.exists(output_cv):
            print("=" * 72)
            print(f"⏭️  Skipping JD {index}/{total}: {os.path.basename(job_desc_path)}")
            print(f"   ✅ Output CV already exists, skipping: {output_cv}")
            print("=" * 72)
            continue

        print("=" * 72)
        print(f"🔄 Processing JD {index}/{total}: {os.path.basename(job_desc_path)}")
        print(f"   📄 Output CV: {output_cv}")
        print("=" * 72)

        run_cv_tailoring(
            cv_path=cv_path,
            job_desc_path=job_desc_path,
            output_path=output_cv,
            temp_dir=run_temp_dir,
        )

    print(f"\n🎉 Finished processing {total} job description file(s).")
    print(f"📁 Tailored CVs written to: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
