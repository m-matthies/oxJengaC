import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { XRButton } from "three/addons/webxr/XRButton.js";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
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

import {
    DNAMonomer, RNAMonomer, AminoAcidMonomer,
    Strand, System
} from "./src/system.js";

// Pulls act on every bead within this radius of the picked one, in oxDNA
// length units (1 unit = 0.8518 nm). About the radius of a six-helix bundle.
const PULL_RADIUS = 5.2;
// Total trap stiffness of one pull, shared evenly by all of its beads
const PULL_STIFFNESS = 0.15;

// Gamepad buttons of the left controller that open the move window: X and
// Y, plus anything after the thumbrest (where some runtimes report the
// menu button)
const isMenuButton = (i) => i === 4 || i === 5 || i >= 7;

// Reused scratch objects for controller picking and cone updates
const _ray = new THREE.Ray();
const _hit = {};
const _rotation = new THREE.Matrix4();
const _beadPos = new THREE.Vector3();
const _grabMatrix = new THREE.Matrix4();
const _grabScale = new THREE.Vector3();
const _trapPos = new THREE.Vector3();

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

    const hit = pickFromController(controller);
    if (hit === undefined) {
        // Pointing at nothing releases this controller's pull
        if (forces.has(controller)) {
            controller.userData.cone.visible = false;
            controller.userData.sphere.visible = false;
            forces.delete(controller);
            sendForces();
        }
        return;
    }

    controller.userData.selected = hit.index;

    // Pull toward where the controller is now. The pull stays until the
    // controller selects empty space (or another region).
    const target = controller.position.clone();

    // Pull every bead within PULL_RADIUS of the picked one. Each keeps its
    // offset from the picked bead, so the region is moved as a whole
    // instead of one bead being torn out.
    const center = system.getTargetPosition(hit.index);
    const particles = system.getIndicesWithin(center, PULL_RADIUS);
    const offsets = new Float32Array(3 * particles.length);
    particles.forEach((i, k) => {
        system.getTargetPosition(i, _trapPos).sub(center).toArray(offsets, 3 * k);
    });
    forces.set(controller, {
        nucId: hit.index,
        particles: particles,
        offsets: offsets,
        stiff: PULL_STIFFNESS / particles.length,
        // The target in world and in oxDNA coordinates
        target: target,
        oxDNATarget: system.instancedMesh.worldToLocal(target.clone())
    });

    console.log(`Pull ${particles.length} particles around ${hit.index}`);

    // Show the "tractor beam" cone
    controller.userData.cone.visible = true;
    updateCones();

    sendForces();
}

// Send the current pulls to oxDNA as trap forces
function sendForces() {
    const forceStr = [...forces.values()].map(f => f.particles.map(
        (i, k) => trapBlock(
            i, _trapPos.fromArray(f.offsets, 3 * k).add(f.oxDNATarget), f.stiff
        )
    ).join("\n")).join("\n");

    // Send new forces to oxDNA
    ox_socket.update_forces(forceStr);
}

function onSelectEnd(event) {
    const controller = event.target;
    controller.userData.selected = undefined;
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
    grab = undefined;
    if (on) {
        // Pull targets are fixed in the room, so let go before moving
        releaseAllPulls();
        leftController().add(movePanel.mesh);
    }
    movePanel.mesh.visible = on;
    movePanel.setHovered(undefined);
    movePanel.setStatus("");
}

function onMoveSelectStart(controller) {
    const panelHit = movePanel.hitTest(controllerRay(controller));
    if (panelHit !== undefined) {
        if (panelHit.button === "reset") {
            group.position.set(0, 0, 0);
            group.quaternion.identity();
            roomAnchor.requestPlacement();
        } else if (panelHit.button === "done") {
            setMoveMode(false);
        }
        return;
    }
    // Grab: keep the structure's pose relative to the controller
    group.updateMatrix();
    grab = {
        controller: controller,
        offset: controller.matrix.clone().invert().multiply(group.matrix)
    };
    pulse(controller);
    movePanel.setStatus("Release the trigger to place");
}

// Carry the grabbed structure along with the controller
function updateGrab() {
    _grabMatrix.multiplyMatrices(grab.controller.matrix, grab.offset);
    // The scale is left to the zoom-in lerp in render()
    _grabMatrix.decompose(group.position, group.quaternion, _grabScale);
}

// Open the move window on a press of the left controller's menu button
function pollMenuButton() {
    const controller = leftController();
    const source = controller.userData.inputSource;
    let pressed = false;
    if (source && source.gamepad) {
        const buttons = source.gamepad.buttons;
        for (let i = 0; i < buttons.length; i++) {
            if (isMenuButton(i) && buttons[i].pressed) {
                pressed = true;
            }
        }
    }
    if (pressed && !controller.userData.menuPressed) {
        setMoveMode(!moveMode);
    }
    controller.userData.menuPressed = pressed;
}

// Point the controller rays at the move window and highlight its buttons
function updatePanelHover() {
    let hovered;
    for (const c of [controller1, controller2]) {
        const hit = movePanel.hitTest(controllerRay(c));
        c.userData.line.scale.z = hit === undefined ? 5 : hit.distance;
        if (hit !== undefined && hit.button !== undefined) {
            hovered = hit.button;
        }
    }
    movePanel.setHovered(hovered);
}

