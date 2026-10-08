"""The artifact's own file name (`apps/worker/utils/storage.py`).

A downloaded CV used to be `<external_id>.pdf` - `848944.pdf` - which says nothing about whose CV it
is. It is now `<candidate>-<external_id>.pdf` (`artemmuntianu-852417.pdf`, the reason this exists:
the operator downloads these files, edits one and uploads it back, and two cards open side by side
were indistinguishable).

What is worth pinning here: the slug rule, the fallback that keeps every artifact already on the
volume readable, and *why* the rule is ASCII-only - the board echoes the file name in a
`content-disposition` header it builds by hand, and Node refuses a header that is not latin-1.
"""

from types import SimpleNamespace

from utils import storage as storage_module


def task(external_id="852417", user_id="user-1"):
    return SimpleNamespace(job_id="job-" + external_id, external_id=external_id, user_id=user_id)


def test_the_candidate_name_goes_in_front_of_the_vacancy_id():
    assert storage_module.artifact_stem("Artem Muntianu", "852417") == "artemmuntianu-852417"
    assert (
        storage_module.output_key_for(task(), ".pdf", "Artem Muntianu")
        == "tailored/user-1/artemmuntianu-852417.pdf"
    )


def test_a_name_a_header_could_not_carry_keeps_the_vacancy_id():
    # Verified: `content-disposition: ... filename="Артем-852417.pdf"` raises
    # "Cannot convert argument to a ByteString because the character at index 18 has a value of 1040"
    # in Node - i.e. the download route would fail outright. A name in another script therefore
    # falls back instead of taking the response down with it.
    assert storage_module.artifact_stem("Артем Мунтяну", "852417") == "852417"
    # An accent is dropped the same way (it survives the header, but the slug stays ASCII-only so
    # there is one rule rather than two), and punctuation is simply not part of the slug.
    assert storage_module.artifact_stem("Artem Müntianu", "852417") == "artemmntianu-852417"
    assert storage_module.artifact_stem("O'Brien-Smith", "852417") == "obriensmith-852417"


def test_no_name_is_the_id_alone_and_nothing_else_moves():
    for name in ("", "   ", None):
        assert storage_module.artifact_stem(name, "852417") == "852417"
    # This is exactly the name every artifact had before the feature: a card with no owner, or an
    # owner with no facts row, is not renamed and does not have to be.
    assert storage_module.output_key_for(task(), ".docx") == "tailored/user-1/852417.docx"
    assert (
        storage_module.output_key_for(task(user_id=None), ".pdf", "Artem Muntianu")
        == "tailored/local/artemmuntianu-852417.pdf"
    )


def test_a_slug_is_reduced_to_a_single_safe_path_component():
    # Only alphanumerics survive, so a "name" shaped like a path is just characters - it cannot
    # walk out of the output directory, and a component a filesystem would refuse is capped.
    assert storage_module.artifact_stem("../../etc/passwd", "852417") == "etcpasswd-852417"
    assert (
        storage_module.artifact_stem("a" * 80, "852417")
        == "a" * storage_module.MAX_STEM_CHARS + "-852417"
    )
