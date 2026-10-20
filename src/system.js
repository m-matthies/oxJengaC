import * as THREE from "three";
import { monomerGeometry, monomerMaterial, strandColors } from "./constants.js";
import { parseDatTargets } from "./datParser.js";

// Overestimate the time to the next frame, so that the interpolation rarely
// stalls before the next frame arrives. oxServe frames come irregularly
// (0.8-5.7 s apart for flippy, about 1.5 s on average). Replaying such
// arrivals, beads stand still 30% of the time at 1.2x and 17% at 2x,
// while reaching a frame takes 1.8 s and 2.9 s.
const LERP_OVERSHOOT = 2;
// Clamp interval samples to this multiple of the current estimate, so that
// gaps (e.g. simulation restarts) do not dominate, while a too small
// estimate still grows back geometrically
const MAX_INTERVAL_JUMP = 3;
// Lower bound (ms) used for the clamp, so an estimate of 0 can recover
const MIN_FRAME_INTERVAL = 1;
// Factor applied to the colour of a highlighted instance
const HIGHLIGHT_FACTOR = 1 / 3;

// Reused scratch objects, so that no allocations happen per frame
const _inverseMatrix = new THREE.Matrix4();
const _localRay = new THREE.Ray();

class System {
    constructor(box) {
        this.box = box;
        this.strands = [];
        this.elements = new Map();
        // Elements in oxDNA order, see assignIndices()
        this.monomersByIndex = [];
    }

    getSize() {
        return this.elements.size;
    }

    getCenterOfMass() {
        const v = new THREE.Vector3();
        for (const m of this.elements.values()) {
            v.add(m.position);
        }
        return v.divideScalar(this.getSize());
    }

    placeInBox() {
        const origin = this.box.clone().divideScalar(2);
        const centreOfMass = this.getCenterOfMass();

        for (const m of this.elements.values()) {
            m.position.sub(centreOfMass).add(origin);
        }
    }

    // Give each element a dense index in oxDNA order: strand by strand,
    // each strand 3'->5' (the reverse of oxView's 5'->3' order). This is
    // the line in the top/dat files, the particle index of oxDNA forces
    // and the instance index of the mesh. Element ids from the oxView file
    // can be sparse and in any order, so they are never used as indices.
    assignIndices() {
        this.monomersByIndex = [];
        for (const strand of this.strands) {
            for (let i = strand.monomers.length - 1; i >= 0; i--) {
                const m = strand.monomers[i];
                m.index = this.monomersByIndex.length;
                this.monomersByIndex.push(m);
            }
        }
    }

    // Build the instanced mesh and the typed arrays used for interpolation.
    // The instance index is the element index (see assignIndices()), the
    // displayed positions live directly in the translation part of the
    // instance matrices, and `targets` holds the backbone positions of the
    // latest frame.
    createViewMesh() {
        const count = this.monomersByIndex.length;
        this.instancedMesh = new THREE.InstancedMesh(
            monomerGeometry,
            monomerMaterial,
            count
        );
        this.instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.instancedMesh.castShadow = true;
        this.instancedMesh.receiveShadow = true;

        this.targets = new Float32Array(3 * count);
        // Per-element backbone offsets along a1 and a2
        this.backboneOffsets = new Float32Array(2 * count);
        this.beadRadius = monomerGeometry.parameters.radius;

        // Matrices start as identity, so only the translation is written
        const matrices = this.instancedMesh.instanceMatrix.array;
        const p = new THREE.Vector3();
        const strandColorsLen = strandColors.length;
        for (const m of this.monomersByIndex) {
            const i = m.index;
            m.getBackbonePos(p);
            p.toArray(matrices, 16 * i + 12);
            p.toArray(this.targets, 3 * i);
            const [a1Offset, a2Offset] = m.getBackboneOffset();
            this.backboneOffsets[2 * i] = a1Offset;
            this.backboneOffsets[2 * i + 1] = a2Offset;
            this.instancedMesh.setColorAt(
                i, strandColors[m.strand.id % strandColorsLen]
            );
        }
        this.baseColors = this.instancedMesh.instanceColor.array.slice();
        // Number of controllers (or other sources) highlighting each bead
        this.highlightCounts = new Uint8Array(count);
        this.instancedMesh.boundingSphere = new THREE.Sphere();
        this._updateBounds();

        this.interpolating = false;
        this.frameInterval = undefined;
        this.lastFrameTime = undefined;
    }

    // Parse an oxDNA configuration and set it as the new interpolation
    // target. Line k of the configuration maps to the element with index k.
    // Used for dropped files; streamed frames are parsed in a worker and
    // arrive through setTargets().
    // Returns false (and changes nothing) if the configuration is incomplete
    // or does not belong to this system.
    setTargetsFromDat(datText, now = performance.now()) {
        if (this._parsedTargets === undefined) {
            this._parsedTargets = new Float32Array(this.targets.length);
        }
        const count = this.targets.length / 3;
        if (parseDatTargets(datText, this.backboneOffsets, this._parsedTargets) !== count) {
            return false;
        }
        this.setTargets(this._parsedTargets, now);
        return true;
    }

