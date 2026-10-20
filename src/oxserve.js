import { updateStrandsFromDat } from "./file.js";
import {dna_relax_scenario, rna_relax_scenario} from "./relax_scenarios.js";
export class OXServeSocket extends WebSocket{
    constructor(url, system, top, dat, onUpdate, type="DNA") {
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

        this.onopen = (resonse) => {
            console.log("connected to nanobase", resonse);
            this.abort = false;
            //this.start_simulation()
        };

        this.onerror = (resonse) => {
            console.log("WebSocket error: ", resonse);
        };

        this.onmessage = (response) => {
            if(!this.abort){ //ignore all incomming messages when we stop the simulation
                let message = JSON.parse(response.data);
                if ("console_log" in message){
                    console.log(message["console_log"]);
                }
                if ("dat_file" in message) {
                    onUpdate();
                    this.dat = message["dat_file"];
                    updateStrandsFromDat(message["dat_file"], system);
                }
            }
        };
        this.onclose = () => {
            console.log("lost oxServe Connection");
            this.abort = true;
        };
        this.top = top;
        this.dat = dat;

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
        let conf = {};
        conf["settings"] = this.relax_scenario;
        if (this.forces !== undefined) {
            conf["trap_file"] = this.forces;
        }
        conf["top_file"] = this.top;
        conf["dat_file"] = this.dat;
        this.send(
            JSON.stringify(conf)
        );
    }

    update_forces(forces) {
        if (this.forces === forces) {
            console.log("Forces do not need to be updated");
            return;
        }
        this.forces = forces;
        if (this.readyState === WebSocket.OPEN) {
            this.send("abort");
        }
        // Restart from the latest configuration with the new forces
        this.start_simulation();
    }
}
 
export const establishConnection = (system, top_file, dat_file, onUpdate, type) => {
    const url = "wss://nanobase.org:8989";
    return  new OXServeSocket(url, system, top_file, dat_file, onUpdate, type);
};