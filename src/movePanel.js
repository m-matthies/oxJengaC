import * as THREE from "three";

// The in-scene menu: a small floating window drawn on a canvas. Controllers
// click its buttons by pointing their ray at them and pulling the trigger;
// hands poke them with the index finger tip.

const WIDTH = 512;
const HEIGHT = 740;
// Size in metres
const PANEL_WIDTH = 0.22;
const PANEL_HEIGHT = PANEL_WIDTH * HEIGHT / WIDTH;

// Button rectangles in canvas pixels
const BUTTONS = {
    resetPosition: {label: "Reset position", x: 24, y: 120, w: 226, h: 70},
    resetStructure: {label: "Reset structure", x: 262, y: 120, w: 226, h: 70},
    stiffDown: {label: "−", x: 220, y: 210, w: 70, h: 70},
    stiffUp: {label: "+", x: 418, y: 210, w: 70, h: 70},
    designPrev: {label: "\u25C0", x: 24, y: 300, w: 70, h: 70},
    designNext: {label: "\u25B6", x: 418, y: 300, w: 70, h: 70},
    designLoad: {label: "Load structure", x: 24, y: 390, w: 226, h: 70},
    toggleBox: {label: "Hide box", x: 262, y: 390, w: 226, h: 70},
    simulation: {label: "Start simulation", x: 24, y: 480, w: 226, h: 70},
    reconnect: {label: "Reconnect", x: 262, y: 480, w: 226, h: 70},
    done: {label: "Done", x: 24, y: 570, w: 226, h: 70},
    exitXR: {label: "Exit XR", x: 262, y: 570, w: 226, h: 70}
};

// A poke is a press from the front (the side facing the viewer): the tip
// arms once it is over the panel at least POKE_ARM (metres) in front of it,
// and clicks when it then reaches POKE_PRESS from the surface (or crosses
// it within one frame) over a button. Leaving the panel's outline disarms
// it, and after a click it only arms again out in front, so jitter, sliding
// across buttons, coming in from the side or from behind never click.
const POKE_ARM = 0.015;
const POKE_PRESS = 0.003;
// Within this distance in front, the button under the tip is highlighted
const POKE_HOVER = 0.05;

const _raycaster = new THREE.Raycaster();
const _hits = [];
const _local = new THREE.Vector3();

function buttonAt(px, py) {
    for (const [name, b] of Object.entries(BUTTONS)) {
        if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
            return name;
        }
    }
    return undefined;
}

