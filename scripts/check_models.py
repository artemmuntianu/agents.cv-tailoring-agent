#!/usr/bin/env python
"""List the Gemini models this API key can use and check MODEL_NAME.

    python scripts/check_models.py            # human report + deploy snippet
    python scripts/check_models.py --strict   # exit 1 if MODEL_NAME is missing

Run this once before the first production deploy: the shipped defaults are
placeholders, and an unknown model id is a *non-retryable* 400 which would send
every task straight to the dead-letter queue.
"""

import argparse
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    # Windows consoles default to cp1252 and choke on emoji output.
    sys.stdout.reconfigure(encoding="utf-8")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

import config  # noqa: E402
from agent.nodes import get_genai_client  # noqa: E402


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="check Gemini model availability")
    parser.add_argument("--strict", action="store_true", help="fail when MODEL_NAME is missing")
    args = parser.parse_args(argv)

    try:
        client = get_genai_client()
        models = list(client.models.list())
    except Exception as exc:  # noqa: BLE001
        print(f"❌ could not list models: {exc}")
        print("   Set GEMINI_API_KEY (or gcloud ADC) and retry.")
        return 2

    names = sorted({model.name.split("/")[-1] for model in models})
    if not names:
        print("❌ models.list() returned nothing for this key")
        return 2

    print("📚 Models available to this key:")
    for name in names:
        marker = "  <-- MODEL_NAME" if name == config.MODEL_NAME else ""
        print(f"   • {name}{marker}")

    current_ok = config.MODEL_NAME in names
    preferred_ok = [name for name in config.PREFERRED_MODELS if name in names]

    print()
    if current_ok:
        print(f"✅ MODEL_NAME={config.MODEL_NAME} is available")
    else:
        print(f"❌ MODEL_NAME={config.MODEL_NAME} is NOT available for this key")

    if preferred_ok:
        print(f"✅ usable fallbacks: {', '.join(preferred_ok)}")
    else:
        print("⚠️  none of PREFERRED_MODELS are available")

    suggestion = preferred_ok[:3] or names[:3]
    print("\nDeploy with (comma-separated, most preferred first):")
    print(f"  --set cv-tailoring-worker.config.modelName={suggestion[0]} \\")
    print(f"    --set cv-tailoring-worker.config.preferredModels={','.join(suggestion)}")

    if args.strict and not current_ok:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
