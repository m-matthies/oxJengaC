import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { XRButton } from "three/addons/webxr/XRButton.js";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
import { XRHandModelFactory } from "three/addons/webxr/XRHandModelFactory.js";
import {
    makeDatFile,
    makeFileDropable,
    makeTopFile,
    updateStrandsFromDat
} from "./src/file.js";

import { XREstimatedLight } from "three/addons/webxr/XREstimatedLight.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { establishConnection } from "./src/oxserve.js";

import { drawBox, drawCone, positionCone } from "./src/utils.js";
import { MovePanel } from "./src/movePanel.js";
import { RoomAnchor } from "./src/roomAnchor.js";
import { readPositions } from "./src/datParser.js";
import {
    handGrabMatrix, jointPosition, pinchPoint
} from "./src/hands.js";

import {
    DNAMonomer, RNAMonomer, AminoAcidMonomer,
    Strand, System
} from "./src/system.js";

// Pulls act on every bead within this radius of the picked one, in oxDNA
// length units (1 unit = 0.8518 nm). About the radius of a six-helix bundle.
const PULL_RADIUS = 5.2;
// Total trap stiffness of one pull, shared evenly by all of its beads, so
// the region is pulled gently as a whole. It is chosen in the menu from
// these steps and remembered per browser.
const STIFFNESS_STEPS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.45, 0.6, 0.8, 1.0];
const DEFAULT_STIFFNESS = 0.15;
const STIFFNESS_KEY = "oxjenga-stiffness";
// A hand's pinch selects the nearest bead within this distance (metres) of
// the pinch point (hands have no pointing ray)
const HAND_REACH = 0.03;

// A stored setting, or null if there is none or storage is unavailable
function loadSetting(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function loadStiffness() {
    const value = parseFloat(loadSetting(STIFFNESS_KEY));
    return STIFFNESS_STEPS.includes(value) ? value : DEFAULT_STIFFNESS;
}

function saveSetting(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Storage unavailable, the choice lasts until reload
    }
}

let pullStiffness = loadStiffness();
// Set when the stiffness was changed while the menu is open
let stiffnessChanged = false;

// Whether the simulation box (and axes) are shown, chosen in the menu
const BOX_KEY = "oxjenga-show-box";
let boxVisible = loadSetting(BOX_KEY) !== "0";
let boxHelpers = [];

// The structures that can be loaded from the menu (files in
// public/resources/, and the name shown)
const DESIGNS = [
    {file: "flappy.oxview", name: "flappy"},
    {file: "flippy_turned.oxview", name: "flippy"},
    {file: "monohole_1b.oxview", name: "monohole"}
];
// Renamed when the default changes, so that the new default is loaded once
// even where an older choice was stored
const DESIGN_KEY = "oxjenga-design-2";
// The structure shown in the menu, and the one actually loaded. Starts
// with the one loaded last time.
let selectedDesign = Math.max(
    0, DESIGNS.findIndex(d => d.file === loadSetting(DESIGN_KEY))
);
let loadedDesign;
// Incremented per load, so only the latest requested design is shown
let designLoadId = 0;

const designName = (i) => DESIGNS[i].name;

function updateDesignMenu() {
    movePanel.setDesign(designName(selectedDesign), selectedDesign === loadedDesign);
}

// Fetch and show a design (and simulate it, if the simulation is on). The
// current one stays until the new one has been parsed.
function loadDesign(index) {
    const id = ++designLoadId;
    const name = designName(index);
    console.log(`Loading ${DESIGNS[index].file}`);
    if (movePanel !== undefined) {
        movePanel.setStatus(`Loading ${name}\u2026`);
    }
    fetch(import.meta.env.BASE_URL + "resources/" + DESIGNS[index].file).then(resp => {
        if (!resp.ok) {
            throw new Error(`${resp.status} ${resp.statusText}`);
        }
        return resp.text();
    }).then(text => {
        if (id !== designLoadId) {
            return;
        }
        initSceneFromJSON(text);
        loadedDesign = index;
        saveSetting(DESIGN_KEY, DESIGNS[index].file);
        movePanel.setStatus("");
        updateDesignMenu();
    }).catch(error => {
        console.error(`Could not load ${DESIGNS[index].file}`, error);
        if (id === designLoadId) {
            movePanel.setStatus(`Could not load ${name}`);
        }
    });
}

// Gamepad buttons of the left controller that open the move window: X and
// Y, plus anything after the thumbrest (where some runtimes report the
// menu button)
const isMenuButton = (i) => i === 4 || i === 5 || i >= 7;
// Minimum time (ms) between two toggles of the menu, so that one press (or
// the system's own report of the hand gesture) toggles it once
const MENU_TOGGLE_COOLDOWN = 350;
let lastMenuToggle = -Infinity;
// Minimum time (ms) between two pokes of one fingertip
const POKE_COOLDOWN = 250;

// Reused scratch objects for controller picking and cone updates
const _ray = new THREE.Ray();
const _hit = {};
const _rotation = new THREE.Matrix4();
const _beadPos = new THREE.Vector3();
const _targetPos = new THREE.Vector3();
const _grabMatrix = new THREE.Matrix4();
const _grabScale = new THREE.Vector3();
const _trapPos = new THREE.Vector3();
const _pinch = new THREE.Vector3();
const _pinchLocal = new THREE.Vector3();
const _head = new THREE.Vector3();
// Where the "Starting simulation" label floats, relative to the structure
const LABEL_OFFSET = new THREE.Vector3(0, 0.8, 0);
const _headDir = new THREE.Vector3();
const _placeDir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _viewerRotation = new THREE.Quaternion();
// Where a structure is first put: this far (metres) beyond its own radius
// in front of the viewer, and this far below eye level
const VIEWER_CLEARANCE = 0.75;
const BELOW_EYE_LEVEL = 0.2;

// Direction of the key light from the structure
const KEY_LIGHT_OFFSET = new THREE.Vector3(1, 3, 2);

// The world space ray a controller points along
function controllerRay(controller) {
    _rotation.identity().extractRotation(controller.matrixWorld);
    _ray.origin.setFromMatrixPosition(controller.matrixWorld);
    _ray.direction.set(0, 0, -1).applyMatrix4(_rotation);
    return _ray;
}

// Find the bead the controller is pointing at
function pickFromController(controller) {
    return system.pick(controllerRay(controller), _hit);
}

