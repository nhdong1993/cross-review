// The opt-in dashboard token: publish a complete private file, then use the winner's token.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tokenFile() {
  return path.join(os.homedir(), ".cross-review", "dashboard-token");
}

const RENEW = "stop the dashboard, delete the file and start again to get a new token";

function publish(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, `${crypto.randomBytes(32).toString("hex")}\n`);
    } finally {
      fs.closeSync(fd);
    }
    // shortcut: a kept token is not fsynced, upgrade if a dashboard must survive power loss without a new link
    try {
      fs.linkSync(temp, file);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  } finally {
    fs.unlinkSync(temp);
  }
}

/** The token kept in `file`, published first when the file is missing. Throws when the file cannot be used. */
export function keptToken(file = tokenFile()) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`cannot read the dashboard token file ${file} (${e.code}). Make it readable, or ${RENEW}.`);
    try {
      publish(file);
      text = fs.readFileSync(file, "utf8");
    } catch (e2) {
      throw new Error(`cannot create the dashboard token file ${file} (${e2.code || e2.message})`);
    }
  }
  const token = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(`${file} does not hold a dashboard token: ${RENEW[0].toUpperCase()}${RENEW.slice(1)}.`);
  if (process.platform !== "win32" && (fs.statSync(file).mode & 0o077)) fs.chmodSync(file, 0o600);
  return token;
}