export class MovePanel {
    constructor() {
        this.canvas = document.createElement("canvas");
        this.canvas.width = WIDTH;
        this.canvas.height = HEIGHT;
        this.context = this.canvas.getContext("2d");
        this.texture = new THREE.CanvasTexture(this.canvas);
        this.texture.colorSpace = THREE.SRGBColorSpace;

        this.mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT),
            new THREE.MeshBasicMaterial({
                map: this.texture,
                transparent: true,
                side: THREE.DoubleSide
            })
        );
        this.mesh.visible = false;

        this.hovered = undefined;
        this.status = "";
        this.info = "";
        this.stiffness = 0;
        // The structure chosen with the arrows, and whether it is loaded
        this.design = "";
        this.designLoaded = false;
        this.connection = "";
        this.connectionColor = "#8f9aab";
        // Labels that differ from the defaults in BUTTONS
        this.labels = {};
        this.draw();
    }

    // Float above a controller, tilted towards the user
    attachTo(controller) {
        controller.add(this.mesh);
        this.mesh.position.set(0, 0.2, -0.08);
        this.mesh.rotation.set(-0.5, 0, 0);
    }

    // Stand in the room in front of the viewer (for hands, which have no
    // stable place to attach it to)
    placeInFront(scene, viewerPosition, viewerDirection) {
        scene.add(this.mesh);
        this.mesh.position.set(viewerDirection.x, 0, viewerDirection.z)
            .normalize().multiplyScalar(0.4).add(viewerPosition);
        this.mesh.position.y -= 0.15;
        this.mesh.rotation.set(0, 0, 0);
        this.mesh.lookAt(viewerPosition);
    }

    draw() {
        const ctx = this.context;
        ctx.clearRect(0, 0, WIDTH, HEIGHT);
        ctx.fillStyle = "rgba(20, 24, 32, 0.85)";
        ctx.beginPath();
        ctx.roundRect(0, 0, WIDTH, HEIGHT, 24);
        ctx.fill();

        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 38px sans-serif";
        ctx.fillText("Menu", WIDTH / 2, 42);
        ctx.font = "21px sans-serif";
        ctx.fillStyle = "#c8d0dc";
        ctx.fillText(
            this.status || "Trigger or pinch to grab and move the structure",
            WIDTH / 2, 88
        );

        ctx.textAlign = "left";
        ctx.font = "26px sans-serif";
        ctx.fillText("Pull stiffness", 28, 245);
        ctx.textAlign = "center";
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 32px sans-serif";
        ctx.fillText(this.stiffness.toFixed(2), 354, 245);
        ctx.font = "bold 28px sans-serif";
        ctx.fillStyle = this.designLoaded ? "#ffffff" : "#ffd27a";
        ctx.fillText(this.design, WIDTH / 2, 323);
        ctx.font = "19px sans-serif";
        ctx.fillStyle = "#8f9aab";
        ctx.fillText(this.designLoaded ? "loaded" : "not loaded", WIDTH / 2, 352);

        for (const [name, b] of Object.entries(BUTTONS)) {
            ctx.fillStyle = name === this.hovered ? "#188DFF" : "#3a4252";
            ctx.beginPath();
            ctx.roundRect(b.x, b.y, b.w, b.h, 16);
            ctx.fill();
            ctx.fillStyle = "#ffffff";
            const label = this.labels[name] ?? b.label;
            ctx.font = b.w <= 100 ? "bold 40px sans-serif" :
                label.length >= 15 ? "bold 25px sans-serif" : "bold 28px sans-serif";
            ctx.fillText(label, b.x + b.w / 2, b.y + b.h / 2);
        }
        ctx.fillStyle = "#8f9aab";
        ctx.font = "19px sans-serif";
        ctx.fillText(this.info, WIDTH / 2, 712);

        // Simulation state: a coloured dot and a few words
        ctx.font = "bold 24px sans-serif";
        const textWidth = ctx.measureText(this.connection).width;
        const left = (WIDTH - textWidth - 34) / 2;
        ctx.fillStyle = this.connectionColor;
        ctx.beginPath();
        ctx.arc(left + 12, 668, 12, 0, 2 * Math.PI);
        ctx.fill();
        ctx.textAlign = "left";
        ctx.fillStyle = "#ffffff";
        ctx.fillText(this.connection, left + 34, 669);
        this.texture.needsUpdate = true;
    }

    setLabel(name, label) {
        if (this.labels[name] !== label) {
            this.labels[name] = label;
            this.draw();
        }
    }

    // The structure shown between the arrows
    setDesign(design, loaded) {
        if (design !== this.design || loaded !== this.designLoaded) {
            this.design = design;
            this.designLoaded = loaded;
            this.draw();
        }
    }

    // The simulation connection state, e.g. ("Running", "#3ccf6e")
    setConnection(connection, color) {
        if (connection !== this.connection || color !== this.connectionColor) {
            this.connection = connection;
            this.connectionColor = color;
            this.draw();
        }
    }

    // A line of status information at the bottom
    setInfo(info) {
        if (info !== this.info) {
            this.info = info;
            this.draw();
        }
    }

    setHovered(name) {
        if (name !== this.hovered) {
            this.hovered = name;
            this.draw();
        }
    }

    setStatus(status) {
        if (status !== this.status) {
            this.status = status;
            this.draw();
        }
    }

    setStiffness(stiffness) {
        if (stiffness !== this.stiffness) {
            this.stiffness = stiffness;
            this.draw();
        }
    }

    // Find what a world space ray points at on the panel. Returns
    // undefined if it misses the panel, otherwise {button, distance}, where
    // button is the name of the button hit (or undefined between buttons).
    hitTest(ray) {
        if (!this.mesh.visible) {
            return undefined;
        }
        _raycaster.ray.copy(ray);
        _hits.length = 0;
        this.mesh.raycast(_raycaster, _hits);
        if (_hits.length === 0) {
            return undefined;
        }
        const hit = _hits[0];
        return {
            button: buttonAt(hit.uv.x * WIDTH, (1 - hit.uv.y) * HEIGHT),
            distance: hit.distance
        };
    }

    // Poke the panel with a tip (world position). `state` is an object kept
    // per tip ({armed, hovered}). Returns the name of a button when it is
    // pressed.
    poke(tip, state) {
        state.hovered = undefined;
        if (!this.mesh.visible) {
            state.armed = false;
            return undefined;
        }
        this.mesh.worldToLocal(_local.copy(tip));
        const z = _local.z;
        const inside =
            Math.abs(_local.x) <= PANEL_WIDTH / 2 &&
            Math.abs(_local.y) <= PANEL_HEIGHT / 2;
        if (!inside) {
            state.armed = false;
            return undefined;
        }
        // Over the panel, out in front: ready for the next press
        if (z >= POKE_ARM) {
            state.armed = true;
        }
        const button = buttonAt(
            (_local.x / PANEL_WIDTH + 0.5) * WIDTH,
            (0.5 - _local.y / PANEL_HEIGHT) * HEIGHT
        );
        if (z >= 0 && z <= POKE_HOVER) {
            state.hovered = button;
        }
        if (state.armed && z <= POKE_PRESS) {
            // Pressed in: no more clicks until the tip is back out in front
            state.armed = false;
            return button;
        }
        return undefined;
    }
}