// One oxDNA trap force block
function trapBlock(particle, pos0, stiff) {
    return `
        {
        type = trap
        particle = ${particle}
        pos0 = ${pos0.toArray().map(v => v.toFixed(3)).join(", ")}
        stiff = ${stiff}
        rate = 0.
        dir = 1.,0.,0.
        }
         `;
}

function onSelectStart(event) {
    const controller = event.target;

    if (moveMode) {
        onMoveSelectStart(controller);
        return;
    }

    // Do not select things if there is no system
    if (system === undefined) {
        return;
    }

    // Hands only grab what they touch: a pinch right at the structure
    // grabs that region. It is dragged until the pinch opens and then
    // pulled toward that point (one simulation restart per gesture).
    if (isHand(controller)) {
        // Fingertips not tracked: neither a grab nor an empty-space pinch
        if (pinchPoint(controller.userData.hand, _pinch) === undefined) {
            return;
        }
        const direct = directPick(controller);
        if (direct !== undefined) {
            controller.userData.selected = direct;
            controller.userData.drag = direct;
            controller.userData.cone.visible = true;
        } else {
            releasePull(controller);
        }
        return;
    }

    const hit = pickFromController(controller);
    if (hit === undefined) {
        // Pointing at nothing releases this controller's pull
        releasePull(controller);
        return;
    }

    controller.userData.selected = hit.index;

    // Pull toward where the controller (or pinch) is now. The pull stays
    // until the controller selects empty space (or another region).
    startPull(controller, hit.index, inputPosition(controller).clone());
    sendForces();
}

// Stop a controller's (or hand's) pull, if it has one
function releasePull(controller) {
    if (forces.has(controller)) {
        controller.userData.cone.visible = false;
        controller.userData.sphere.visible = false;
        forces.delete(controller);
        sendForces();
    }
}

function isHand(controller) {
    const source = controller.userData.inputSource;
    return source !== undefined && source.hand !== undefined && source.hand !== null;
}

// Where an input is: a hand's pinch point, or the controller itself
function inputPosition(controller) {
    if (isHand(controller) &&
        pinchPoint(controller.userData.hand, _pinch) !== undefined) {
        return _pinch;
    }
    return controller.position;
}

// What pokes the menu: a hand's index finger tip. Controllers use their
// ray and trigger instead (poking with them pressed buttons by accident).
function pokeTip(controller) {
    if (isHand(controller)) {
        return jointPosition(controller.userData.hand, "index-finger-tip");
    }
    return undefined;
}

// The bead within reach of a hand's pinch point, if any
function directPick(controller) {
    if (system === undefined || !isHand(controller) ||
        pinchPoint(controller.userData.hand, _pinchLocal) === undefined) {
        return undefined;
    }
    system.instancedMesh.worldToLocal(_pinchLocal);
    // The mesh is unscaled inside the (uniformly scaled) group
    return system.nearestDisplayed(_pinchLocal, HAND_REACH / group.scale.x);
}

// Pull the region around a bead toward a world position
function startPull(controller, index, target) {
    // Pull every bead within PULL_RADIUS of the picked one. Each keeps its
    // offset from the picked bead, so the region is moved as a whole
    // instead of one bead being torn out.
    const center = system.getTargetPosition(index);
    const particles = system.getIndicesWithin(center, PULL_RADIUS);
    // oxDNA applies traps to the particles' centres of mass, not to the
    // backbone sites that are drawn, so the offsets are taken from the
    // centres of mass in the configuration the restart will start from
    // (the same frame the restart sends). The picked bead's centre of mass
    // is pulled to the target.
    const offsets = new Float32Array(3 * particles.length);
    const picked = particles.indexOf(index);
    if (readPositions(latestDat(), particles, offsets) === particles.length) {
        const cx = offsets[3 * picked];
        const cy = offsets[3 * picked + 1];
        const cz = offsets[3 * picked + 2];
        for (let k = 0; k < offsets.length; k += 3) {
            offsets[k] -= cx;
            offsets[k + 1] -= cy;
            offsets[k + 2] -= cz;
        }
    } else {
        // Configuration unreadable: fall back to the backbone sites
        particles.forEach((i, k) => {
            system.getTargetPosition(i, _trapPos).sub(center).toArray(offsets, 3 * k);
        });
    }
    forces.set(controller, {
        nucId: index,
        particles: particles,
        offsets: offsets,
        // Shared by the region, so the pull is gentle
        stiff: pullStiffness / particles.length,
        // The target in oxDNA coordinates, so it moves with the structure
        oxDNATarget: system.instancedMesh.worldToLocal(target.clone())
    });

    console.log(`Pull ${particles.length} particles around ${index}`);

    // Show the "tractor beam" cone
    controller.userData.cone.visible = true;
    updateCones();
}

// The current pulls as an oxDNA trap file
function forceString() {
    return [...forces.values()].map(f => f.particles.map(
        (i, k) => trapBlock(
            i, _trapPos.fromArray(f.offsets, 3 * k).add(f.oxDNATarget), f.stiff
        )
    ).join("\n")).join("\n");
}

// The latest configuration: from the running simulation, or the one it
// will continue from when started
function latestDat() {
    if (ox_socket !== undefined) {
        return ox_socket.get_latest_dat();
    }
    return stoppedDat ?? initialDat;
}

// Send the current pulls to oxDNA as trap forces. Without a simulation
// they take effect when it is started.
function sendForces() {
    // Off, or about to connect (which sends the current pulls anyway)
    if (!simulationOn || ox_socket === undefined) {
        return;
    }
    const forceStr = forceString();
    if (forceStr === ox_socket.forces && !connectionLost()) {
        console.log("Forces do not need to be updated");
        return;
    }
    continueFrom(ox_socket.get_latest_dat(), forceStr);
}

// Continue the simulation from `dat` with the given trap forces. If it is
// off, `dat` is just kept for the next start. If it is on, it is restarted
// on a fresh oxServe connection: oxServe kills the old run, but frames the
// dying run still sends would arrive on the old connection, and shown, they
// would move the structure on without the new forces and then snap it back
// when the new run starts from `dat`. A fresh connection never receives
// them, so the structure holds still until the new run starts.
//
// A restart requested while one is pending replaces it.
function continueFrom(dat, forceStr) {
    if (!simulationOn) {
        stoppedDat = dat;
        return;
    }
    const waiting = pendingRestart !== undefined;
    pendingRestart = {dat, forceStr};
    if (waiting) {
        return;
    }
    const old = ox_socket;
    if (old !== undefined) {
        old.shutdown();
    }
    afterClosed(old, () => {
        const restart = pendingRestart;
        pendingRestart = undefined;
        if (restart !== undefined && simulationOn) {
            connect(restart.dat, restart.forceStr);
        }
    });
}

