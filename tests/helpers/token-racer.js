// Child process for the concurrent first-start test: waits for a shared start time, then asks
// for the kept token of the given file and prints it. usage: node token-racer.js <file> <startAtMs>
import { keptToken } from "../../skill-packs/cross-review/scripts/lib/dashboard/token.js";

const [file, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) { /* spin: every racer leaves at the same millisecond */ }
process.stdout.write(keptToken(file));
