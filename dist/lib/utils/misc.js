"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSpans = exports.closest = exports.similarity = exports.waitEnd = exports.waitFinish = exports.loadJson = exports.cleanName = exports.removeEndPunctuation = exports.removeAccent = exports.snakeCase = void 0;
const en_stemmer_1 = __importDefault(require("en-stemmer"));
const fs_1 = __importDefault(require("fs"));
const JSONStream_1 = __importDefault(require("JSONStream"));
const stopword_1 = require("stopword");
function snakeCase(v) {
    return v.trim().replace(/[() _-]+/g, '_').toLowerCase();
}
exports.snakeCase = snakeCase;
function removeAccent(v) {
    return v.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
exports.removeAccent = removeAccent;
function removeEndPunctuation(v) {
    return v.replace(/[.!?]$/g, '');
}
exports.removeEndPunctuation = removeEndPunctuation;
function cleanName(v) {
    // replace '(s)' to simply 's'
    v = v.replace(/\(s\)/g, 's');
    v = snakeCase(v);
    // replace u.s. to us
    v = v.replace(/u\.s\./g, 'us');
    // remove accents
    v = removeAccent(v);
    // replace any special tokens to underscore
    v = v.replace(/[^1-9a-zA-Z]/g, '_').replace(/__/g, '_');
    return v;
}
exports.cleanName = cleanName;
async function loadJson(file) {
    const data = {};
    const pipeline = fs_1.default.createReadStream(file).pipe(JSONStream_1.default.parse('$*'));
    pipeline.on('data', (item) => {
        data[item.key] = item.value;
    });
    pipeline.on('error', (error) => console.error(error));
    await waitEnd(pipeline);
    return data;
}
exports.loadJson = loadJson;
function waitFinish(stream) {
    return new Promise((resolve, reject) => {
        stream.once('finish', resolve);
        stream.on('error', reject);
    });
}
exports.waitFinish = waitFinish;
function waitEnd(stream) {
    return new Promise((resolve, reject) => {
        stream.once('end', resolve);
        stream.on('error', reject);
    });
}
exports.waitEnd = waitEnd;
// similarity by word-level similarity
function similarity(s1, s2, algorithm = 'f1') {
    function clean(s) {
        return (0, en_stemmer_1.default)(removeAccent(s));
    }
    const arr1 = (0, stopword_1.removeStopwords)(s1.toLowerCase().split(' ')).map(clean);
    const arr2 = (0, stopword_1.removeStopwords)(s2.toLowerCase().split(' ')).map(clean);
    if (arr1.length === 0 || arr2.length === 0)
        return 0;
    const intersect = arr1.filter((v) => arr2.includes(v));
    if (algorithm === 'jaccard') {
        const union = [...new Set([...arr1, ...arr2])];
        return intersect.length / union.length;
    }
    else {
        const precision = intersect.length / arr1.length;
        const recall = intersect.length / arr2.length;
        if (precision === 0 || recall === 0)
            return 0;
        return 2 * precision * recall / (precision + recall);
    }
}
exports.similarity = similarity;
// return most similar one by word-level similarity
function closest(s, arr, algorithm = 'f1', discard_threshold = 0) {
    let closest = null;
    let maxSimilarity = -1;
    for (const candidate of arr) {
        const score = similarity(s, candidate, algorithm);
        if (score <= discard_threshold)
            continue;
        if (score > maxSimilarity) {
            maxSimilarity = score;
            closest = candidate;
        }
    }
    return closest;
}
exports.closest = closest;
// return all possible spans of a sentence
function getSpans(s) {
    const spans = [];
    const tokens = removeEndPunctuation(s).split(/\s+/);
    for (let len = 1; len <= tokens.length; len++) {
        for (let index = 0; index <= tokens.length - len; index++)
            spans.push(tokens.slice(index, index + len).join(' '));
    }
    return spans;
}
exports.getSpans = getSpans;
//# sourceMappingURL=misc.js.map