"""Escaped HTML -> plain text, shared by every feed parser.

Both boards ship the job description as HTML that is *escaped inside the XML*
(`<description>&lt;p&gt;…`), and both also double-escape the entities inside that HTML -
`AT&amp;amp;T` on DOU and `custom&amp;nbsp;IT` / `Leadership &amp;amp; Collaboration` on Djinni are
real examples from the live feeds. The XML parser unescapes the first layer by itself, so the
second one is ours: that is why the text is unescaped twice here, and why a parser must not do its
own entity handling.

It lives outside the parsers because the rule belongs to the *feeds*, not to one site: a new parser
gets the same treatment by calling this, and a fix here is a fix for every source at once.
"""

import html
import re

TAG_RE = re.compile(r"<[^>]+>")
BR_RE = re.compile(r"<br\s*/?>")


def to_text(raw: str | None, cut_at: str | None = None) -> str:
    """The description as plain text with paragraph breaks (the board shows it verbatim).

    `cut_at` is the site's own chrome marker: everything from that string on is dropped, because a
    feed that appends "apply here" machinery is quoting the site, not the vacancy (DOU does; Djinni
    appends nothing and passes no marker).
    """
    text = str(raw or "")
    if cut_at and cut_at in text:
        text = text[: text.index(cut_at)]

    text = text.replace("</li>", "\n").replace("</p>", "\n\n").replace("<li>", "• ")
    text = BR_RE.sub("\n", text)
    text = TAG_RE.sub("", text)
    # Twice: the XML layer and the HTML layer each escaped their entities.
    text = html.unescape(html.unescape(text))
    # `&nbsp;` is how both feeds spell a space; kept as-is it would travel into the card and the
    # prompt as an invisible *different* character, which is the kind of thing that breaks a diff
    # and a prompt for no reason.
    text = text.replace("\u00a0", " ")
    lines = [line.strip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    collapsed: list[str] = []
    for line in lines:
        if not line and collapsed and not collapsed[-1]:
            continue  # at most one blank line in a row
        collapsed.append(line)
    return "\n".join(collapsed).strip()