// Call `then` once `socket` (being shut down, or undefined) has closed, or
// after RESTART_CLOSE_WAIT at most, so that oxServe never counts the old and
// the new connection against its connection limit at the same time
function afterClosed(socket, then) {
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
        then();
        return;
    }
    let done = false;
    const once = () => {
        if (!done) {
            done = true;
            then();
        }
    };
    socket.addEventListener("close", once, {once: true});
    setTimeout(once, RESTART_CLOSE_WAIT);
}

// Connect, once the last stopped connection has closed, from the latest
// configuration with the current pulls (if still on and not connected)
function connectWhenFree() {
    afterClosed(closingSocket, () => {
        if (simulationOn && ox_socket === undefined && system !== undefined) {
            connect(latestDat(), forceString());
        }
    });
}

function onSelectEnd(event) {
    const controller = event.target;
    controller.userData.selected = undefined;
    if (controller.userData.drag !== undefined) {
        // Drop: pull the dragged region toward where the pinch opened
        const index = controller.userData.drag;
        controller.userData.drag = undefined;
        if (system !== undefined) {
            startPull(controller, index, inputPosition(controller).clone());
            sendForces();
        }
    }
    if (grab !== undefined && grab.controller === controller) {
        // Place the structure where it is, and keep it there
        grab = undefined;
        roomAnchor.requestPlacement();
        movePanel.setStatus("");
    }
}

// The controller held in the left hand (falls back to the first one if
// the runtime does not report handedness)
function leftController() {
    for (const c of [controller1, controller2]) {
        const source = c.userData.inputSource;
        if (source && source.handedness === "left") {
            return c;
        }
    }
    return controller1;
}

// Open or close the move window. While it is open, the trigger grabs the
// whole structure instead of pulling beads.
function setMoveMode(on) {
    moveMode = on;
    if (on) {
        // Pulls stay on (no simulation restart). Their targets are in the
        // structure's coordinates, so they move along with it.
        stopInteractions();
        placeMenu();
    }
    grab = undefined;
    movePanel.mesh.visible = on;
    movePanel.setHovered(undefined);
    movePanel.setStatus("");
    movePanel.setStiffness(pullStiffness);
    movePanel.setLabel("toggleBox", boxVisible ? "Hide box" : "Show box");
    updateDesignMenu();
    updateSimulationButton();
    updateConnectionStatus(performance.now());
}

// Put the structure in front of a viewer at `head` looking along
// `direction`: far enough that it is not in their face, a little below eye
// level, and turned to face them (yaw only)
function placeInFrontOf(head, direction) {
    _placeDir.set(direction.x, 0, direction.z);
    if (_placeDir.lengthSq() < 1e-6) {
        _placeDir.set(0, 0, -1);
    }
    _placeDir.normalize();
    // Clear of the structure's own extent (its bounding sphere, scaled to
    // the room)
    const radius = system !== undefined ?
        system.instancedMesh.boundingSphere.radius * group.scale.x : 0.75;
    group.position.copy(head).addScaledVector(_placeDir, radius + VIEWER_CLEARANCE);
    group.position.y = head.y - BELOW_EYE_LEVEL;
    group.quaternion.setFromAxisAngle(_up, Math.atan2(-_placeDir.x, -_placeDir.z));
}

// End everything that lasts only while a trigger or pinch is held:
// grabbing the structure, dragging a region and hover highlights. Pulls
// stay.
function stopInteractions() {
    grab = undefined;
    for (const c of [controller1, controller2]) {
        c.userData.selected = undefined;
        c.userData.drag = undefined;
        if (!forces.has(c)) {
            c.userData.cone.visible = false;
            c.userData.sphere.visible = false;
        }
        if (system !== undefined) {
            setHighlight(c, undefined);
        }
    }
}

// Put the menu by the left controller, or for a hand (which gives no stable
// place to attach it to) in the room in front of the viewer
function placeMenu() {
    menuNeedsPlacement = false;
    // A tip that was ready before must come out in front of the new place
    for (const c of [controller1, controller2]) {
        c.userData.poke.armed = false;
    }
    const left = leftController();
    if (isHand(left)) {
        const xrCamera = renderer.xr.getCamera();
        _head.setFromMatrixPosition(xrCamera.matrixWorld);
        _headDir.set(0, 0, -1).transformDirection(xrCamera.matrixWorld);
        movePanel.placeInFront(scene, _head, _headDir);
    } else {
        movePanel.attachTo(left);
    }
}

// The system took over the session (e.g. its menu, opened with the palm
// pinch gesture of a tracked hand) or gave it back. Coming back with hands,
// our menu is opened: Quest keeps that gesture for itself, so this is how
// it opens the menu as the controller's menu button does.
function onSessionVisibilityChange(event) {
    const visible = event.session.visibilityState === "visible";
    if (!visible) {
        sessionBlurred = true;
        // No select end comes while the system has the inputs
        stopInteractions();
        return;
    }
    if (sessionBlurred && isHand(leftController()) && !moveMode) {
        // Counts as a toggle, so a brief menu button report right after
        // does not close it again
        lastMenuToggle = performance.now();
        setMoveMode(true);
    }
    sessionBlurred = false;
}

