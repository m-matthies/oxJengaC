// Fast oxDNA configuration (dat) parsing, shared by the main thread
// (System.setTargetsFromDat) and the background worker (datWorker.js)

// Number of header lines in an oxDNA configuration file
const DAT_HEADER_LINES = 3;

// Reused scratch objects, so that no allocations happen per frame
const _datValues = new Float64Array(9);
const _parsePos = new Int32Array(1);
// Powers of ten that are exactly representable as doubles
const POW10 = Array.from({length: 23}, (_, i) => Math.pow(10, i));

// Parse a decimal number (optionally with exponent) starting at pos[0]
// without allocating substrings. Advances pos[0] past the number.
function parseNumber(str, pos, end) {
    let p = pos[0];
    let c = str.charCodeAt(p);
    // Skip whitespace
    while (p < end && (c === 32 || c === 9)) c = str.charCodeAt(++p);

    let sign = 1;
    if (c === 45 /* - */) { sign = -1; c = str.charCodeAt(++p); }
    else if (c === 43 /* + */) { c = str.charCodeAt(++p); }

    let mantissa = 0, decimals = 0, digits = 0;
    while (c >= 48 && c <= 57) {
        mantissa = mantissa * 10 + (c - 48);
        digits++;
        c = str.charCodeAt(++p);
    }
    if (c === 46 /* . */) {
        c = str.charCodeAt(++p);
        while (c >= 48 && c <= 57) {
            mantissa = mantissa * 10 + (c - 48);
            decimals++;
            digits++;
            c = str.charCodeAt(++p);
        }
    }
    let exponent = 0;
    if (c === 101 || c === 69 /* e E */) {
        c = str.charCodeAt(++p);
        let expSign = 1;
        if (c === 45) { expSign = -1; c = str.charCodeAt(++p); }
        else if (c === 43) { c = str.charCodeAt(++p); }
        while (c >= 48 && c <= 57) {
            exponent = exponent * 10 + (c - 48);
            c = str.charCodeAt(++p);
        }
        exponent *= expSign;
    }
    pos[0] = p;

    if (digits === 0) {
        return NaN;
    }
    exponent -= decimals;
    // Table lookup is much faster than Math.pow, which dominated parsing
    if (exponent < 0) {
        return sign * mantissa / (
            -exponent < POW10.length ? POW10[-exponent] : Math.pow(10, -exponent)
        );
    }
    return sign * mantissa * (
        exponent < POW10.length ? POW10[exponent] : Math.pow(10, exponent)
    );
}

// Parse an oxDNA configuration into backbone positions. Line k after the
// header is element index k, `offsets` holds its backbone offsets along
// a1 and a2 (2 per element) and the result is written to `targets`
// (3 per element). Returns the number of elements read.
function parseDatTargets(datText, offsets, targets) {
    const len = datText.length;
    const count = targets.length / 3;
    const v = _datValues;

    // Skip the header
    let start = 0;
    for (let l = 0; l < DAT_HEADER_LINES && start !== -1; l++) {
        start = datText.indexOf("\n", start);
        if (start !== -1) start++;
    }
    if (start === -1) {
        return 0;
    }

    let i = 0;
    while (start < len && i < count) {
        let end = datText.indexOf("\n", start);
        if (end === -1) end = len;
        if (end > start) {
            // Read position, a1 and a3 (the first 9 values)
            _parsePos[0] = start;
            for (let k = 0; k < 9; k++) {
                v[k] = parseNumber(datText, _parsePos, end);
            }
            // a2 = a1 x a3
            const a2x = v[4] * v[8] - v[5] * v[7];
            const a2y = v[5] * v[6] - v[3] * v[8];
            const a2z = v[3] * v[7] - v[4] * v[6];
            const o1 = offsets[2 * i], o2 = offsets[2 * i + 1];
            targets[3 * i]     = v[0] - (o1 * v[3] + o2 * a2x);
            targets[3 * i + 1] = v[1] - (o1 * v[4] + o2 * a2y);
            targets[3 * i + 2] = v[2] - (o1 * v[5] + o2 * a2z);
            i++;
        }
        start = end + 1;
    }
    return i;
}

export {parseDatTargets};
