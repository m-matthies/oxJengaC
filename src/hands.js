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