function menuAction(button) {
    if (button === undefined) {
        return;
    }
    switch (button) {
    case "resetPosition":
        if (renderer.xr.isPresenting) {
            const xrCamera = renderer.xr.getCamera();
            _head.setFromMatrixPosition(xrCamera.matrixWorld);
            _headDir.set(0, 0, -1).transformDirection(xrCamera.matrixWorld);
            placeInFrontOf(_head, _headDir);
        } else {
            group.position.set(0, 0, 0);
            group.quaternion.identity();
        }
        roomAnchor.requestPlacement();
        break;
    case "resetStructure":
        // Back to the starting configuration, where the structure is now
        // and without pulls, in a single restart
        if (system !== undefined) {
            releaseAllPulls(false);
            updateStrandsFromDat(initialDat, system);
            continueFrom(initialDat, "");
        }
        break;
    case "toggleBox":
        boxVisible = !boxVisible;
        saveSetting(BOX_KEY, boxVisible ? "1" : "0");
        for (const helper of boxHelpers) {
            helper.visible = boxVisible;
        }
        movePanel.setLabel("toggleBox", boxVisible ? "Hide box" : "Show box");
        break;
    case "stiffDown":
    case "stiffUp": {
        const i = STIFFNESS_STEPS.indexOf(pullStiffness) +
            (button === "stiffUp" ? 1 : -1);
        pullStiffness = STIFFNESS_STEPS[
            Math.min(Math.max(i, 0), STIFFNESS_STEPS.length - 1)
        ];
        saveSetting(STIFFNESS_KEY, String(pullStiffness));
        movePanel.setStiffness(pullStiffness);
        stiffnessChanged = true;
        break;
    }
    case "designPrev":
    case "designNext":
        selectedDesign = (selectedDesign + (button === "designNext" ? 1 : -1) +
            DESIGNS.length) % DESIGNS.length;
        updateDesignMenu();
        break;
    case "designLoad":
        loadDesign(selectedDesign);
        break;
    case "simulation":
        if (simulationOn) {
            stopSimulation();
        } else {
            startSimulation();
        }
        break;
    case "reconnect":
        // A fresh connection, continuing from the latest configuration
        // with the current pulls
        if (simulationOn && ox_socket !== undefined) {
            reconnectTimes.length = 0;
            continueFrom(ox_socket.get_latest_dat(), ox_socket.forces);
        }
        break;
    case "exitXR": {
        // Leave the immersive session (Quest's own quit needs a short palm
        // pinch with hands, which easily turns into a recenter instead).
        // Pulls, menu and placement are kept for coming back.
        const session = renderer.xr.getSession();
        if (session) {
            session.end();
        }
        break;
    }
    case "done":
        setMoveMode(false);
        // A changed stiffness also applies to the active pulls (one restart)
        if (stiffnessChanged && forces.size > 0) {
            for (const f of forces.values()) {
                f.stiff = pullStiffness / f.particles.length;
            }
            sendForces();
        }
        stiffnessChanged = false;
        break;
    default:
        return;
    }
    for (const c of [controller1, controller2]) {
        pulse(c);
    }
}

// The pose to carry the structure with: a hand's pinch point turning with
// its wrist, or the controller's pose
function grabFrame(controller) {
    if (isHand(controller)) {
        return handGrabMatrix(controller.userData.hand, _grabMatrix);
    }
    return _grabMatrix.copy(controller.matrix);
}

function onMoveSelectStart(controller) {
    // Hands use the menu by poking it
    const panelHit = isHand(controller) ?
        undefined : movePanel.hitTest(controllerRay(controller));
    if (panelHit !== undefined) {
        menuAction(panelHit.button);
        return;
    }
    const frame = grabFrame(controller);
    if (frame === undefined) {
        return;
    }
    // Grab: keep the structure's pose relative to the controller or hand
    group.updateMatrix();
    grab = {
        controller: controller,
        offset: frame.clone().invert().multiply(group.matrix)
    };
    pulse(controller);
    movePanel.setStatus(
        isHand(controller) ? "Open the pinch to place" : "Release the trigger to place"
    );
}

// Carry the grabbed structure along with the controller or hand
function updateGrab() {
    const frame = grabFrame(grab.controller);
    // Keep still while the hand is not tracked
    if (frame === undefined) {
        return;
    }
    frame.multiply(grab.offset);
    // Only position and rotation are carried, the scale stays fixed
    frame.decompose(group.position, group.quaternion, _grabScale);
}

// Open the move window on a press of the left controller's menu button
function pollMenuButton() {
    const controller = leftController();
    const source = controller.userData.inputSource;
    let pressed = false;
    if (source && source.gamepad) {
        const buttons = source.gamepad.buttons;
        // A hand's emulated gamepad has the pinch (select) as button 0 and
        // may report a grasp as squeeze (1); any later button is taken as
        // its menu gesture
        const hand = isHand(controller);
        for (let i = 0; i < buttons.length; i++) {
            if ((hand ? i > 1 : isMenuButton(i)) && buttons[i].pressed) {
                pressed = true;
            }
        }
    }
    // Toggle on press (a hand's emulated menu button may only be pressed
    // for a moment, so no hold is required); the cooldown stops a double
    // toggle
    const now = performance.now();
    if (pressed && !controller.userData.menuPressed &&
        now - lastMenuToggle >= MENU_TOGGLE_COOLDOWN) {
        lastMenuToggle = now;
        setMoveMode(!moveMode);
    }
    controller.userData.menuPressed = pressed;
}

// Point rays at or poke the menu, highlight its buttons and run poked ones
function updatePanelHover() {
    let hovered;
    for (const c of [controller1, controller2]) {
        if (!isHand(c)) {
            const hit = movePanel.hitTest(controllerRay(c));
            c.userData.line.scale.z = hit === undefined ? 5 : hit.distance;
            if (hit !== undefined && hit.button !== undefined) {
                hovered = hit.button;
            }
        }
        const tip = pokeTip(c);
        if (tip === undefined) {
            // Untracked (or a controller): no highlight. An ongoing press
            // only re-arms once the tip is seen out in front again.
            c.userData.poke.hovered = undefined;
        }
        const poked = tip === undefined ? undefined : movePanel.poke(tip, c.userData.poke);
        if (c.userData.poke.hovered !== undefined) {
            hovered = c.userData.poke.hovered;
        }
        const now = performance.now();
        if (poked !== undefined && now - (c.userData.poke.lastAt ?? -Infinity) >= POKE_COOLDOWN) {
            c.userData.poke.lastAt = now;
            menuAction(poked);
            if (!moveMode) {
                return;
            }
        }
    }
    movePanel.setHovered(hovered);
}

// Let go of all pulls and held interactions. Unless `send` is false, the
// simulation is restarted without the pulls.
function releaseAllPulls(send = true) {
    for (const c of [controller1, controller2]) {
        c.userData.cone.visible = false;
        c.userData.sphere.visible = false;
        c.userData.selected = undefined;
        c.userData.drag = undefined;
        if (system !== undefined) {
            setHighlight(c, undefined);
        }
    }
    if (forces.size > 0) {
        forces.clear();
        if (send) {
            sendForces();
        }
    }
}

let container;
let camera, scene, renderer;
let controller1, controller2;
let controllerGrip1, controllerGrip2;

const forces = new Map();

// Move window state: whether it is open, and the controller holding the
// structure with the structure's pose relative to it
let moveMode = false;
let movePanel;
// Set when the open menu has to be placed again (new session, or the
// inputs switched between hands and controllers)
let menuNeedsPlacement = false;
// Set while the system (e.g. its menu) has taken over the XR session
let sessionBlurred = false;
// Shown while oxServe is starting a run
let startingLabel;
// Errors from the animation loop that were already logged
const reportedErrors = new Set();
let grab;
// Keeps the structure fixed in the room
let roomAnchor;

