import * as THREE from "three";

// A small floating window, shown next to the left controller while the
// structure is being moved. It is drawn on a canvas and its buttons are
// clicked by pointing a controller ray at them.

const WIDTH = 512;
const HEIGHT = 256;
// Size in metres
const PANEL_WIDTH = 0.2;
const PANEL_HEIGHT = PANEL_WIDTH * HEIGHT / WIDTH;

// Button rectangles in canvas pixels
const BUTTONS = {
    reset: {label: "Reset", x: 40, y: 160, w: 200, h: 70},
    done: {label: "Done", x: 272, y: 160, w: 200, h: 70}
};

const _raycaster = new THREE.Raycaster();
const _hits = [];

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
        // Float above the controller, tilted towards the user
        this.mesh.position.set(0, 0.1, -0.08);
        this.mesh.rotation.x = -0.5;
        this.mesh.visible = false;

        this.hovered = undefined;
        this.status = "";
        this.draw();
    }

    draw() {
        const ctx = this.context;
        ctx.clearRect(0, 0, WIDTH, HEIGHT);
        ctx.fillStyle = "rgba(20, 24, 32, 0.85)";
        ctx.beginPath();
        ctx.roundRect(0, 0, WIDTH, HEIGHT, 24);
        ctx.fill();

        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "bold 40px sans-serif";
        ctx.fillText("Move structure", WIDTH / 2, 45);
        ctx.font = "26px sans-serif";
        ctx.fillStyle = "#c8d0dc";
        ctx.fillText(
            this.status || "Hold the trigger to grab, release to place",
            WIDTH / 2, 105
        );

        for (const [name, b] of Object.entries(BUTTONS)) {
            ctx.fillStyle = name === this.hovered ? "#188DFF" : "#3a4252";
            ctx.beginPath();
            ctx.roundRect(b.x, b.y, b.w, b.h, 16);
            ctx.fill();
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 34px sans-serif";
            ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2);
        }
        this.texture.needsUpdate = true;
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
        const px = hit.uv.x * WIDTH;
        const py = (1 - hit.uv.y) * HEIGHT;
        let button;
        for (const [name, b] of Object.entries(BUTTONS)) {
            if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
                button = name;
            }
        }
        return {button, distance: hit.distance};
    }
}
