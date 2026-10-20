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
import { establishConnection } from "./src/oxserve.js";

import { drawBox, drawCone, positionCone } from "./src/utils.js";

import {
    DNAMonomer, RNAMonomer, AminoAcidMonomer,
    Strand, System
} from "./src/system.js";

// Reused scratch objects for controller picking and cone updates
const _ray = new THREE.Ray();
const _hit = {};
const _rotation = new THREE.Matrix4();
const _beadPos = new THREE.Vector3();

// Find the bead the controller is pointing at
function pickFromController(controller) {
    _rotation.identity().extractRotation(controller.matrixWorld);
    _ray.origin.setFromMatrixPosition(controller.matrixWorld);
    _ray.direction.set(0, 0, -1).applyMatrix4(_rotation);
    return system.pick(_ray, _hit);
}

function onSelectStart(event) {

    // Do not select things if there is no system
    if (system === undefined) {
        return;
    }

    const controller = event.target;
    const hit = pickFromController(controller);

    if (hit === undefined) {
        // Pointing at nothing releases this controller's pull
        if (forces.has(controller)) {
            controller.userData.cone.visible = false;
            forces.delete(controller);
        }
    } else {
        controller.userData.selected = hit.index;

        console.log("Selected particle " + hit.index);

        // Get controller position
        const target = controller.position.clone();

        // Show the "tractor beam" cone
        const cone = controller.userData.cone;
        cone.visible = true;
        positionCone(cone, target, hit.point);

        // Convert to oxDNA coordinates
        let oxDNATarget = system.instancedMesh.worldToLocal(target.clone());

        console.log(`Pull particle ${hit.index} toward ${oxDNATarget.toArray()}`);

        forces.set(controller, {
            target: target,
            oxDNATarget: oxDNATarget,
            nucId: hit.index
        });
    }

    sendForces();
}

// Send the current pulls to oxDNA as trap forces
function sendForces() {
    let forceStr = [...forces.values()].map(f =>
        `
        {
        type = trap
        particle = ${f.nucId}
        pos0 = ${f.oxDNATarget.toArray().map(v => v.toFixed(3)).join(", ")}
        stiff = 0.1
        rate = 0.
        dir = 1.,0.,0.
        }
         `
    ).join("\n");
    console.log(forceStr);

    // Send new forces to oxDNA
    ox_socket.update_forces(forceStr);
}

function onSelectEnd(event) {
    const controller = event.target;
    controller.userData.selected = undefined;
}

// Let go of everything, e.g. when the XR session ends (no selectend fires
// then, even if a trigger is held)
function releaseAllPulls() {
    for (const c of [controller1, controller2]) {
        c.userData.cone.visible = false;
        c.userData.selected = undefined;
        setHighlight(c, undefined);
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

let controls, group;

// my oxDNA related mess
let box;
let system;
let ox_socket;

const targetScale = new THREE.Vector3(1/50, 1/50, 1/50);

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

    let hemilight = new THREE.HemisphereLight(0x808080, 0x606060);
    hemilight.intensity = 5;

    const light = new THREE.DirectionalLight(0xffffff);
    light.position.set(0, 6, 0);
    light.intensity = 6;
    light.castShadow = true;
    light.shadow.camera.top = 2;
    light.shadow.camera.bottom = -2;
    light.shadow.camera.right = 2;
    light.shadow.camera.left = -2;
    light.shadow.mapSize.set(2048, 2048);

    let defaultLight = new THREE.Group();
    defaultLight.add(hemilight);
    defaultLight.add(light);
    scene.add(defaultLight);

    class DesignStorage {
        constructor() {
            this.counter = 0;

            this.designs = [
                "flippy.oxview",
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
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType("local");
    container.appendChild(renderer.domElement);

    renderer.xr.addEventListener("sessionstart", ()=>{
        // Set small initial scale (actual oxDNA scale)
        group.scale.multiplyScalar(8.518E-10);
    });

    renderer.xr.addEventListener("sessionend", ()=>{
        // Controllers are no longer tracked, so release their pulls and
        // highlights
        if (system !== undefined) {
            releaseAllPulls();
        }
    });

    document.body.appendChild(XRButton.createButton(renderer, {
        optionalFeatures: ["light-estimation"]
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

    const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1)
    ]);

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
        setHighlight(controller, undefined);
        return;
    }

    // Continuous haptic pulse while pointing at the same bead
    if (hit.index === controller.userData.highlighted) {
        pulse(controller);
    }

    setHighlight(controller, hit.index);
    line.scale.z = hit.distance;
}

// Point each pull cone from its target to the pulled bead
function updateCones() {
    for (const [controller, f] of forces) {
        system.getDisplayedPosition(f.nucId, _beadPos);
        system.instancedMesh.localToWorld(_beadPos);
        positionCone(controller.userData.cone, f.target, _beadPos);
    }
}

function render() {
    if (system !== undefined && system.instancedMesh !== undefined) {
        system.updateView(performance.now());
        if (forces.size > 0) {
            updateCones();
        }

        // Controllers only exist in an XR session
        if (renderer.xr.isPresenting) {
            updateHover(controller1);
            updateHover(controller2);
        }
    }

    group.scale.lerp(targetScale, 0.01);

    renderer.render(scene, camera);
}

init();