let controls, group;
let keyLight, roomEnvironment;

// my oxDNA related mess
let box;
let system;
let ox_socket;
// The starting configuration, for resetting the structure, and what is
// needed to reconnect to oxServe
let initialDat, initialTop, simulationType;
// Whether the oxServe simulation is on. It is off on every page load (no
// connection); the menu starts and stops it.
let simulationOn = false;
// The configuration the simulation continues from when it is started
// again (the last frame when it was stopped, or a reset or dropped one)
let stoppedDat;
let anchorStatus = "none";
// After this long (ms) without a frame, a running simulation is reported
// as stalled
const STALLED_AFTER = 20000;
// When the connection was re-established, to stop retrying a server that
// keeps dropping it
const reconnectTimes = [];
const MAX_RECONNECTS_PER_MINUTE = 3;
const RECONNECT_DELAY = 2000;
// A restart waiting for the old connection to close, and how long (ms) it
// waits at most
let pendingRestart;
// The connection last stopped, while it closes (a start waits for it)
let closingSocket;
// The page's start/stop button (outside XR)
let simulationButton;
const RESTART_CLOSE_WAIT = 1000;

const targetScale = new THREE.Vector3(1/100, 1/100, 1/100);

const controllerColors = {
    left: new THREE.Color(0x188DFF),
    right: new THREE.Color(0xFF8B17)
};

const initSceneFromJSON = (txt) => {
    // we recieve an oxView file, so it's json
    const json_data = JSON.parse(txt);

    box = new THREE.Vector3().fromArray(json_data.box);


    console.log(json_data);

    const strands = json_data.systems[0].strands;
    // Count monomers
    let n_monomers = 0;
    strands.forEach(strand => {
        n_monomers += strand.monomers.length;
    });

    // Build the new system first, so that a design that fails to parse
    // leaves the current one running
    const newSystem = new System(box);
    strands.forEach(strandData => {
        const strand = new Strand(newSystem, strandData.id);
        newSystem.strands.push(strand);
        strandData.monomers.forEach(monomerData => {
            let monomerClass;
            switch (monomerData.class) {
            case "DNA": monomerClass = DNAMonomer; break;
            case "RNA": monomerClass = RNAMonomer; break;
            case "AA": monomerClass  = AminoAcidMonomer; break;
            default:
                throw new Error(`Unrecognised type of element:  ${monomerData.class}`);
            }

            if (newSystem.elements.has(monomerData.id)) {
                throw "Differing id handling not inplemented yet";
            }
            const monomer = new monomerClass(
                monomerData.id,
                monomerData.type,
                strand,
                new THREE.Vector3(...monomerData.p),
                new THREE.Vector3(...monomerData.a1),
                new THREE.Vector3(...monomerData.a3)
            );
            strand.monomers.push(monomer);
        });
    });
    strands.forEach(strandData => {
        strandData.monomers.forEach(monomerData => {
            const monomer = newSystem.elements.get(monomerData.id);
            monomer.n5 = newSystem.elements.get(monomerData.n5);
            monomer.n3 = newSystem.elements.get(monomerData.n3);
            monomer.pair = newSystem.elements.get(monomerData.bp);
        });
    });
    // Some exports list only one neighbour per nucleotide (e.g. only n3):
    // complete each link from the other side
    for (const monomer of newSystem.elements.values()) {
        if (monomer.n3 !== undefined && monomer.n3.n5 === undefined) {
            monomer.n3.n5 = monomer;
        }
        if (monomer.n5 !== undefined && monomer.n5.n3 === undefined) {
            monomer.n5.n3 = monomer;
        }
    }
    newSystem.placeInBox();
    newSystem.assignIndices();

    newSystem.createViewMesh();

    // Drop everything that belongs to the previous system. Its connection
    // (if the simulation is on) is replaced by continueFrom below.
    if (system !== undefined) {
        system.dispose();
    }
    for (const c of [controller1, controller2]) {
        c.userData.cone.visible = false;
        c.userData.sphere.visible = false;
        // Highlights belonged to the old system's colours
        c.userData.highlighted = undefined;
        c.userData.selected = undefined;
        c.userData.drag = undefined;
    }
    forces.clear();

    // make sure we have no items in the scene group
    while (group.children.length > 0) {
        let child = group.children[0];
        group.remove(child);
        // Optional: Dispose geometry and material if they are no longer needed
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
    }

    system = newSystem;
    group.add(system.instancedMesh);

    const axesHelper = new THREE.AxesHelper(10);
    const boxMesh = drawBox(box.clone());

    const origin = system.box.clone().multiplyScalar(0.5);

    system.instancedMesh.position.sub(origin);
    axesHelper.position.sub(origin);

    group.add(boxMesh);
    group.add(axesHelper);
    boxHelpers = [boxMesh, axesHelper];
    for (const helper of boxHelpers) {
        helper.visible = boxVisible;
    }

    //generate its description in oxDNA world
    let top_file = makeTopFile(system);
    let dat_file = makeDatFile(system);
    initialDat = dat_file;

    // Establish oxServe connection and update cycles here
    initialTop = top_file;
    // TODO: Check more than just one monomer
    simulationType = system.strands[0].monomers[0].getCategory();
    reconnectTimes.length = 0;
    stoppedDat = undefined;
    // Simulate the new structure if the simulation is on
    if (simulationOn) {
        if (ox_socket === undefined) {
            connectWhenFree();
        } else {
            // Replaces any restart still pending for the previous system
            pendingRestart = undefined;
            continueFrom(dat_file, "");
        }
    }

    return [strands, n_monomers];
};

// Open an oxServe connection and start simulating from `dat` with the
// given trap forces. A lost connection is re-established from the latest
// configuration, if the page is in view and it has not kept failing.
function connect(dat, forceStr) {
    // The wait for the new run is not a frame interval
    system.resetFrameTiming();
    const socket = establishConnection(system, initialTop, dat, simulationType);
    socket.forces = forceStr;
    socket.addEventListener("close", () => {
        if (socket !== ox_socket || socket.intentionalClose) {
            return;
        }
        const now = performance.now();
        // Only count recent attempts
        while (reconnectTimes.length > 0 && now - reconnectTimes[0] > 60000) {
            reconnectTimes.shift();
        }
        if (document.visibilityState !== "visible" ||
            reconnectTimes.length >= MAX_RECONNECTS_PER_MINUTE) {
            // Retried on the next pull instead (see sendForces)
            return;
        }
        reconnectTimes.push(now);
        setTimeout(() => {
            if (socket === ox_socket) {
                reconnect();
            }
        }, RECONNECT_DELAY);
    });
    ox_socket = socket;
    window.socket = socket;
    // Waits for the connection to open if needed
    socket.start_simulation();
}

