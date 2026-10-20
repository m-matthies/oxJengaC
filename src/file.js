// Super-crude transform of oxview json -> top
// Lines (and neighbour references) use the element indices from
// system.assignIndices(), never the oxView ids
function makeTopFile(system) {
    const strandNumbers = new Map(system.strands.map((s, i) => [s, i + 1]));
    let lines = [];
    // Header
    lines.push(`${system.getSize()} ${system.strands.length}`);
    // Add the nucleotides
    system.monomersByIndex.forEach(m => {
        lines.push([
            strandNumbers.get(m.strand),
            m.type,
            m.n3 === undefined ? -1 : m.n3.index,
            m.n5 === undefined ? -1 : m.n5.index
        ].join(" "));
    });
    // spit out the text
    return lines.join("\n");
}

// fast transform of oxview json -> dat
function makeDatFile (system) {
    // header
    let lines = [
        "t = 0",
        `b = ${system.box.x} ${system.box.y} ${system.box.z}`,
        "E = 0 0 0"
    ];
    // same 3->5 order as the topology
    system.monomersByIndex.forEach(base => {
        lines.push([...[
            base.position, base.a1, base.a3
        ].flatMap(v=>v.toArray()), 0, 0, 0, 0, 0, 0].join(" "));
    });
    return lines.join("\n");
}

// got a dat -> set it as the target to interpolate towards
// (line order is 3'->5', matching the element ids)
// Show a configuration. Returns false if it is not a complete configuration
// of this system (nothing is changed then).
function updateStrandsFromDat(dat_txt, system) {
    if (system === undefined || system.targets === undefined) {
        return false;
    }
    return system.setTargetsFromDat(dat_txt);
}

// register drop behavior with a handler function consuming a file list
function makeFileDropable(element, handle) {
    // cancel out default behavior 
    element.addEventListener("dragover", (event) => {
        event.preventDefault();
        element.classList.add("dragging");
    }, false);
    element.addEventListener("dragenter", (event) => {
        event.preventDefault();
        element.classList.add("dragging");
    }, false);
    element.addEventListener("dragexit", (event) => {
        event.preventDefault();
        element.classList.remove("dragging");
    }, false);
    // register the actual drop
    element.addEventListener("drop", (event) => {
        event.preventDefault();
        element.classList.remove("dragging");
        const files = event.dataTransfer.files;
        handle(files);
    }, false);
}

export {makeTopFile, makeDatFile, updateStrandsFromDat, makeFileDropable};