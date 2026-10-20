import {dna_relax_scenario, rna_relax_scenario} from "./relax_scenarios.js";
export class OXServeSocket extends WebSocket{
    constructor(url, system, top, dat, type="DNA") {
        super(url);

        switch (type) {
        case "DNA":
            this.relax_scenario = dna_relax_scenario;
            break;
        case "RNA":
            this.relax_scenario = rna_relax_scenario;
            break;
        default:
            console.warn(`Relax scenario for ${type} not implemented yet`);
            return;
        }

        this.abort = true;
        // No traps to begin with
        this.forces = "";
        // Incremented on every (re)start, so that frames of an aborted run
        // still being parsed in the worker can be told apart
        this.run = 0;

        this.onopen = (resonse) => {
            console.log("connected to nanobase", resonse);
            this.abort = false;
            //this.start_simulation()
        };

        this.onerror = (resonse) => {
            console.log("WebSocket error: ", resonse);
        };

        // JSON and dat parsing happen in a worker, off the main thread
        this.worker = new Worker(
            new URL("./datWorker.js", import.meta.url), {type: "module"}
        );
        this.worker.postMessage({type: "init", offsets: system.backboneOffsets});
        // A used targets array, handed back to the worker for reuse
        this.spareTargets = undefined;

        this.onmessage = (response) => {
            if(!this.abort){ //ignore all incomming messages when we stop the simulation
                // Keep a reference to the newest configuration message, it
                // is only parsed here if the simulation needs to be
                // restarted. The key precedes the (multi-MB) value, so
                // this check only scans the start of the message.
                if (response.data.indexOf("\"dat_file\"") !== -1) {
                    this.latestMessage = response.data;
                }
                const msg = {
                    type: "message",
                    run: this.run,
                    text: response.data,
                    targets: this.spareTargets
                };
                this.spareTargets = undefined;
                this.worker.postMessage(
                    msg, msg.targets ? [msg.targets.buffer] : []
                );
            }
        };
        this.worker.onmessage = (event) => {
            const {run, console_log, targets} = event.data;
            if (console_log !== undefined) {
                console.log(console_log);
            }
            if (targets !== undefined) {
                // Drop frames of a stopped or restarted run
                if (!this.abort && run === this.run) {
                    system.setTargets(targets);
                }
                this.spareTargets = targets;
            }
        };
        this.worker.onerror = (error) => {
            console.error("oxServe worker error: ", error);
        };
        this.onclose = () => {
            console.log("lost oxServe Connection");
            this.abort = true;
            this.worker.terminate();
        };
        this.top = top;
        this.dat = dat;

    }

    // The newest configuration received, to restart the simulation from
    get_latest_dat() {
        if (this.latestMessage !== undefined) {
            const message = JSON.parse(this.latestMessage);
            this.latestMessage = undefined;
            if ("dat_file" in message) {
                this.dat = message["dat_file"];
            }
        }
        return this.dat;
    }

    stop_simulation() {
        if (this.readyState === WebSocket.OPEN) {
            this.send("abort");
        }
        this.abort = true;
    }

    start_simulation() {
        if (this.readyState === WebSocket.CONNECTING) {
            // Defer until connected, sending throws before that
            if (!this.startPending) {
                this.startPending = true;
                this.addEventListener("open", () => {
                    this.startPending = false;
                    this.start_simulation();
                }, {once: true});
            }
            return;
        }
        if (this.readyState !== WebSocket.OPEN) {
            console.warn("Cannot start simulation, oxServe connection is closed");
            return;
        }
        this.abort = false;
        this.run++;
        let conf = {};
        conf["settings"] = this.relax_scenario;
        if (this.forces !== "") {
            conf["trap_file"] = this.forces;
        }
        conf["top_file"] = this.top;
        conf["dat_file"] = this.get_latest_dat();
        this.send(
            JSON.stringify(conf)
        );
    }

    // Abort the current run and start again from the latest configuration
    restart_simulation() {
        if (this.readyState === WebSocket.OPEN) {
            this.send("abort");
        }
        this.start_simulation();
    }

    update_forces(forces) {
        if (this.forces === forces) {
            console.log("Forces do not need to be updated");
            return;
        }
        this.forces = forces;
        // Restart from the latest configuration with the new forces
        this.restart_simulation();
    }

    // Continue the simulation from a given configuration (e.g. a dropped
    // dat file)
    load_dat(dat) {
        this.dat = dat;
        this.latestMessage = undefined;
        this.restart_simulation();
    }

    // Stop the server-side run before disconnecting
    shutdown() {
        this.stop_simulation();
        this.close();
    }
}

export const establishConnection = (system, top_file, dat_file, type) => {
    const url = "wss://nanobase.org:8989";
    return  new OXServeSocket(url, system, top_file, dat_file, type);
};
