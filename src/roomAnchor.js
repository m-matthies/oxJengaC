import * as THREE from "three";

// Keeps an object fixed in the room across headset recentering (e.g. when
// the headset is taken off and put back on) and, where supported, across
// sessions.
//
// The object's pose is tied to a WebXR anchor, which the runtime keeps
// attached to the real world. Every frame the object is moved to the
// anchor's current pose in the reference space. Where the browser can
// persist anchors (Quest Browser), the anchor's handle is saved in
// localStorage and restored at the next session start. Without anchor
// support, the reference space's reset event is used to undo recentering
// where the runtime reports how the origin moved.

const _resetMatrix = new THREE.Matrix4();
const _objectMatrix = new THREE.Matrix4();
const _scale = new THREE.Vector3();

function loadHandle(key) {
    try {
        return localStorage.getItem(key) || undefined;
    } catch {
        return undefined;
    }
}

function saveHandle(key, handle) {
    try {
        if (handle === undefined) {
            localStorage.removeItem(key);
        } else {
            localStorage.setItem(key, handle);
        }
    } catch {
        // Storage unavailable, the placement just won't survive the session
    }
}

export class RoomAnchor {
    constructor(object, storageKey = "oxjenga-anchor") {
        this.object = object;
        this.storageKey = storageKey;
        this.session = undefined;
        this.anchor = undefined;
        this.handle = undefined;
        // Anchor the object's current pose on the next frame
        this.placementRequested = false;
        // Incremented per placement, so a slow createAnchor that has been
        // overtaken by a newer one is dropped
        this.placementId = 0;
        // Set while the object is being moved by hand, so that the anchor
        // does not pull it back
        this.holding = false;
        // Set from a placement request until its anchor exists, so that the
        // old anchor does not pull the object back in the meantime
        this.pending = false;
        this.onReset = (event) => this._onReset(event);
    }

    onSessionStart(session, referenceSpace) {
        this.session = session;
        this.referenceSpace = referenceSpace;
        referenceSpace.addEventListener("reset", this.onReset);

        const handle = loadHandle(this.storageKey);
        if (handle !== undefined &&
            typeof session.restorePersistentAnchor === "function") {
            const id = ++this.placementId;
            session.restorePersistentAnchor(handle).then(anchor => {
                if (id !== this.placementId || session !== this.session) {
                    anchor.delete();
                    return;
                }
                this.anchor = anchor;
                this.handle = handle;
                console.log("Restored the structure's room anchor");
            }).catch(error => {
                console.warn("Could not restore the room anchor", error);
                saveHandle(this.storageKey, undefined);
                this.requestPlacement();
            });
        } else {
            this.requestPlacement();
        }
    }

    onSessionEnd() {
        if (this.referenceSpace !== undefined) {
            this.referenceSpace.removeEventListener("reset", this.onReset);
        }
        // Anchors die with their session; the persisted handle stays
        this.session = undefined;
        this.referenceSpace = undefined;
        this.anchor = undefined;
        this.handle = undefined;
        this.placementRequested = false;
        this.pending = false;
        this.placementId++;
    }

    // Anchor the object where it is now (call after moving it)
    requestPlacement() {
        this.placementRequested = true;
        this.pending = true;
    }

    // Call every XR frame, before rendering
    update(frame, referenceSpace) {
        if (frame === undefined || this.session === undefined) {
            return;
        }
        if (this.placementRequested) {
            this.placementRequested = false;
            this._place(frame, referenceSpace);
        }
        if (this.anchor !== undefined && !this.holding && !this.pending) {
            const pose = frame.getPose(this.anchor.anchorSpace, referenceSpace);
            // No pose while tracking is lost: stay where we are
            if (pose) {
                const p = pose.transform.position;
                const o = pose.transform.orientation;
                this.object.position.set(p.x, p.y, p.z);
                this.object.quaternion.set(o.x, o.y, o.z, o.w);
            }
        }
    }

    _place(frame, referenceSpace) {
        if (typeof frame.createAnchor !== "function") {
            return;
        }
        const id = ++this.placementId;
        const session = this.session;
        const p = this.object.position;
        const q = this.object.quaternion;
        frame.createAnchor(
            new XRRigidTransform(
                {x: p.x, y: p.y, z: p.z},
                {x: q.x, y: q.y, z: q.z, w: q.w}
            ),
            referenceSpace
        ).then(anchor => {
            if (id !== this.placementId || session !== this.session) {
                anchor.delete();
                return;
            }
            this._replace(anchor);
        }).catch(error => {
            console.warn("Could not create a room anchor", error);
        });
    }

    _replace(anchor) {
        const oldAnchor = this.anchor;
        const oldHandle = this.handle;
        this.anchor = anchor;
        this.handle = undefined;
        this.pending = false;
        if (oldAnchor !== undefined) {
            oldAnchor.delete();
        }
        const session = this.session;
        if (oldHandle !== undefined &&
            typeof session.deletePersistentAnchor === "function") {
            session.deletePersistentAnchor(oldHandle).catch(() => {});
        }
        if (typeof anchor.requestPersistentHandle === "function") {
            anchor.requestPersistentHandle().then(handle => {
                if (this.anchor === anchor) {
                    this.handle = handle;
                    saveHandle(this.storageKey, handle);
                }
            }).catch(error => {
                console.warn("Could not persist the room anchor", error);
            });
        }
    }

    // Fallback without anchors: the reference space origin moved (e.g.
    // recentering), so move the object by the inverse to keep it in place
    _onReset(event) {
        if (this.anchor !== undefined || !event.transform) {
            return;
        }
        // event.transform is the new origin in the old coordinates
        _resetMatrix.fromArray(event.transform.inverse.matrix);
        this.object.updateMatrix();
        _objectMatrix.multiplyMatrices(_resetMatrix, this.object.matrix);
        _objectMatrix.decompose(this.object.position, this.object.quaternion, _scale);
    }
}
