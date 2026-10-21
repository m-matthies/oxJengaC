import * as THREE from "three";

// Helpers for tracked hands (WebXR hand input). Joint positions are read
// from the hand groups three.js keeps up to date (renderer.xr.getHand(i));
// those groups sit at the scene root, so joint positions are world space.

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

// The position of a tracked joint, or undefined if it is not tracked
export function jointPosition(hand, name) {
    const joint = hand.joints[name];
    return joint !== undefined && joint.visible ? joint.position : undefined;
}

// Midpoint between the thumb and index finger tips
export function pinchPoint(hand, out) {
    const index = jointPosition(hand, "index-finger-tip");
    const thumb = jointPosition(hand, "thumb-tip");
    if (index === undefined || thumb === undefined) {
        return undefined;
    }
    return out.addVectors(index, thumb).multiplyScalar(0.5);
}

// A frame to carry things with: at the pinch point, rotated with the wrist
export function handGrabMatrix(hand, out) {
    const wrist = hand.joints["wrist"];
    if (wrist === undefined || !wrist.visible || pinchPoint(hand, _a) === undefined) {
        return undefined;
    }
    return out.compose(_a, wrist.quaternion, _b.set(1, 1, 1));
}

// Centre of the palm and the direction it faces (out of the palm). The palm
// spans from the base of the metacarpals (near the wrist) to the knuckles
// (the "phalanx-proximal" joints), so its centre is halfway along the middle
// finger's metacarpal. Computed from joint positions, so it does not depend
// on joint axis conventions.
function palm(hand, handedness, center, normal) {
    const wrist = jointPosition(hand, "wrist");
    const indexKnuckle = jointPosition(hand, "index-finger-phalanx-proximal");
    const pinkyKnuckle = jointPosition(hand, "pinky-finger-phalanx-proximal");
    const middleBase = jointPosition(hand, "middle-finger-metacarpal");
    const middleKnuckle = jointPosition(hand, "middle-finger-phalanx-proximal");
    if (!wrist || !indexKnuckle || !pinkyKnuckle || !middleBase || !middleKnuckle) {
        return false;
    }
    _a.subVectors(indexKnuckle, wrist);
    _b.subVectors(pinkyKnuckle, wrist);
    // index x pinky points out of the palm of a right hand, mirrored for a
    // left one
    if (handedness === "left") {
        normal.crossVectors(_b, _a);
    } else {
        normal.crossVectors(_a, _b);
    }
    normal.normalize();
    center.addVectors(middleBase, middleKnuckle).multiplyScalar(0.5);
    return true;
}

// How directly a palm must face the viewer (cosine of the angle)
const PALM_FACING = 0.6;
const _center = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _toViewer = new THREE.Vector3();

// Whether a hand's palm faces the viewer, as in Quest's system menu gesture
// (looking at the palm and pinching)
export function palmFacesViewer(hand, handedness, viewerPosition) {
    if (!palm(hand, handedness, _center, _normal)) {
        return false;
    }
    _toViewer.subVectors(viewerPosition, _center).normalize();
    return _normal.dot(_toViewer) > PALM_FACING;
}

// Joint positions are at the centre of the bones, inside the hand. The
// button is lifted out of the palm by the joint's tracked radius plus this
// margin (metres), and by at least PALM_MIN_LIFT.
const PALM_MARGIN = 0.01;
const PALM_MIN_LIFT = 0.02;
// The button is pressed when a tip comes this close (metres), and can be
// pressed again once the tip has been further than PALM_RELEASE away
const PALM_PRESS = 0.025;
const PALM_RELEASE = 0.05;

// A small "Menu" button that lies on the centre of a hand's palm while the
// palm faces the viewer, and is pressed by touching it with the other hand
export class PalmButton {
    constructor() {
        const canvas = document.createElement("canvas");
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#188DFF";
        ctx.beginPath();
        ctx.arc(64, 64, 60, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 34px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Menu", 64, 66);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;

        this.mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(0.04, 0.04),
            new THREE.MeshBasicMaterial({
                map: texture,
                transparent: true,
                side: THREE.DoubleSide,
                // Always drawn over the hand mesh, so it never disappears
                // into the palm
                depthTest: false
            })
        );
        this.mesh.renderOrder = 10;
        this.mesh.visible = false;
        this.pressed = false;
        this.normal = new THREE.Vector3();
    }

    // Show the button on the palm if it faces the viewer, and report
    // whether `tip` (a world position, or undefined) newly pressed it
    update(hand, handedness, viewerPosition, tip) {
        const center = this.mesh.position;
        let facing = false;
        if (palm(hand, handedness, center, this.normal)) {
            _toViewer.subVectors(viewerPosition, center).normalize();
            facing = this.normal.dot(_toViewer) > PALM_FACING;
        }
        this.mesh.visible = facing;
        if (!facing) {
            this.pressed = false;
            return false;
        }
        const joint = hand.joints["middle-finger-metacarpal"];
        const radius = joint.jointRadius === undefined ? 0 : joint.jointRadius;
        center.addScaledVector(this.normal, Math.max(PALM_MIN_LIFT, radius + PALM_MARGIN));
        // Lie flat on the palm (the plane faces along +Z), text upright
        this.mesh.lookAt(_toViewer.addVectors(center, this.normal));

        const distance = tip === undefined ? Infinity : tip.distanceTo(center);
        if (distance < PALM_PRESS && !this.pressed) {
            this.pressed = true;
            return true;
        }
        if (distance > PALM_RELEASE) {
            this.pressed = false;
        }
        return false;
    }
}
