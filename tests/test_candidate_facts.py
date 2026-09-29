"""The candidate-facts block (`utils/candidate.py`).

One renderer, three prompts: the CV tailoring prompt, the cover letter and the form prompt. What
is worth pinning here is that a fact is capped by the right limit (a form value is short, a
standing answer is prose), that both shapes of the stored document survive `sanitize()`, and that a
missing row is an empty block rather than an error.
"""

import tempfile

from tests.helpers import SAMPLE_CANDIDATE, isolated_config, seed_candidate
from utils import candidate as candidate_module
from utils import db as db_module


def test_digest_renders_the_facts_then_the_standing_answers():
    digest = candidate_module.digest(SAMPLE_CANDIDATE)
    assert "LOCATION: Portugal" in digest
    assert "ENGLISH LEVEL: B2 (Upper-Intermediate)" in digest
    assert "STANDING ANSWER - Redis and RabbitMQ experience: Caching with Redis" in digest
    # Short, form-shaped values first, then the prose: that is what the prompt lists.
    assert digest.index("LOCATION:") < digest.index("STANDING ANSWER")


def test_sanitize_keeps_the_known_keys_and_drops_the_rest():
    profile = candidate_module.sanitize(
        {
            "location": "  Portugal  ",
            "unknown_fact": "dropped",
            "salary_expectation": 5000,
            "standing_answers": {"Q": "A", 7: "a non-string question"},
        }
    )
    assert profile == {
        "location": "Portugal",
        "salary_expectation": "5000",
        "standing_answers": {"Q": "A"},
    }


def test_a_standing_answer_gets_its_own_longer_cap():
    profile = candidate_module.sanitize(
        {
            "location": "y" * (candidate_module.MAX_VALUE_CHARS + 100),
            "standing_answers": {"Q": "x" * (candidate_module.MAX_ANSWER_CHARS + 100)},
        }
    )
    assert len(profile["location"]) == candidate_module.MAX_VALUE_CHARS
    assert len(profile["standing_answers"]["Q"]) == candidate_module.MAX_ANSWER_CHARS
    # A project deep-dive does not fit in a form-field value, which is the whole point of the
    # second cap. The gateway mirrors both (`backoffice/src/lib/candidate.ts`).
    assert candidate_module.MAX_ANSWER_CHARS > candidate_module.MAX_VALUE_CHARS


def test_a_missing_row_or_user_is_an_empty_block_never_an_error():
    with tempfile.TemporaryDirectory() as tmp:
        with isolated_config(tmp):
            store = db_module.get_db()
            assert candidate_module.load(store, "") == {}
            assert candidate_module.load(store, "nobody") == {}
            assert candidate_module.digest({}) == ""

            seed_candidate("user-1")
            facts = candidate_module.load(store, "user-1")
            assert facts["location"] == "Portugal"
            assert candidate_module.digest(facts).startswith("LOCATION: Portugal")