// Continue the simulation on a new connection, from the latest
// configuration and with the current forces
function reconnect() {
    console.warn("Reconnecting to oxServe");
    const old = ox_socket;
    connect(old.get_latest_dat(), old.forces);
}

function connectionLost() {
    return ox_socket !== undefined && (
        ox_socket.readyState === WebSocket.CLOSING ||
        ox_socket.readyState === WebSocket.CLOSED
    );
}

// Connect to oxServe and simulate, from the latest configuration and with
// the current pulls
function startSimulation() {
    if (simulationOn) {
        return;
    }
    simulationOn = true;
    reconnectTimes.length = 0;
    updateSimulationButton();
    // Before the first structure has loaded, initSceneFromJSON connects
    connectWhenFree();
}

// Stop simulating and disconnect, keeping the last configuration (and the
// pulls) for the next start
function stopSimulation() {
    if (!simulationOn) {
        return;
    }
    simulationOn = false;
    if (pendingRestart !== undefined) {
        // A restart was about to start from this (e.g. a reset or a newly
        // loaded structure)
        stoppedDat = pendingRestart.dat;
        pendingRestart = undefined;
    } else if (ox_socket !== undefined) {
        stoppedDat = ox_socket.get_latest_dat();
    }
    if (ox_socket !== undefined) {
        closingSocket = ox_socket;
        ox_socket.shutdown();
        ox_socket = undefined;
    }
    // Show where the next start continues from
    if (stoppedDat !== undefined && system !== undefined) {
        updateStrandsFromDat(stoppedDat, system);
    }
    updateSimulationButton();
}

function updateSimulationButton() {
    if (movePanel !== undefined) {
        movePanel.setLabel("simulation",
            simulationOn ? "Stop simulation" : "Start simulation");
    }
    if (simulationButton !== undefined) {
        simulationButton.textContent =
            simulationOn ? "STOP SIMULATION" : "START SIMULATION";
    }
}

// The same switch on the page, for viewing without a headset
function makeSimulationButton() {
    const button = document.createElement("button");
    button.style.cssText = "position: absolute; bottom: 20px; left: 20px; " +
        "padding: 12px 10px; border: 1px solid #fff; border-radius: 4px; " +
        "background: rgba(0, 0, 0, 0.1); color: #fff; " +
        "font: normal 13px sans-serif; cursor: pointer; z-index: 999;";
    button.addEventListener("click", () => {
        if (simulationOn) {
            stopSimulation();
        } else {
            startSimulation();
        }
    });
    document.body.appendChild(button);
    return button;
}

// Show the live state of the oxServe connection in the menu
function updateConnectionStatus(now) {
    if (movePanel === undefined) {
        return;
    }
    movePanel.setInfo(`Room anchor: ${anchorStatus}`);
    if (!simulationOn) {
        movePanel.setConnection("Simulation off", "#8f9aab");
    } else if (ox_socket === undefined) {
        movePanel.setConnection("Connecting\u2026", "#f5c542");
    } else if (ox_socket.readyState === WebSocket.CONNECTING) {
        movePanel.setConnection("Connecting\u2026", "#f5c542");
    } else if (ox_socket.readyState !== WebSocket.OPEN) {
        movePanel.setConnection("Disconnected", "#e5484d");
    } else if (ox_socket.isStarting(now)) {
        movePanel.setConnection("Starting\u2026", "#f5c542");
    } else if (now - ox_socket.lastFrameAt > STALLED_AFTER) {
        movePanel.setConnection("No frames", "#f08c2e");
    } else {
        movePanel.setConnection("Running", "#3ccf6e");
    }
}

