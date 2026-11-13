// The kept dashboard token (`dashboard --keep-token`): one file, published whole, reused as it is.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { keptToken, tokenFile } from "../skill-packs/cross-review/scripts/lib/dashboard/token.js";

const RACER = fileURLToPath(new URL("./helpers/token-racer.js", import.meta.url));
const POSIX = process.platform !== "win32";
// root reads and writes whatever the mode says
const NOT_ROOT = POSIX && process.getuid() !== 0;
const mode = file => fs.statSync(file).mode & 0o777;

let tmp;
let n = 0;
const dir = () => {
  const d = path.join(tmp, `d${n++}`);
  fs.mkdirSync(d);
  return d;
};
before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-token-"))); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("the default file is ~/.cross-review/dashboard-token", () => {
  assert.equal(tokenFile(), path.join(os.homedir(), ".cross-review", "dashboard-token"));
});

test("a missing file is published once, private, and reused", () => {
  const file = path.join(dir(), "sub", "dashboard-token");
  const token = keptToken(file);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(file, "utf8"), `${token}\n`);
  if (POSIX) assert.equal(mode(file), 0o600);
  assert.equal(keptToken(file), token);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["dashboard-token"], "no temp file left");
});

test("a valid file is used as it is; with or without the final LF; a loose mode is tightened", () => {
  const d = dir();
  const token = "0123456789abcdef".repeat(4);
  for (const [name, text] of [["bare", token], ["lf", `${token}\n`]]) {
    const file = path.join(d, name);
    fs.writeFileSync(file, text, { mode: 0o644 });
    assert.equal(keptToken(file), token);
    assert.equal(fs.readFileSync(file, "utf8"), text, "a valid file is never rewritten");
    if (POSIX) assert.equal(mode(file), 0o600);
  }
  if (POSIX) {
    const readOnly = path.join(d, "read-only");
    fs.writeFileSync(readOnly, token, { mode: 0o400 });
    assert.equal(keptToken(readOnly), token);
    assert.equal(mode(readOnly), 0o400);
  }
});

test("any other content stops the start: the file stays as it is, the message names it and how to renew", () => {
  const d = dir();
  const good = "a".repeat(64);
  const bad = {
    empty: "", short: "a".repeat(63), long: "a".repeat(65), upper: "A".repeat(64), nonhex: `${"a".repeat(63)}g`,
    crlf: `${good}\r\n`, "two-lf": `${good}\n\n`, "leading-space": ` ${good}`, "trailing-space": `${good} `, "leading-lf": `\n${good}`,
  };
  for (const [name, text] of Object.entries(bad)) {
    const file = path.join(d, name);
    fs.writeFileSync(file, text, { mode: 0o644 });
    assert.throws(() => keptToken(file), e => {
      assert.ok(e.message.includes(file), name);
      assert.match(e.message, /does not hold a dashboard token: Stop the dashboard, delete the file and start again to get a new token\./, name);
      if (text.trim()) assert.ok(!e.message.includes(text.trim()), `${name}: the content is not in the message`);
      return true;
    });
    assert.equal(fs.readFileSync(file, "utf8"), text, `${name}: bytes unchanged`);
    if (POSIX) assert.equal(mode(file), 0o644, `${name}: mode unchanged`);
  }
  assert.deepEqual(fs.readdirSync(d).sort(), Object.keys(bad).sort(), "no temp file left");
});

test("a file that cannot be read stops the start with its error code and the way out", { skip: !NOT_ROOT && "needs POSIX modes and a non-root user" }, () => {
  const file = path.join(dir(), "dashboard-token");
  fs.writeFileSync(file, `${"b".repeat(64)}\n`, { mode: 0o000 });
  try {
    assert.throws(() => keptToken(file), e => {
      assert.equal(e.message, `cannot read the dashboard token file ${file} (EACCES). Make it readable, or stop the dashboard, delete the file and start again to get a new token.`);
      return true;
    });
    assert.equal(mode(file), 0o000, "mode unchanged");
  } finally {
    fs.chmodSync(file, 0o600);
  }
  assert.equal(fs.readFileSync(file, "utf8"), `${"b".repeat(64)}\n`, "bytes unchanged");
});

test("a file that cannot be created stops the start; nothing is published", { skip: !NOT_ROOT && "needs POSIX modes and a non-root user" }, () => {
  const d = dir();
  const file = path.join(d, "dashboard-token");
  fs.chmodSync(d, 0o500);
  try {
    assert.throws(() => keptToken(file), e => {
      assert.equal(e.message, `cannot create the dashboard token file ${file} (EACCES)`);
      return true;
    });
    assert.deepEqual(fs.readdirSync(d), []);
  } finally {
    fs.chmodSync(d, 0o700);
  }
});

test("first starts at the same moment end with one token and no temp file", async () => {
  const d = dir();
  const file = path.join(d, "dashboard-token");
  const startAt = Date.now() + 1500; // long enough for eight node processes to be up and waiting
  const racers = Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    execFile(process.execPath, [RACER, file, String(startAt)], { encoding: "utf8" }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  }));
  const tokens = await Promise.all(racers);
  assert.match(tokens[0], /^[0-9a-f]{64}$/);
  assert.deepEqual([...new Set(tokens)], [tokens[0]], "every starter got the same token");
  assert.equal(fs.readFileSync(file, "utf8"), `${tokens[0]}\n`);
  assert.deepEqual(fs.readdirSync(d), ["dashboard-token"], "no temp file left");
});
