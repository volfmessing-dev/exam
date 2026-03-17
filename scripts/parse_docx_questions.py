#!/usr/bin/env python3
# Parses a .docx containing multiple-choice questions into a JSON dataset
# that can be imported by the React UI (Vite can import JSON directly).

from __future__ import annotations

import argparse
import json
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree as ET


W_NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}

# Canonical mapping to indices used by the UI.
# Many RU tests label options as А,Б,В,Г; some use A,B,C,D; some mix.
LETTER_TO_INDEX = {
    "A": 0,
    "А": 0,
    "B": 1,
    "Б": 1,
    "C": 2,
    "В": 2,
    "D": 3,
    "Г": 3,
    "E": 4,
    "Д": 4,
    "F": 5,
    "Е": 5,
}

LETTER_CLASS = "AАBБCВDГEДFЕ"

# In some documents option markers are written as "А )" (space before ')').
INLINE_MARKER_RE = re.compile(rf"([{LETTER_CLASS}])\s*\)")
LINE_PREFIX_RE = re.compile(rf"^\s*([{LETTER_CLASS}])\s*\)\s*")

ANSWER_LINE_RE = re.compile(rf"^\s*[{LETTER_CLASS}](?:\s*[,;]\s*[{LETTER_CLASS}])*\s*$")
ANSWER_LINE_SPACE_RE = re.compile(rf"^\s*[{LETTER_CLASS}](?:\s+[{LETTER_CLASS}])+\s*$")


def _looks_like_answer(line: str) -> bool:
    return bool(ANSWER_LINE_RE.match(line) or ANSWER_LINE_SPACE_RE.match(line))


def _parse_answer(line: str) -> list[int]:
    letters = re.findall(rf"[{LETTER_CLASS}]", line)
    indices: set[int] = set()
    for ch in letters:
        idx = LETTER_TO_INDEX.get(ch)
        if idx is not None:
            indices.add(idx)
    return sorted(indices)


def _extract_paragraphs(docx_path: Path) -> list[str]:
    with zipfile.ZipFile(docx_path) as z:
        xml = z.read("word/document.xml")
    root = ET.fromstring(xml)

    paragraphs: list[str] = []
    for p in root.findall(".//w:p", W_NS):
        texts = [t.text for t in p.findall(".//w:t", W_NS) if t.text]
        if not texts:
            continue
        s = "".join(texts)
        s = re.sub(r"\s+", " ", s).strip()
        if s:
            paragraphs.append(s)
    return paragraphs


def _parse_inline_options(line: str) -> list[str] | None:
    matches = list(INLINE_MARKER_RE.finditer(line))
    if len(matches) < 2:
        return None

    opts: dict[int, str] = {}
    for i, m in enumerate(matches):
        ch = m.group(1)
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(line)
        text = line[start:end].strip()
        text = re.sub(r"\s+", " ", text).strip(" ;")

        idx = LETTER_TO_INDEX.get(ch)
        if idx is not None:
            opts[idx] = text

    if len(opts) < 2:
        return None

    max_idx = max(opts)
    return [opts.get(i, "") for i in range(max_idx + 1)]


def _parse_multiline_options(paras: list[str], start_idx: int) -> tuple[list[str], int, bool]:
    # Collect option lines until answer or next question/discipline heading.
    # Some documents store options:
    # - one per line with "А)"/"A)" prefixes
    # - several options in one line ("А) ... Б) ... В) ...")
    # - without explicit prefixes (just 4 plain lines)
    opts_unmarked: list[str] = []

    opts_by_idx: dict[int, str] = {}
    last_idx: int | None = None
    saw_marker = False

    i = start_idx
    while i < len(paras):
        s = paras[i]
        if s.startswith("Выберите "):
            break
        if re.match(r"^Дисциплина\s+\d+\s*:", s):
            break
        if _looks_like_answer(s):
            break
        if s in (
            "№ п/п",
            "Содержание вопроса",
            "Варианты ответов",
            "Верный ответ",
            "Задания закрытого типа",
        ):
            i += 1
            continue

        inline = _parse_inline_options(s)
        if inline is not None:
            saw_marker = True
            for idx, text in enumerate(inline):
                if text:
                    opts_by_idx[idx] = text
                    last_idx = idx
            i += 1
            continue

        m = LINE_PREFIX_RE.match(s)
        if m:
            saw_marker = True
            ch = m.group(1)
            idx = LETTER_TO_INDEX.get(ch)
            text = LINE_PREFIX_RE.sub("", s).strip()
            if idx is not None:
                opts_by_idx[idx] = text
                last_idx = idx
            else:
                opts_unmarked.append(text)
            i += 1
            continue

        text = s.strip()
        if saw_marker and last_idx is not None:
            opts_by_idx[last_idx] = (opts_by_idx.get(last_idx, "") + " " + text).strip()
        else:
            opts_unmarked.append(text)
        i += 1

    if saw_marker and opts_by_idx:
        max_idx = max(opts_by_idx)
        options = [opts_by_idx.get(k, "") for k in range(max_idx + 1)]
        return options, i, True

    return opts_unmarked, i, False


def _looks_like_code(line: str) -> bool:
    # Heuristic for code-like fragments often present in JS questions.
    s = line.strip()
    if not s:
        return False
    if any(token in s for token in ("{", "}", "=>", ";", "console.", "function ", "let ", "const ", "while ", "for ")):
        return True
    if re.match(r"^(?:[a-zA-Z_$][\w$]*\s*=|return\s+)", s):
        return True
    return False