const init = () => {
    container = document.createElement("div");
    container.style = "background:none";

    document.body.appendChild(container);

    makeFileDropable(container, (files) => {
        // assuming we got one file
        // -> simple parser test
        files[0].text().then(text => {
            if (!updateStrandsFromDat(text, system)) {
                console.warn("Dropped file is not a complete configuration of this structure");
                return;
            }
            // Continue (or later start) the simulation from the dropped
            // configuration
            continueFrom(text, forceString());
        });
    });

    scene = new THREE.Scene();

    scene.background = new THREE.Color(0x000000);

    camera = new THREE.PerspectiveCamera(
        50, window.innerWidth / window.innerHeight, 0.1, 100
    );
    camera.position.set(0, 1.6, 5);

    controls = new OrbitControls(camera, container);
    controls.update();

    // Soft sky/ground ambient, a warm shadow casting key light, a cool fill
    // light from the other side and a rim light from behind. Image based
    // lighting from a room environment (set up with the renderer) adds
    // reflections and soft shading.
    const hemilight = new THREE.HemisphereLight(0xdfe8ff, 0x3a3a48, 1.2);

    // The key light follows the structure (see render()), so that its
    // shadow camera covers it wherever it is placed
    keyLight = new THREE.DirectionalLight(0xfff2e0, 2.5);
    keyLight.castShadow = true;
    keyLight.shadow.camera.top = 1;
    keyLight.shadow.camera.bottom = -1;
    keyLight.shadow.camera.right = 1;
    keyLight.shadow.camera.left = -1;
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 7;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.bias = -0.0002;
    keyLight.shadow.normalBias = 0.002;
    keyLight.shadow.radius = 3;
    scene.add(keyLight.target);

    const fillLight = new THREE.DirectionalLight(0xd8e4ff, 0.8);
    fillLight.position.set(-3, 1, 2);
    const rimLight = new THREE.DirectionalLight(0xffffff, 1.2);
    rimLight.position.set(0, 2, -4);

    let defaultLight = new THREE.Group();
    defaultLight.add(hemilight);
    defaultLight.add(keyLight);
    defaultLight.add(fillLight);
    defaultLight.add(rimLight);
    scene.add(defaultLight);


    // read from nanobase might be subject to XSSS scripting issues ...
    // need to look more into it, but even oxview.org can't fetch in local
    // dev cycle

    // we'll use the group to add stuff as this is
    // allows for grabbing the entire thing
    group = new THREE.Group();
    group.scale.copy(targetScale);

    scene.add(group);

    renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true
    });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    // Keeps the strand colours' hues while compressing highlights
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType("local");
    container.appendChild(renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(renderer);
    roomEnvironment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    scene.environment = roomEnvironment;
    scene.environmentIntensity = 0.3;

    roomAnchor = new RoomAnchor(group);
    // No saved placement: put the structure in front of the viewer
    roomAnchor.onInitialPose = (viewer) => {
        _head.copy(viewer.position);
        _headDir.set(0, 0, -1).applyQuaternion(_viewerRotation.copy(viewer.orientation));
        placeInFrontOf(_head, _headDir);
    };
    roomAnchor.onStatus = (status) => {
        anchorStatus = status;
        if (movePanel !== undefined) {
            movePanel.setInfo(`Room anchor: ${anchorStatus}`);
        }
    };

    renderer.xr.addEventListener("sessionstart", ()=>{
        const session = renderer.xr.getSession();
        roomAnchor.onSessionStart(session, renderer.xr.getReferenceSpace());
        session.addEventListener("visibilitychange", onSessionVisibilityChange);
        sessionBlurred = false;
        // An open menu is placed again once the inputs are known
        menuNeedsPlacement = moveMode;
    });

    renderer.xr.addEventListener("sessionend", ()=>{
        // Leaving the session (e.g. for the system menu) keeps the pulls, the
        // open menu and the placement, so coming back continues where it
        // left off. Only held interactions end (no select end will come).
        stopInteractions();
        roomAnchor.onSessionEnd();
    });

    document.body.appendChild(XRButton.createButton(renderer, {
        optionalFeatures: ["light-estimation", "anchors", "hand-tracking"]
    }));
    simulationButton = makeSimulationButton();
    updateSimulationButton();

    // Don't add the XREstimatedLight to the scene initially.
    // It doesn't have any estimated lighting values until an AR session starts.

    const xrLight = new XREstimatedLight(renderer);

    xrLight.addEventListener("estimationstart", () => {
        // Swap the default light out for the estimated one one we start
        // getting some estimated values.
        scene.add(xrLight);
        scene.remove(defaultLight);

        // The estimated lighting also provides an environment cubemap, which
        // we can apply here.
        if (xrLight.environment) {
            scene.environment = xrLight.environment;
        }

    });

    xrLight.addEventListener("estimationend", () => {
        // Swap the lights back when we stop receiving estimated values.
        scene.add(defaultLight);
        scene.remove(xrLight);
        scene.environment = roomEnvironment;
    });

    // controllers

    controller1 = renderer.xr.getController(0);
    controller1.name="left";
    scene.add(controller1);

    controller2 = renderer.xr.getController(1);
    controller2.name="right";
    scene.add(controller2);

    const controllerModelFactory = new XRControllerModelFactory();

    controllerGrip1 = renderer.xr.getControllerGrip(0);
    controllerGrip1.add(
        controllerModelFactory.createControllerModel(controllerGrip1)
    );
    scene.add(controllerGrip1);

    controllerGrip2 = renderer.xr.getControllerGrip(1);
    controllerGrip2.add(
        controllerModelFactory.createControllerModel(controllerGrip2)
    );
    scene.add(controllerGrip2);

    // Tracked hands share their controller's events (a pinch is a select)
    const handModelFactory = new XRHandModelFactory();
    [controller1, controller2].forEach((c, i) => {
        const hand = renderer.xr.getHand(i);
        const handModel = handModelFactory.createHandModel(hand, "mesh");
        handModel.visible = false;
        hand.add(handModel);
        scene.add(hand);
        c.userData.hand = hand;
        c.userData.handModel = handModel;
    });

    movePanel = new MovePanel();
    startingLabel = makeStartingLabel();
    scene.add(startingLabel);

    const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1)
    ]);

    const pullSphereGeometry = new THREE.SphereGeometry(1, 16, 12);

    [controller1, controller2].forEach(c=>{
        c.addEventListener("selectstart", onSelectStart);
        c.addEventListener("selectend", onSelectEnd);
        // Per controller state of poking the menu
        c.userData.poke = {armed: false, hovered: undefined};

        // Keep the input source, for haptic feedback
        c.addEventListener("connected", e => {
            c.userData.inputSource = e.data;
            // Switching between hands and controllers moves the menu
            menuNeedsPlacement = moveMode;
        });
        c.addEventListener("disconnected", () => {
            c.userData.inputSource = undefined;
        });

        const line = new THREE.Line(
            geometry,
            new THREE.LineBasicMaterial({
                color: controllerColors[c.name]
            })
        );
        line.name = "line";
        line.scale.z = 5;
        c.add(line);
        c.userData.line = line;

        // One reusable "tractor beam" cone per controller
        const cone = drawCone(
            new THREE.Vector3(), new THREE.Vector3(0, 0, -1),
            controllerColors[c.name]
        );
        cone.visible = false;
        scene.add(cone);
        c.userData.cone = cone;

        // Shows the region a pull acts on (unit radius, scaled to
        // PULL_RADIUS each frame)
        const sphere = new THREE.Mesh(
            pullSphereGeometry,
            new THREE.MeshBasicMaterial({
                color: controllerColors[c.name],
                wireframe: true,
                transparent: true,
                opacity: 0.35
            })
        );
        sphere.visible = false;
        scene.add(sphere);
        c.userData.sphere = sphere;
    });

    window.addEventListener("resize", onWindowResize);

    //load up first design
    loadDesign(selectedDesign);

    renderer.setAnimationLoop(render);

    // Debugging hooks for the dev server only (stripped from builds)
    if (import.meta.env.DEV) {
        window.__oxjenga = {
            get system() { return system; },
            get socket() { return ox_socket; },
            get group() { return group; },
            get moveMode() { return moveMode; },
            get renderer() { return renderer; },
            get movePanel() { return movePanel; },
            render,
            controllers: [controller1, controller2],
            forces, startPull, sendForces, releasePull, pollMenuButton, menuAction
        };
    }
};

const onWindowResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);

};

// Change which bead a controller highlights. Only touches the colours
// when the highlighted bead actually changes.
function setHighlight(controller, index) {
    const previous = controller.userData.highlighted;
    if (previous === index) {
        return;
    }
    controller.userData.highlighted = index;
    if (previous !== undefined) {
        system.setHighlighted(previous, false);
    }
    if (index !== undefined) {
        system.setHighlighted(index, true);
    }
}