    // Set new interpolation targets (backbone positions, 3 per element
    // index) that were already parsed, e.g. by the worker
    setTargets(targets, now = performance.now()) {
        this.targets.set(targets);
        this._startInterpolation(now);
    }

    // Forget when the last frame arrived, e.g. when the simulation is
    // restarted, so that the gap until the new run's first frame is not
    // taken as a frame interval (the estimate itself is kept)
    resetFrameTiming() {
        this.lastFrameTime = undefined;
    }

    _startInterpolation(now) {
        // Estimate how long until the next frame (moving average)
        if (this.lastFrameTime !== undefined) {
            const dt = now - this.lastFrameTime;
            if (this.frameInterval === undefined) {
                this.frameInterval = dt;
            } else {
                const maxDt = MAX_INTERVAL_JUMP *
                    Math.max(this.frameInterval, MIN_FRAME_INTERVAL);
                this.frameInterval = 0.8 * this.frameInterval +
                    0.2 * Math.min(dt, maxDt);
            }
        }
        this.lastFrameTime = now;
        this.lastViewTime = now;
        this.lerpEnd = now + LERP_OVERSHOOT * (this.frameInterval || 0);
        this.interpolating = true;
        // Linear interpolation stays within the bounds of the current and
        // target positions, so the bounds only change once per frame
        this._updateBounds();
    }

    // Move the displayed positions linearly (in time) toward the targets.
    // Returns false if nothing needed to be updated.
    updateView(now = performance.now()) {
        if (!this.interpolating) {
            return false;
        }

        // Fraction of the remaining distance to cover this frame
        let f = 1;
        if (now < this.lerpEnd) {
            f = (now - this.lastViewTime) / (this.lerpEnd - this.lastViewTime);
        }
        this.lastViewTime = now;

        const m = this.instancedMesh.instanceMatrix.array;
        const t = this.targets;
        for (let i = 0, n = this.monomersByIndex.length; i < n; i++) {
            const o = 16 * i + 12;
            const k = 3 * i;
            m[o]     += (t[k]     - m[o])     * f;
            m[o + 1] += (t[k + 1] - m[o + 1]) * f;
            m[o + 2] += (t[k + 2] - m[o + 2]) * f;
        }
        this.instancedMesh.instanceMatrix.needsUpdate = true;

        if (f >= 1) {
            this.interpolating = false;
        }
        return true;
    }

    // Fit the bounding sphere (used for frustum culling and picking) around
    // both the displayed and the target positions of the beads
    _updateBounds() {
        const m = this.instancedMesh.instanceMatrix.array;
        const t = this.targets;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0, n = this.monomersByIndex.length; i < n; i++) {
            const o = 16 * i + 12;
            const k = 3 * i;
            const x = m[o], y = m[o + 1], z = m[o + 2];
            const tx = t[k], ty = t[k + 1], tz = t[k + 2];
            // A single non-finite value would make the sphere NaN, and the
            // whole structure would be culled
            if (!Number.isFinite(x + y + z + tx + ty + tz)) {
                continue;
            }
            minX = Math.min(minX, x, tx);
            maxX = Math.max(maxX, x, tx);
            minY = Math.min(minY, y, ty);
            maxY = Math.max(maxY, y, ty);
            minZ = Math.min(minZ, z, tz);
            maxZ = Math.max(maxZ, z, tz);
        }
        const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
        const sphere = this.instancedMesh.boundingSphere;
        sphere.center.set(
            (minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2
        );
        sphere.radius = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2 +
            this.beadRadius;
    }

    // Get the displayed position of an element (by index), in mesh-local
    // coordinates
    getDisplayedPosition(index, v = new THREE.Vector3()) {
        return v.fromArray(this.instancedMesh.instanceMatrix.array, 16 * index + 12);
    }

    // Latest simulated backbone position of an element
    getTargetPosition(index, v = new THREE.Vector3()) {
        return v.fromArray(this.targets, 3 * index);
    }

