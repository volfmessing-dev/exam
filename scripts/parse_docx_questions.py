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
}

INLINE_MARKER_RE = re.compile(r"([AАBБCВDГ])\)")
LINE_PREFIX_RE = re.compile(r"^\s*([AАBБCВDГ])\)\s*")

ANSWER_LINE_RE = re.compile(r"^\s*[AАBБCВDГ](?:\s*[,;]\s*[AАBБCВDГ])*\s*$")
ANSWER_LINE_SPACE_RE = re.compile(r"^\s*[AАBБCВDГ](?:\s+[AАBБCВDГ])+\s*$")


def _looks_like_answer(line: str) -> bool:
    return bool(ANSWER_LINE_RE.match(line) or ANSWER_LINE_SPACE_RE.match(line))


def _parse_answer(line: str) -> list[int]:
    letters = re.findall(r"[AАBБCВDГ]", line)
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


def _parse_multiline_options(paras: list[str], start_idx: int) -> tuple[list[str], int]:
    # Collect option lines until answer or next question/discipline heading.
    # Some sections store options as 4 separate lines without A)/Б)/... prefixes.
    opts: list[str] = []
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

        s = LINE_PREFIX_RE.sub("", s).strip()
        opts.append(s)
        i += 1
    return opts, i


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

            options: list[str] = []
            if j < len(paras):
                inline = _parse_inline_options(paras[j])
                if inline is not None:
                    options = inline
                    j += 1
                else:
                    options, j = _parse_multiline_options(paras, j)

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