function pulse(controller) {
    const source = controller.userData.inputSource;
    if (
        source &&
        source.gamepad &&
        source.gamepad.hapticActuators &&
        source.gamepad.hapticActuators[0]
    ) {
        source.gamepad.hapticActuators[0].pulse(0.4, 20);
    }
}

function updateHover(controller) {

    const line = controller.userData.line;

    // Dragging with a pinch: the cone runs from the pinch to the region
    if (controller.userData.drag !== undefined) {
        const index = controller.userData.drag;
        system.getDisplayedPosition(index, _beadPos);
        system.instancedMesh.localToWorld(_beadPos);
        positionCone(controller.userData.cone, inputPosition(controller), _beadPos);
        placePullSphere(controller, index);
        setHighlight(controller, undefined);
        return;
    }

    // Do not highlight when already selected
    if (controller.userData.selected !== undefined) {
        setHighlight(controller, undefined);
        return;
    }

    // A hand only highlights what is within its reach
    if (isHand(controller)) {
        const direct = directPick(controller);
        if (direct === undefined) {
            if (!forces.has(controller)) {
                controller.userData.sphere.visible = false;
            }
            setHighlight(controller, undefined);
            return;
        }
        if (!forces.has(controller)) {
            placePullSphere(controller, direct);
        }
        setHighlight(controller, direct);
        return;
    }

    const hit = pickFromController(controller);

    if (hit === undefined) {
        line.scale.z = 5;
        // While pulling, the sphere stays on the pulled region
        if (!forces.has(controller)) {
            controller.userData.sphere.visible = false;
        }
        setHighlight(controller, undefined);
        return;
    }

    // Show the region a pull from here would act on
    if (!forces.has(controller)) {
        placePullSphere(controller, hit.index);
    }

    // Continuous haptic pulse while pointing at the same bead
    if (hit.index === controller.userData.highlighted) {
        pulse(controller);
    }

    setHighlight(controller, hit.index);
    line.scale.z = hit.distance;
}

// Show hand meshes only while their hand is tracked (otherwise they would
// stay frozen in place), and no pointing rays for hands
function updateHands() {
    for (const c of [controller1, controller2]) {
        const hand = isHand(c);
        c.userData.handModel.visible = hand &&
            jointPosition(c.userData.hand, "wrist") !== undefined;
        c.userData.line.visible = !hand;
    }
}

// While oxServe starts a (re)started run, which takes 10-20 s for a large
// structure, show how long it has been going above the structure
function updateStartingLabel(now) {
    const show = ox_socket !== undefined && ox_socket.isStarting(now);
    startingLabel.visible = show;
    if (!show) {
        return;
    }
    const seconds = Math.floor((now - ox_socket.startedAt) / 1000);
    if (seconds !== startingLabel.userData.seconds) {
        startingLabel.userData.seconds = seconds;
        const ctx = startingLabel.userData.context;
        ctx.clearRect(0, 0, 512, 96);
        ctx.fillStyle = "rgba(20, 24, 32, 0.85)";
        ctx.beginPath();
        ctx.roundRect(0, 0, 512, 96, 20);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 36px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`Starting simulation\u2026 ${seconds} s`, 256, 50);
        startingLabel.material.map.needsUpdate = true;
    }
    startingLabel.position.copy(group.position).add(LABEL_OFFSET);
    startingLabel.lookAt(_head.setFromMatrixPosition(
        renderer.xr.isPresenting ? renderer.xr.getCamera().matrixWorld : camera.matrixWorld
    ));
}

function makeStartingLabel() {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 96;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Mesh(
        new THREE.PlaneGeometry(0.4, 0.075),
        new THREE.MeshBasicMaterial({map: texture, transparent: true})
    );
    label.userData.context = canvas.getContext("2d");
    label.visible = false;
    return label;
}

// Centre a controller's pull sphere on a bead
function placePullSphere(controller, index) {
    const sphere = controller.userData.sphere;
    system.getDisplayedPosition(index, sphere.position);
    system.instancedMesh.localToWorld(sphere.position);
    // The mesh is unscaled inside the (uniformly scaled) group
    sphere.scale.setScalar(PULL_RADIUS * group.scale.x);
    sphere.visible = true;
}

// Point each pull cone from its target to the pulled bead
function updateCones() {
    for (const [controller, f] of forces) {
        system.getDisplayedPosition(f.nucId, _beadPos);
        system.instancedMesh.localToWorld(_beadPos);
        // The target moves with the structure when it is carried
        _targetPos.copy(f.oxDNATarget);
        system.instancedMesh.localToWorld(_targetPos);
        positionCone(controller.userData.cone, _targetPos, _beadPos);
        placePullSphere(controller, f.nucId);
    }
}

// The animation loop. three.js only asks for the next frame after this
// returns, so an exception escaping it would stop the loop for good (in the
// headset: an empty or frozen scene). Errors are therefore caught, reported
// once each, and the scene is still drawn.
function render(time, frame) {
    try {
        updateFrame(time, frame, performance.now());
    } catch (error) {
        reportFrameError(error);
    }
    try {
        renderer.render(scene, camera);
    } catch (error) {
        reportFrameError(error);
    }
}

// Log each distinct error once, and show the latest in the menu's status
// line (readable in the headset)
function reportFrameError(error) {
    const message = String(error && error.message || error);
    if (!reportedErrors.has(message)) {
        reportedErrors.add(message);
        console.error("Error in the animation loop:", error);
    }
    if (movePanel !== undefined) {
        movePanel.setStatus(`Error: ${message}`.slice(0, 60));
    }
}

function updateFrame(time, frame, now) {
    // Place the structure first: held by hand or fixed in the room
    if (renderer.xr.isPresenting) {
        updateHands();
        pollMenuButton();
        roomAnchor.holding = grab !== undefined;
        roomAnchor.update(frame, renderer.xr.getReferenceSpace());
        if (moveMode) {
            if (menuNeedsPlacement && leftController().userData.inputSource) {
                placeMenu();
            }
            updateConnectionStatus(now);
            updatePanelHover();
            if (grab !== undefined) {
                updateGrab();
            }
        }
    }

    if (system !== undefined && system.instancedMesh !== undefined) {
        system.updateView(now);
        if (forces.size > 0) {
            updateCones();
        }

        // Controllers only exist in an XR session
        if (renderer.xr.isPresenting && !moveMode) {
            updateHover(controller1);
            updateHover(controller2);
        }
    }

    updateStartingLabel(now);

    keyLight.target.position.copy(group.position);
    keyLight.position.copy(group.position).add(KEY_LIGHT_OFFSET);
}

init();
