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

// How often persisting an anchor is retried after freeing old ones
const PERSIST_RETRIES = 2;

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
        // Persisted handles replaced by a newer placement. They are deleted
        // once the newer one has been saved, so that a failed save still
        // leaves the previous placement to restore.
        this.staleHandles = [];
        this.onReset = (event) => this._onReset(event);
        // Called with a short description whenever the anchor state changes
        this.onStatus = () => {};
        // Called with the viewer's pose (an XRRigidTransform) when there is
        // no saved placement to restore, to put the object somewhere
        // sensible before it is anchored there
        this.onInitialPose = () => {};
        this.needsInitialPose = false;
    }

    _setStatus(status) {
        this.status = status;
        this.onStatus(status);
    }

    onSessionStart(session, referenceSpace) {
        this.session = session;
        this.referenceSpace = referenceSpace;
        referenceSpace.addEventListener("reset", this.onReset);

        const canPersist = typeof session.restorePersistentAnchor === "function";
        // Anchors this site persisted earlier. Normally the one whose handle
        // is stored; if the stored handle got lost, the first one.
        const persisted = canPersist && session.persistentAnchors ?
            [...session.persistentAnchors] : [];
        let handle = loadHandle(this.storageKey);
        if (handle === undefined && persisted.length > 0) {
            handle = persisted[0];
        }
        // Drop any others, so they do not pile up against the limit
        if (canPersist) {
            this._deletePersistent(session, persisted.filter(other => other !== handle));
        }

        if (handle !== undefined && canPersist) {
            this._setStatus("restoring");
            const id = ++this.placementId;
            session.restorePersistentAnchor(handle).then(anchor => {
                if (id !== this.placementId || session !== this.session) {
                    anchor.delete();
                    // Superseded by a placement in this session: delete the
                    // handle once that placement is saved (right away if it
                    // already is)
                    if (session === this.session) {
                        if (this.handle !== undefined) {
                            this._deletePersistent(session, [handle]);
                        } else {
                            this.staleHandles.push(handle);
                        }
                    }
                    return;
                }
                this.anchor = anchor;
                this.handle = handle;
                saveHandle(this.storageKey, handle);
                this._setStatus("restored");
                console.log("Restored the structure's room anchor");
            }).catch(error => {
                console.warn("Could not restore the room anchor", error);
                saveHandle(this.storageKey, undefined);
                this._deletePersistent(session, [handle]);
                this.needsInitialPose = true;
            });
        } else {
            this.needsInitialPose = true;
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
        this.needsInitialPose = false;
        this.pending = false;
        this.placementId++;
        this.staleHandles.length = 0;
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
        if (this.needsInitialPose) {
            const viewer = frame.getViewerPose(referenceSpace);
            if (viewer) {
                this.needsInitialPose = false;
                this.onInitialPose(viewer.transform);
                this.requestPlacement();
            }
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
            this._setStatus("not supported");
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
            this._setStatus("failed");
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
        if (oldHandle !== undefined) {
            this.staleHandles.push(oldHandle);
        }
        if (typeof anchor.requestPersistentHandle === "function") {
            this._setStatus("placed");
            this._persist(anchor, PERSIST_RETRIES);
        } else {
            this._setStatus("placed, not saved (unsupported)");
        }
    }

    // Persist an anchor and store its handle, so the next session can
    // restore it. Quest allows a site only a few persistent anchors (8), so
    // if persisting fails, all others are deleted and it is retried.
    _persist(anchor, retries) {
        const session = this.session;
        anchor.requestPersistentHandle().then(handle => {
            if (this.anchor !== anchor || session !== this.session) {
                // Replaced while persisting: don't leave it behind
                this._deletePersistent(session, [handle]);
                return;
            }
            this.handle = handle;
            saveHandle(this.storageKey, handle);
            this._setStatus("saved");
            // Only now that the new placement is saved, drop the old ones
            this._deletePersistent(session, this.staleHandles.splice(0));
        }).catch(error => {
            console.warn("Could not persist the room anchor", error);
            if (this.anchor !== anchor || session !== this.session) {
                return;
            }
            if (retries > 0) {
                this._setStatus("saving (retry)");
                const others = session.persistentAnchors ?
                    [...session.persistentAnchors] : [];
                this._deletePersistent(session, others).then(() => {
                    setTimeout(() => this._persist(anchor, retries - 1), 1000);
                });
            } else {
                const reason = String((error && error.message) || error).slice(0, 40);
                this._setStatus(`not saved: ${reason}`);
            }
        });
    }

    _deletePersistent(session, handles) {
        if (session === undefined ||
            typeof session.deletePersistentAnchor !== "function") {
            return Promise.resolve();
        }
        return Promise.all(handles.map(
            handle => session.deletePersistentAnchor(handle).catch(() => {})
        ));
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