@dataclass(frozen=True)
class Question:
    discipline: str
    question: str
    options: list[str]
    answer: list[int]
    multi: bool


def parse_questions(docx_path: Path) -> list[Question]:
    paras = _extract_paragraphs(docx_path)

    questions: list[Question] = []
    current_disc: str | None = None

    i = 0
    while i < len(paras):
        p = paras[i]

        m = re.match(r"^Дисциплина\s+(\d+)\s*:\s*(.*)$", p)
        if m:
            name = m.group(2).strip()
            # Drop trailing page digits present in TOC lines.
            name = re.sub(r"(\D)\d+$", r"\1", name).strip()
            current_disc = f"{m.group(1)}. {name}"
            i += 1
            continue

        if p.startswith("Выберите правильный вариант ответа:") or p.startswith(
            "Выберите правильные варианты ответа:"
        ):
            multi = p.startswith("Выберите правильные варианты ответа:")
            after = p.split(":", 1)[1].strip()

            if after:
                q_text = after
                j = i + 1
            else:
                q_text = paras[i + 1].strip() if i + 1 < len(paras) else ""
                j = i + 2

            # Skip table noise
            while j < len(paras) and paras[j] in (
                "№ п/п",
                "Содержание вопроса",
                "Варианты ответов",
                "Верный ответ",
            ):
                j += 1

            # Some questions span multiple paragraphs or include code fragments.
            # Absorb such lines into question text before parsing options.
            q_parts: list[str] = [q_text] if q_text else []
            while j < len(paras):
                s = paras[j]
                if s.startswith("Выберите "):
                    break
                if re.match(r"^Дисциплина\s+\d+\s*:", s):
                    break
                if _looks_like_answer(s):
                    break
                if s in ("№ п/п", "Содержание вопроса", "Варианты ответов", "Верный ответ", "Задания закрытого типа"):
                    j += 1
                    continue

                # Option markers are a strong signal that options start.
                if LINE_PREFIX_RE.match(s) or _parse_inline_options(s) is not None:
                    break

                if _looks_like_code(s) or s.endswith(":"):
                    q_parts.append(s)
                    j += 1
                    continue

                # If the question already looks complete, stop.
                if q_parts and q_parts[-1].rstrip().endswith(("?", "…", ".")):
                    break

                q_parts.append(s)
                j += 1

            q_text = " ".join([re.sub(r"\s+", " ", x).strip() for x in q_parts if x.strip()]).strip()

            options: list[str] = []
            options_from_markers = False
            if j < len(paras):
                inline = _parse_inline_options(paras[j])
                if inline is not None:
                    options = inline
                    options_from_markers = True
                    j += 1
                else:
                    options, j, saw_marker = _parse_multiline_options(paras, j)
                    options_from_markers = saw_marker

            # Skip table noise before answer
            while j < len(paras) and paras[j] in (
                "№ п/п",
                "Содержание вопроса",
                "Варианты ответов",
                "Верный ответ",
            ):
                j += 1

            ans: list[int] = []
            if j < len(paras) and _looks_like_answer(paras[j]):
                ans = _parse_answer(paras[j])
            elif j + 1 < len(paras) and _looks_like_answer(paras[j + 1]):
                ans = _parse_answer(paras[j + 1])
                j += 1

            if len(ans) > 1:
                multi = True

            # If options were parsed without markers, code fragments may have been captured as options.
            # Use answer width to split leading context lines back into the question.
            if ans and options and not options_from_markers:
                target = max(ans) + 1
                if target < 4:
                    target = 4
                if target > 6:
                    target = 6
                if len(options) > target:
                    extras = options[: len(options) - target]
                    tail = options[-target:]
                    if (
                        any(_looks_like_code(x) for x in extras)
                        or any(x.endswith(":") for x in extras)
                        or len(options) >= target + 2
                    ):
                        q_text = (q_text + " " + " ".join(extras)).strip()
                        options = tail

            if current_disc and q_text and options and ans:
                questions.append(
                    Question(
                        discipline=current_disc,
                        question=q_text,
                        options=options,
                        answer=ans,
                        multi=multi,
                    )
                )

            i = j + 1
            continue

        i += 1

    return questions


def _to_jsonable(questions: Iterable[Question]) -> dict:
    qs = list(questions)
    return {
        "version": 1,
        "source": "docx",
        "questions": [
            {
                "discipline": q.discipline,
                "question": q.question,
                "options": q.options,
                "answer": q.answer,
                "multi": q.multi,
            }
            for q in qs
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Parse questions from a .docx into JSON.")
    parser.add_argument(
        "--input",
        default="госы.docx",
        help="Path to .docx (default: госы.docx in repo root)",
    )
    parser.add_argument(
        "--output",
        default="web/src/data/questions.json",
        help="Output JSON path (default: web/src/data/questions.json)",
    )
    args = parser.parse_args()

    docx_path = Path(args.input)
    out_path = Path(args.output)

    questions = parse_questions(docx_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(_to_jsonable(questions), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    # Print a tiny report for CLI usage.
    by_disc: dict[str, int] = {}
    for q in questions:
        by_disc[q.discipline] = by_disc.get(q.discipline, 0) + 1
    print(f"Wrote {len(questions)} questions to {out_path}")
    for k in sorted(by_disc):
        print(f" - {k}: {by_disc[k]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