    // The element whose displayed position is closest to `point` (oxDNA
    // coordinates), if one lies within `maxDistance`. Used for direct
    // selection with tracked hands.
    nearestDisplayed(point, maxDistance) {
        // Nowhere near the structure: skip the scan (the bounding sphere
        // covers all beads, current and target positions)
        const sphere = this.instancedMesh.boundingSphere;
        if (point.distanceTo(sphere.center) > sphere.radius + maxDistance) {
            return undefined;
        }
        const m = this.instancedMesh.instanceMatrix.array;
        let best;
        let bestD2 = maxDistance * maxDistance;
        for (let i = 0, j = 12, n = this.monomersByIndex.length; i < n; i++, j += 16) {
            const dx = m[j] - point.x;
            const dy = m[j + 1] - point.y;
            const dz = m[j + 2] - point.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= bestD2) {
                bestD2 = d2;
                best = i;
            }
        }
        return best;
    }

    // Indices of all elements whose latest simulated backbone position lies
    // within `radius` of `center` (both in oxDNA coordinates)
    getIndicesWithin(center, radius) {
        const t = this.targets;
        const r2 = radius * radius;
        const indices = [];
        for (let i = 0, j = 0, n = t.length / 3; i < n; i++, j += 3) {
            const dx = t[j] - center.x;
            const dy = t[j + 1] - center.y;
            const dz = t[j + 2] - center.z;
            if (dx * dx + dy * dy + dz * dz <= r2) {
                indices.push(i);
            }
        }
        return indices;
    }

    // Find the closest bead hit by a world-space ray. This is an analytical
    // ray-sphere test against the bead centres, much cheaper than the
    // per-instance triangle raycast of THREE.InstancedMesh. Returns the hit
    // element index and world-space distance in `out`, or undefined if
    // nothing was hit.
    pick(worldRay, out = {}) {
        const mesh = this.instancedMesh;
        _inverseMatrix.copy(mesh.matrixWorld).invert();
        _localRay.copy(worldRay).applyMatrix4(_inverseMatrix);

        if (!_localRay.intersectsSphere(mesh.boundingSphere)) {
            return undefined;
        }

        const m = mesh.instanceMatrix.array;
        const r2 = this.beadRadius * this.beadRadius;
        const {x: ox, y: oy, z: oz} = _localRay.origin;
        const {x: dx, y: dy, z: dz} = _localRay.direction;
        let bestT = Infinity;
        let bestIndex = -1;
        for (let i = 0, n = this.monomersByIndex.length; i < n; i++) {
            const o = 16 * i + 12;
            const cx = m[o] - ox, cy = m[o + 1] - oy, cz = m[o + 2] - oz;
            const tca = cx * dx + cy * dy + cz * dz;
            if (tca < 0) continue;
            const d2 = cx * cx + cy * cy + cz * cz - tca * tca;
            if (d2 > r2) continue;
            const t = Math.max(0, tca - Math.sqrt(r2 - d2));
            if (t < bestT) {
                bestT = t;
                bestIndex = i;
            }
        }
        if (bestIndex < 0) {
            return undefined;
        }

        // Convert the hit distance to world units
        const hit = _localRay.at(bestT, out.point || new THREE.Vector3());
        mesh.localToWorld(hit);
        out.point = hit;
        out.index = bestIndex;
        out.distance = hit.distanceTo(worldRay.origin);
        return out;
    }

    // Add (or remove) one highlight of a bead. A bead stays darkened while
    // any source highlights it. Only that instance's colour is uploaded.
    setHighlighted(index, highlighted) {
        const counts = this.highlightCounts;
        const wasHighlighted = counts[index] > 0;
        if (highlighted) {
            counts[index]++;
        } else if (counts[index] > 0) {
            counts[index]--;
        }
        const isHighlighted = counts[index] > 0;
        if (isHighlighted === wasHighlighted) {
            return;
        }

        const colors = this.instancedMesh.instanceColor;
        const factor = isHighlighted ? HIGHLIGHT_FACTOR : 1;
        for (let c = 0; c < 3; c++) {
            colors.array[3 * index + c] = this.baseColors[3 * index + c] * factor;
        }
        colors.addUpdateRange(3 * index, 3);
        colors.needsUpdate = true;
    }

    dispose() {
        if (this.instancedMesh !== undefined) {
            this.instancedMesh.removeFromParent();
            this.instancedMesh.dispose();
        }
    }
}

class Strand {
    constructor(system, id) {
        this.system = system;
        this.id = id;
        this.monomers = [];
    }
}

class Monomer {
    constructor(id, type, strand, position, a1, a3) {
        this.id = id;
        this.type = type;
        this.strand = strand;
        this.position = position;
        this.a1 = a1;
        this.a3 = a3;
        this.a2 = a1.clone().cross(a3);
        this.strand.system.elements.set(this.id, this);
    }

    // The backbone is offset from the centre along a1 and a2
    getBackbonePos(v = new THREE.Vector3()) {
        const [a1Offset, a2Offset] = this.getBackboneOffset();
        return v.copy(this.position)
            .addScaledVector(this.a1, -a1Offset)
            .addScaledVector(this.a2, -a2Offset);
    }

    getBackboneOffset() {
        throw "Abstract method getBackboneOffset() not implemented";
    }
}

const DNA_BACKBONE_OFFSET = [0.34, 0.3408];
const RNA_BACKBONE_OFFSET = [0.4, 0.2];
const AA_BACKBONE_OFFSET = [0, 0];

class DNAMonomer extends Monomer {
    getBackboneOffset() {
        return DNA_BACKBONE_OFFSET;
    }

    getCategory() {
        return "DNA";
    }
}

class RNAMonomer extends Monomer {
    getBackboneOffset() {
        return RNA_BACKBONE_OFFSET;
    }

    getCategory() {
        return "RNA";
    }
}

class AminoAcidMonomer extends Monomer {
    getBackboneOffset() {
        return AA_BACKBONE_OFFSET;
    }

    getCategory() {
        return "AA";
    }
}

export {System, Strand, DNAMonomer, RNAMonomer, AminoAcidMonomer};
