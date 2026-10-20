import * as THREE from "three";

// Default colors for the strands
const strandColors = [
    new THREE.Color(0xfdd291), //light yellow
    new THREE.Color(0xffb322), //goldenrod
    new THREE.Color(0x437092), //dark blue
    new THREE.Color(0x6ea4cc), //light blue
];

const monomerGeometry = new THREE.SphereGeometry(0.75, 8, 6);
// Matte and non-metallic, so the colours come from diffuse light with only
// faint highlights
const monomerMaterial = new THREE.MeshStandardMaterial({
    roughness: 0.85,
    metalness: 0.0
});

export {strandColors, monomerGeometry, monomerMaterial};
