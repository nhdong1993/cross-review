"""readStep for macOS (test-slot.js calls it once per dashboard snapshot).

    python3 -I procargs.py PID...      pids deepest first, payload last; prints {"program", "script"?} or null
    python3 -I procargs.py --select    selection only: reads [{"exe", "argv"} | null, ...] as JSON on stdin

Reads each process's executable path and arguments with sysctl KERN_PROCARGS2 (argument boundaries kept) and prints
only the chosen program name and script path; raw arguments never leave this process. Same rule as selectStep() in
test-slot.js, checked against tests/helpers/fixtures/test-slot-steps.json.
"""
import ctypes
import json
import os
import re
import struct
import sys

INTERPRETER = re.compile(r"^(node|python[0-9.]*|deno|ruby|bash|sh|zsh)$", re.I)
SCRIPT = re.compile(r"\.(js|mjs|cjs|ts|py|sh|rb)$")
CTL_KERN, KERN_ARGMAX, KERN_PROCARGS2 = 1, 8, 49


def select_step(entries):
    return pick_step(len(entries), lambda i: entries[i])


def pick_step(n, at):
    """select_step over n candidates read one at a time by at(i), stopping at the first script; each candidate's
    arguments are dropped once looked at, only the payload's (last) program name is kept for the fallback."""
    payload = None
    for i in range(n):
        e = at(i)
        if not e or not e.get("exe"):
            continue
        if i == n - 1:
            payload = os.path.basename(e["exe"])
        program = os.path.basename(e["exe"])
        if not INTERPRETER.match(program):
            continue
        argv = e.get("argv") or []
        op = argv[1] if len(argv) > 1 else None
        if not isinstance(op, str) or op.startswith("-") or not SCRIPT.search(op):
            continue
        # a script whose name holds : ? # shows only its program, since it cannot be told from a URL
        return {"program": program} if re.search(r"[:?#]", op) else {"program": program, "script": op}
    return {"program": payload} if payload else None


def sysctl(libc, mib, size):
    arr = (ctypes.c_int * len(mib))(*mib)
    buf = ctypes.create_string_buffer(size)
    n = ctypes.c_size_t(size)
    if libc.sysctl(arr, len(mib), buf, ctypes.byref(n), None, 0) != 0:
        return None
    return buf.raw[: n.value]


def procargs(libc, pid, size):
    """{"exe", "argv"} for pid, or None when it cannot be read (gone, not ours)."""
    b = sysctl(libc, [CTL_KERN, KERN_PROCARGS2, pid], size)
    if not b or len(b) < 4:
        return None
    argc = struct.unpack_from("i", b, 0)[0]
    rest = b[4:]
    end = rest.find(b"\0")
    if end <= 0:
        return None
    exe, i = rest[:end], end
    while i < len(rest) and rest[i] == 0:  # the exec path is padded with NULs
        i += 1
    argv = []
    while len(argv) < argc and i < len(rest):
        j = rest.find(b"\0", i)
        j = len(rest) if j < 0 else j
        argv.append(rest[i:j].decode("utf-8", "replace"))
        i = j + 1
    return {"exe": exe.decode("utf-8", "replace"), "argv": argv}


def main():
    if sys.argv[1:] == ["--select"]:
        print(json.dumps(select_step(json.load(sys.stdin))))
        return
    libc = ctypes.CDLL("/usr/lib/libc.dylib", use_errno=True)
    m = sysctl(libc, [CTL_KERN, KERN_ARGMAX], 4)
    size = struct.unpack("i", m)[0] if m else 1 << 20
    pids = [int(p) for p in sys.argv[1:] if p.isdigit()]
    print(json.dumps(pick_step(len(pids), lambda i: procargs(libc, pids[i], size))))


if __name__ == "__main__":
    main()
