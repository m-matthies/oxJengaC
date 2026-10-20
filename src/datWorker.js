// Background worker that takes raw oxServe messages off the main thread:
// it does the JSON parsing and the dat -> backbone position parsing, and
// transfers the resulting Float32Array back (no copy).
//
// Messages in:
//   {type: "init", offsets}  backbone offsets (2 per element, oxDNA order)
//   {type: "message", run, text, targets?}  raw oxServe message of
//                            simulation run `run`, optionally with a used
//                            targets array to reuse (transferred)
// Messages out:
//   {run, console_log?, targets?}
// The dat text itself is not sent back (it would be a multi-MB copy); the
// main thread keeps the raw message and only parses it for a restart.

import { parseDatTargets } from "./datParser.js";

let offsets;

self.onmessage = (event) => {
    const msg = event.data;
    switch (msg.type) {
    case "init":
        offsets = msg.offsets;
        break;
    case "message": {
        const message = JSON.parse(msg.text);
        const reply = {run: msg.run};
        const transfer = [];
        if ("console_log" in message) {
            reply.console_log = message["console_log"];
        }
        if ("dat_file" in message && offsets !== undefined) {
            const count = offsets.length / 2;
            let targets = msg.targets;
            if (targets === undefined || targets.length !== 3 * count) {
                targets = new Float32Array(3 * count);
            }
            parseDatTargets(message["dat_file"], offsets, targets);
            reply.targets = targets;
            transfer.push(targets.buffer);
        }
        self.postMessage(reply, transfer);
        break;
    }
    default:
        console.warn(`Unknown worker message type: ${msg.type}`);
    }
};