// Let go of everything, e.g. when the XR session ends (no selectend fires
// then, even if a trigger is held)
function releaseAllPulls() {
    for (const c of [controller1, controller2]) {
        c.userData.cone.visible = false;
        c.userData.sphere.visible = false;
        c.userData.selected = undefined;
        if (system !== undefined) {
            setHighlight(c, undefined);
        }
    }
    if (forces.size > 0) {
        forces.clear();
        sendForces();
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
let grab;
// Keeps the structure fixed in the room
let roomAnchor;

let controls, group;
let keyLight, roomEnvironment;

// my oxDNA related mess
let box;
let system;
let ox_socket;

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
    newSystem.placeInBox();
    newSystem.assignIndices();

    newSystem.createViewMesh();

    // Drop everything that belongs to the previous system
    if (ox_socket !== undefined) {
        // Stop the server-side run before disconnecting
        ox_socket.shutdown();
    }
    if (system !== undefined) {
        system.dispose();
    }
    for (const c of [controller1, controller2]) {
        c.userData.cone.visible = false;
        c.userData.sphere.visible = false;
        // Highlights belonged to the old system's colours
        c.userData.highlighted = undefined;
        c.userData.selected = undefined;
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

    //generate its description in oxDNA world
    let top_file = makeTopFile(system);
    let dat_file = makeDatFile(system);

    // Establish oxServe connection and update cycles here
    ox_socket = establishConnection(
        system, top_file, dat_file,
        // TODO: Check more than just one monomer
        system.strands[0].monomers[0].getCategory()
    );
    console.log(ox_socket);
    window.socket = ox_socket;

    // Waits for the connection to open if needed
    ox_socket.start_simulation();

    return [strands, n_monomers];
};
const init = () => {
    container = document.createElement("div");
    container.style = "background:none";

    document.body.appendChild(container);

    makeFileDropable(container, (files) => {
        // assuming we got one file
        // -> simple parser test
        files[0].text().then(text => {
            updateStrandsFromDat(text, system);
            // Continue the simulation from the dropped configuration
            if (ox_socket !== undefined) {
                ox_socket.load_dat(text);
            }
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

    class DesignStorage {
        constructor() {
            this.counter = 0;

            this.designs = [
                "flippy_turned.oxview",
                //"flippy.oxview",
                //"monohole_1b.oxview",
                //"6-bar.oxview",
                //"hairygami.oxview",
                //"hairpin.oxview",
                //"Leaf.oxview",
                //"moon.oxview",
                //"meta.oxview",
                //"gated-channel.oxview",
                //"gripper.oxview",
                //"teather.oxview",
                //"planeV3.oxview",
                //"1eua.oxview",
                //"rna_crossover.oxview"
            ].map(p => import.meta.env.BASE_URL + "resources/" + p);
        }
        getCurrent() {
            return this.designs[this.counter];
        }
        getNext() {
            this.counter += 1;
            if (this.counter >= this.designs.length) this.counter = 0;
            return this.designs[this.counter];
        }
        getPrev() {
            this.counter -= 1;
            if (this.counter < 0) this.counter = this.designs.length - 1;
            return this.designs[this.counter];
        }
        getRand() {
            this.counter = Math.floor(Math.random() * this.designs.length);
            return this.designs[this.counter];
        }

    }

    let designStorage = new DesignStorage();

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

    renderer.xr.addEventListener("sessionstart", ()=>{
        // Set small initial scale (actual oxDNA scale)
        group.scale.multiplyScalar(8.518E-10);
        roomAnchor.onSessionStart(
            renderer.xr.getSession(), renderer.xr.getReferenceSpace()
        );
    });

    renderer.xr.addEventListener("sessionend", ()=>{
        // Controllers are no longer tracked, so release their pulls and
        // highlights
        setMoveMode(false);
        releaseAllPulls();
        roomAnchor.onSessionEnd();
    });

    document.body.appendChild(XRButton.createButton(renderer, {
        optionalFeatures: ["light-estimation", "anchors"]
    }));

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

    movePanel = new MovePanel();

    const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1)
    ]);

    const pullSphereGeometry = new THREE.SphereGeometry(1, 16, 12);

    [controller1, controller2].forEach(c=>{
        c.addEventListener("selectstart", onSelectStart);
        c.addEventListener("selectend", onSelectEnd);

        // Keep the input source, for haptic feedback
        c.addEventListener("connected", e => {
            c.userData.inputSource = e.data;
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
    fetch(designStorage.getCurrent()).then(
        resp => resp.text()
    ).then(initSceneFromJSON);

    renderer.setAnimationLoop(render);
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

    // Do not highlight when already selected
    if (controller.userData.selected !== undefined) {
        setHighlight(controller, undefined);
        return;
    }

    const line = controller.userData.line;
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
        positionCone(controller.userData.cone, f.target, _beadPos);
        placePullSphere(controller, f.nucId);
    }
}

function render(time, frame) {
    const now = performance.now();

    // Place the structure first: held by hand or fixed in the room
    if (renderer.xr.isPresenting) {
        pollMenuButton();
        roomAnchor.holding = grab !== undefined;
        roomAnchor.update(frame, renderer.xr.getReferenceSpace());
        if (moveMode) {
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

    group.scale.lerp(targetScale, 0.01);

    keyLight.target.position.copy(group.position);
    keyLight.position.copy(group.position).add(KEY_LIGHT_OFFSET);

    renderer.render(scene, camera);
}

init();
