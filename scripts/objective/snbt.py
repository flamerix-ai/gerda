"""Tolerant SNBT (stringified-NBT) parser — enough for FTB Quests chapter files.

SNBT is JSON-ish but: keys are usually unquoted; element separators are whitespace
*or* commas (both optional); numbers carry type suffixes (12L, 1.5d, 1b, 3s, 2f);
strings are double-quoted with JSON escapes (descriptions embed escaped JSON). We only
need ids/counts/types/dependencies, so coercion is deliberately forgiving: anything
that isn't an object/array/quoted-string/number/bool comes back as a bare string.

No third-party deps (stdlib only) — runs under the flake's python312.
"""
from __future__ import annotations

import re

_NUM = re.compile(r"^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[bBsSlLfFdD]?$")
_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "/": "/", "'": "'"}


class SNBTError(ValueError):
    pass


class _Parser:
    def __init__(self, text: str) -> None:
        self.s = text
        self.i = 0
        self.n = len(text)

    def parse(self):
        self._ws()
        v = self._value()
        self._ws()
        return v

    # commas act as separators -> treat them as whitespace at structural level
    def _ws(self) -> None:
        while self.i < self.n and self.s[self.i] in " \t\r\n,":
            self.i += 1

    def _value(self):
        if self.i >= self.n:
            raise SNBTError("unexpected end of input")
        c = self.s[self.i]
        if c == "{":
            return self._object()
        if c == "[":
            return self._array()
        if c == '"':
            return self._string()
        return self._literal()

    def _object(self) -> dict:
        self.i += 1  # {
        obj: dict = {}
        while True:
            self._ws()
            if self.i >= self.n:
                raise SNBTError("unterminated object")
            if self.s[self.i] == "}":
                self.i += 1
                return obj
            key = self._key()
            self._ws()
            if self.i >= self.n or self.s[self.i] != ":":
                raise SNBTError(f"expected ':' after key {key!r} at {self.i}")
            self.i += 1
            self._ws()
            obj[key] = self._value()

    def _array(self) -> list:
        self.i += 1  # [
        arr: list = []
        # NBT typed-array prefix like [I; 1,2,3] / [L; ...] / [B; ...]
        self._ws()
        if self.i + 1 < self.n and self.s[self.i] in "ILBils" and self.s[self.i + 1] == ";":
            self.i += 2
        while True:
            self._ws()
            if self.i >= self.n:
                raise SNBTError("unterminated array")
            if self.s[self.i] == "]":
                self.i += 1
                return arr
            arr.append(self._value())

    def _key(self) -> str:
        if self.s[self.i] == '"':
            return self._string()
        start = self.i
        while self.i < self.n and (self.s[self.i].isalnum() or self.s[self.i] in "_-.+"):
            self.i += 1
        if self.i == start:
            raise SNBTError(f"empty key at {self.i}")
        return self.s[start:self.i]

    def _string(self) -> str:
        self.i += 1  # opening quote
        out: list[str] = []
        while self.i < self.n:
            c = self.s[self.i]
            if c == "\\":
                nxt = self.s[self.i + 1] if self.i + 1 < self.n else ""
                out.append(_ESCAPES.get(nxt, nxt))
                self.i += 2
                continue
            if c == '"':
                self.i += 1
                return "".join(out)
            out.append(c)
            self.i += 1
        raise SNBTError("unterminated string")

    def _literal(self):
        start = self.i
        while self.i < self.n and self.s[self.i] not in " \t\r\n,{}[]:":
            self.i += 1
        tok = self.s[start:self.i]
        return _coerce(tok)


def _coerce(tok: str):
    if tok == "true":
        return True
    if tok == "false":
        return False
    if _NUM.match(tok):
        body = tok[:-1] if tok[-1] in "bBsSlLfFdD" and not tok[-1].isdigit() else tok
        try:
            if any(ch in body for ch in ".eE") or tok[-1:] in "fFdD":
                return float(body)
            return int(body)
        except ValueError:
            return tok
    return tok


def loads(text: str):
    """Parse one SNBT document."""
    return _Parser(text).parse()
